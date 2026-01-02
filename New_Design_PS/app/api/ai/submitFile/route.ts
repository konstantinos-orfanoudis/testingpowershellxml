// app/api/process/route.ts
import { NextRequest, NextResponse } from "next/server";

import dns from "node:dns";

dns.setDefaultResultOrder("ipv4first");
export const runtime = "nodejs"; // ensure Node runtime for larger uploads

const N8N_SUBMIT_FILE_URL = process.env.N8N_SUBMIT_FILE_URL!;
const HDR_NAME = process.env.N8N_AUTH_HEADER_NAME;   // e.g. "X-API-Key"
const HDR_VALUE = process.env.N8N_AUTH_HEADER_VALUE; // e.g. "my-secret"

function bad(msg: string, status = 400) {
  return NextResponse.json({ ok: false, error: msg }, { status });
}

export async function POST(req: NextRequest) {
  if (!N8N_SUBMIT_FILE_URL) return bad("server missing N8N_SUBMIT_URL", 500);

  let inForm: FormData;
  try {
    inForm = await req.formData();
  } catch {
    return bad("request must be multipart/form-data with a 'file' field");
  }

  const fileEntry = inForm.get("file");

if (!fileEntry || typeof fileEntry === "string") {
  return bad("no file provided (expected form field 'file')");
}

// now TS knows: fileEntry is File
const file = fileEntry;

  const request_id = inForm.get("request_id");

  const namingHints = inForm.get("namingHints");
  const intent = inForm.get("intent"); // ✅ NEW
  const source = inForm.get("source"); // ✅ NEW (optional)
  const specKind = inForm.get("specKind"); // NEW
  const fileNameFromForm = inForm.get("fileName");
const fileName =
  (typeof fileNameFromForm === "string" && fileNameFromForm.trim())
    ? fileNameFromForm
    : ((file as any).name || "upload.bin");
  const fileType = inForm.get("fileType");

  const outForm = new FormData();
  outForm.append("file", file, fileName);

  if (typeof request_id === "string" && request_id.trim()) {
    outForm.append("request_id", request_id);
  }
  if (typeof namingHints === "string" && namingHints.trim()) {
    outForm.append("namingHints", namingHints);
  }
  if (typeof intent === "string" && intent.trim()) {
    outForm.append("intent", intent);
  }
  if (typeof source === "string" && source.trim()) {
    outForm.append("source", source);
  }
  if (typeof fileType === "string" && fileType.trim()) {
    outForm.append("fileType", fileType);
  }
  if (typeof fileName === "string" && fileName.trim()) {
    outForm.append("fileName", fileName);
  }
  if (typeof specKind === "string" && specKind.trim()) {
    outForm.append("specKind", specKind);
  }
  const headers: Record<string, string> = {};
  if (HDR_NAME && HDR_VALUE) headers[HDR_NAME] = HDR_VALUE;

  let res: Response;
  try {
    res = await fetch(N8N_SUBMIT_FILE_URL, {
      method: "POST",
      headers,
      body: outForm,
    });
  } catch (e: any) {
  const cause = e?.cause;
  const detail =
    cause && typeof cause === "object"
      ? `${cause?.code ?? ""} ${cause?.message ?? ""}`.trim()
      : String(cause ?? "");

  console.error("n8n submit fetch error:", e, "cause:", cause);

  return bad(
    `n8n submit failed: ${e?.message ?? String(e)}${detail ? ` | cause: ${detail}` : ""}`,
    502
  );
}

  const status = res.status;

// Read raw text first (works for both json and text responses)
const rawText = await res.text().catch(() => "");

// Try parse json if possible
let body: any = null;
try {
  body = rawText ? JSON.parse(rawText) : null;
} catch {
  body = rawText; // keep text if not JSON
}

// If HTTP error, return a helpful snippet
if (!res.ok) {
  const msg =
    typeof body === "string"
      ? body.slice(0, 400)
      : (body?.error ?? JSON.stringify(body).slice(0, 400));

  return NextResponse.json({ ok: false, error: msg, status }, { status });
}

// ---- request id extraction (robust) ----
const pickId = (obj: any): string | undefined => {
  if (!obj || typeof obj !== "object") return undefined;

  return (
    obj.request_id ||
    obj.requestId ||
    obj.id ||
    obj.data?.request_id ||
    obj.data?.requestId ||
    obj.data?.id ||
    obj.result?.request_id ||
    obj.result?.requestId ||
    obj.result?.id
  );
};

let requestId: string | undefined;

if (Array.isArray(body)) {
  // n8n sometimes returns an array of items
  requestId = pickId(body[0]);
} else if (body && typeof body === "object") {
  requestId = pickId(body);
} else if (typeof body === "string") {
  // UUID fallback only if n8n returns plain text UUID
  const m = body.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i
  );
  requestId = m?.[0];
}

if (!requestId) {
  const preview =
    typeof body === "string" ? body.slice(0, 600) : JSON.stringify(body).slice(0, 600);

  return bad(
    `submit returned unexpected payload (missing request id). n8n_response=${preview}`,
    502
  );
}

return NextResponse.json({ ok: true, id: requestId, status }, { status: 200 });

}
