// app/api/ai/result/route.ts
import { NextRequest, NextResponse } from "next/server";
import dns from "node:dns";

dns.setDefaultResultOrder("ipv4first");

const N8N_RESULT_FILES_URL = process.env.N8N_RESULT_FILES_URL!;
const HDR_NAME = process.env.N8N_AUTH_HEADER_NAME;
const HDR_VALUE = process.env.N8N_AUTH_HEADER_VALUE;

function bad(msg: string, status = 400) {
  return NextResponse.json({ ok: false, error: msg }, { status });
}

export const runtime = "nodejs";

function pickResult(body: any): any {
  if (body == null) return undefined;

  // direct fields
  if (body.result != null) return body.result;
  if (body.result_json != null) return body.result_json;
  if (body.schema != null) return body.schema;

  // common wrappers
  if (body.data != null) {
    const d = body.data;
    if (d?.result != null) return d.result;
    if (d?.schema != null) return d.schema;
    if (Array.isArray(d) && d.length) {
      if (d[0]?.result != null) return d[0].result;
      if (d[0]?.schema != null) return d[0].schema;
      return d[0];
    }
    return d;
  }

  if (body.item?.result != null) return body.item.result;
  if (Array.isArray(body.items) && body.items.length) {
    return body.items[0].result ?? body.items[0].schema ?? body.items[0];
  }

  // n8n sometimes returns an array at the top level
  if (Array.isArray(body) && body.length) {
    return body[0]?.result ?? body[0]?.schema ?? body[0];
  }

  // fallback: return the whole body
  return body;
}

export async function GET(req: NextRequest) {
  if (!N8N_RESULT_FILES_URL) return bad("server missing N8N_RESULT_URL", 500);

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return bad("missing ?id=<request_id>");

  const url = new URL(N8N_RESULT_FILES_URL);
  url.searchParams.set("id", id);

  const headers: Record<string, string> = {};
  if (HDR_NAME && HDR_VALUE) headers[HDR_NAME] = HDR_VALUE;

  let res: Response;
  try {
    res = await fetch(url.toString(), { method: "GET", headers });
  } catch (e: any) {
    return bad(`result fetch failed: ${e?.message ?? String(e)}`, 502);
  }

  // not-ready passthrough
  if (res.status === 404 || res.status === 204 || res.status === 202) {
    return NextResponse.json({ ok: false, notReady: true }, { status: 200 });
  }

  const rawText = await res.text().catch(() => "");

  // try parse json even if content-type is wrong
  let body: any = null;
  try {
    body = rawText ? JSON.parse(rawText) : null;
  } catch {
    body = rawText;
  }

  if (!res.ok) {
    const msg =
      typeof body === "string"
        ? body.slice(0, 400)
        : (body?.error ?? JSON.stringify(body).slice(0, 400));
    return NextResponse.json({ ok: false, error: msg }, { status: res.status });
  }

  const result = pickResult(body);

  // If we still couldn't find anything useful, return the parsed body for debugging
  if (result === undefined) {
    return NextResponse.json(
      { ok: false, error: "n8n returned ok but no result field found", bodyPreview: body },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true, result }, { status: 200 });
}
