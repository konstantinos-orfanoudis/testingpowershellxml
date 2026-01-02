"use client";

import React, { useEffect, useRef, useState } from "react";
import { buildSchemaFromSoap } from "@/lib/soap/buildSchemaFromSoap";
import { detectUploadKind } from "@/lib/detectUpload";
import { scimToSchema } from "@/lib/scim/scimToConnectorSchema";
import { detectFormat } from "@/lib/detect/detectFormat";
import { openApiToConnectorSchemaFromText } from "@/lib/openapitoconnectorschema/openapiToConnectorSchema";

/* ---------------- Upload types ---------------- */



type FileRole = "spec" | "sample";

type SpecKind = "auto" | "openapi" | "scim" | "soap";

type Item = {
  id: string;
  file: File;
  status: Status;
  statusCode?: number;
  message?: string;
  specKind?: SpecKind;
  role: FileRole;          // NEW
  roleHint?: string;       // NEW (for UX)
  roleError?: string;      // NEW (for UX validation)
};
type Status = "pending" | "uploading" | "done" | "error" | "processing";


function isPdfFile(f: File) {
  return f.type === "application/pdf" || /\.pdf$/i.test(f.name);
}

async function extractPdfViaApi(file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/pdf", { method: "POST", body: form });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const j = await res.json();
  if (!j?.ok) throw new Error(j?.error || "Extraction failed");
  return j.text as string;
}

function isEnt(x: any): x is Entity {
  return x && typeof x.name === "string" && Array.isArray(x.attributes);
}
function isSchema(x: any): x is Schema {
  return x && Array.isArray(x.entities);
}

/* ---------------- Schema model ---------------- */
type AttrType = "String" | "Int" | "Bool" | "Datetime" | "DateTime";

type Attribute = {
  __id?: string;
  name: string;
  type: AttrType;
  MultiValue: boolean;
  IsKey?: boolean;
  AutoFill?: boolean; // NEW
  Mandatory?: boolean;
};
type Entity = { __id?: string; name: string; attributes: Attribute[] };
type Schema = { name: string; version: string; entities: Entity[] };

const TYPE_OPTIONS: AttrType[] = ["String", "Int", "Bool", "Datetime"];

/* ---------------- Helpers ---------------- */
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
function id30Base62(len = 30): string {
  const out: string[] = [];
  const n = ALPHABET.length;
  const limit = 256 - (256 % n);
  const buf = new Uint8Array(len * 2);
  while (out.length < len) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < len; i++) {
      const v = buf[i];
      if (v < limit) out.push(ALPHABET[v % n]);
    }
  }
  return out.join("");
}
function newId() {
  return id30Base62(16);
}

/** ensure each entity/attribute has a stable __id (not serialized) */
function withStableIds(s: Schema): Schema {
  const clone: Schema = {
    name: s.name,
    version: s.version,
    entities: (s.entities || []).map((e) => ({
      __id: e.__id || newId(),
      name: e.name ?? "", // allow empty
      attributes: (e.attributes || []).map((a) => {
        // normalize key flag from possible variants
        const hasIsKey = Object.prototype.hasOwnProperty.call(a as any, "IsKey");
        const hasisKey = Object.prototype.hasOwnProperty.call(a as any, "isKey");
        const val = hasIsKey ? !!(a as any).IsKey : hasisKey ? !!(a as any).isKey : !!a.IsKey;

        return {
          __id: a.__id || newId(),
          name: a.name ?? "", // allow empty
          type: (a.type as AttrType) || "String",
          MultiValue: !!a.MultiValue,
          IsKey: !!val,
          AutoFill: !!(a as any).AutoFill, // NEW
          Mandatory: !!(a as any).Mandatory, // NEW (supports legacy "mandatory")
        };
      }),
    })),
  };
  return clone;
}

/** Merge an array (or single) schema into one Schema object */
function mergeSchemas(input: unknown): Schema {
  const docs: Schema[] = Array.isArray(input)
    ? (input as unknown[]).filter(isSchema)
    : isSchema(input)
    ? [input]
    : [];

  const base: Schema = {
    name: docs.find((d) => d.name)?.name ?? "Connector",
    version: docs.find((d) => d.version)?.version ?? "1.0.0",
    entities: [],
  };

  const byName = new Map<string, Entity>();

  for (const d of docs) {
    for (const e of d.entities) {
      if (!isEnt(e)) continue;

      let target = byName.get(e.name);
      if (!target) {
        target = { name: e.name, attributes: [...(e.attributes ?? [])] };
        byName.set(e.name, target);
        continue;
      }

      // de-dupe attributes by name
      const have = new Set(target.attributes.map((a) => a.name));
      for (const a of e.attributes ?? []) {
        if (a?.name && !have.has(a.name)) {
          target.attributes.push(a);
          have.add(a.name);
        }
      }
    }
  }

  base.entities = [...byName.values()];
  return base;
}

export default function UploadPage() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // schema json text + parsed
  const [schemaText, setSchemaText] = useState<string>("");
  const [schema, setSchema] = useState<Schema | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [selectedEntity, setSelectedEntity] = useState(0);

  const [baseSchemaText, setBaseSchemaText] = useState<string | null>(null); // snapshot before AI improve
const [aiImproving, setAiImproving] = useState(false);
const [aiUsed, setAiUsed] = useState(false);

function parseAiSchemaResult(result: unknown): any {
  if (result && typeof result === "object") return result;

  if (typeof result !== "string") {
    throw new Error("AI returned empty/invalid result");
  }

  let s = result.trim();

  // Strip ```json fences if present
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();

  // If the AI included extra text, extract the first JSON object/array block
  const block = s.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (block) s = block[1];

  // 1st parse
  let v: any = JSON.parse(s);

  // If it’s still a string, it’s "double encoded" -> parse again
  if (typeof v === "string") {
    let inner = v.trim();
    inner = inner.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
    const innerBlock = inner.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (innerBlock) inner = innerBlock[1];

    try {
      v = JSON.parse(inner);
    } catch {
      // Handle literal \n sequences stored as text (rare but happens)
      v = JSON.parse(inner.replace(/\\n/g, "\n").replace(/\\"/g, '"'));
    }
  }

  if (!v || typeof v !== "object") {
    throw new Error("AI result parsed but is not a JSON object/array");
  }

  return v;
}
function normalizeConnectorSchema(v: any) {
  // Array-of-one (n8n often returns [ {...} ])
  if (Array.isArray(v)) {
    if (v.length === 0) throw new Error("AI returned an empty array.");
    return normalizeConnectorSchema(v[0]);
  }

  // Wrapped shapes
  if (v && typeof v === "object") {
    if (v.result != null) return normalizeConnectorSchema(v.result);
    if (v.data != null) return normalizeConnectorSchema(v.data);
    if (v.schema != null) return normalizeConnectorSchema(v.schema);

    // ✅ If entities is a single object, wrap it into an array
    if (v.entities && !Array.isArray(v.entities)) {
      return { ...v, entities: [v.entities] };
    }

    return v;
  }

  // String -> parse -> normalize
  if (typeof v === "string") {
    let s = v.trim();
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
    const block = s.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (block) s = block[1];
    return normalizeConnectorSchema(JSON.parse(s));
  }

  throw new Error("AI returned an unsupported result type.");
}



  // expand modal
  const [expanded, setExpanded] = useState(false);

  /* ---------- helper to apply schema to both states ---------- */
  function applySchema(obj: unknown) {
  try {
    // normalize common n8n/AI shapes:
    // - [ { ... } ] (array-of-one)
    // - { result: ... } / { data: ... }
    // - entities: { ... } (single entity object) -> entities: [ ... ]
    const normalizedInput = normalizeConnectorSchema(obj);

    if (!normalizedInput || typeof normalizedInput !== "object") {
      throw new Error("Schema is not an object");
    }
    if (!Array.isArray((normalizedInput as any).entities)) {
      throw new Error("Schema missing entities[]");
    }

    const normalized = withStableIds(normalizedInput as Schema);
    setSchema(normalized);

    const replacer = (k: string, v: any) => (k.startsWith("__") ? undefined : v);
    setSchemaText(JSON.stringify(normalized, replacer, 2));

    if (selectedEntity >= normalized.entities.length) setSelectedEntity(0);
    setParseError(null);
  } catch (e: any) {
    setParseError(e?.message ?? "Invalid schema format");
  }
}


  function isXmlLike(file: File): boolean {
  const name = file.name.toLowerCase();
  const ext = name.split(".").pop() ?? "";
  const type = (file.type || "").toLowerCase();
  return ext === "xml" || ext === "wsdl" || ext === "xsd" || type.includes("xml");
}

function validateSpecFile(file: File, specKind: SpecKind): string | null {
  if (specKind === "openapi" || specKind === "scim") {
    return isJsonOrYaml(file) ? null : "OpenAPI/SCIM specs must be JSON or YAML (.json/.yaml/.yml).";
  }
  if (specKind === "soap") {
    return isXmlLike(file) ? null : "SOAP specs must be XML/WSDL/XSD (.xml/.wsdl/.xsd).";
  }
  // auto: allow for now; you’ll validate once you infer the kind
  return null;
}

function isJsonOrYaml(file: File): boolean {
  const name = file.name.toLowerCase();
  const ext = name.split(".").pop() ?? "";
  const type = (file.type || "").toLowerCase();

  const byExt = ext === "json" || ext === "yaml" || ext === "yml";
  const byMime =
    type === "application/json" ||
    type === "text/yaml" ||
    type === "application/yaml" ||
    type === "text/x-yaml";

  return byExt || byMime;
}
  /* ---------- file picking ---------- */
  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    if (!list?.length) return;
    const next: Item[] = Array.from(list).map((f) => ({
  id: `${f.name}-${f.size}-${f.lastModified}-${crypto.randomUUID()}`,
  file: f,
  status: "pending",
  role: "sample",
  specKind: "auto",
}));
    setItems((prev) => {
      const map = new Map(prev.map((p) => [`${p.file.name}-${p.file.size}`, p]));
      next.forEach((n) => map.set(`${n.file.name}-${n.file.size}`, n));
      return Array.from(map.values());
    });
    e.target.value = "";
  }
  function removeOne(id: string) {
    setItems((prev) => prev.filter((p) => p.id !== id));
  }
  function setStatus(id: string, status: Status, message?: string) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, status, message } : it)));
  }

  /* ---------- fixed-delay polling of result route ---------- */
  const POLL_DELAYS_MS = [30000, 15000, 15000, 10000, 15000];
  async function pollResultWithDelays(requestId: string) {
  const pickResult = (j: any) =>
    j?.result ??
    j?.data?.result ??
    j?.item?.result ??
    (Array.isArray(j?.items) ? j.items[0]?.result : undefined) ??
    (Array.isArray(j) ? j[0]?.result : undefined);

  for (let i = 0; i < POLL_DELAYS_MS.length; i++) {
    await new Promise((r) => setTimeout(r, POLL_DELAYS_MS[i]));
    const res = await fetch(`/api/ai/resultFiles?id=${encodeURIComponent(requestId)}`);
    if (!res.ok) return { ok: false as const, error: `${res.status} ${res.statusText}` };

    const j = await res.json().catch(() => null);
    const r = pickResult(j);

    // IMPORTANT: check for null/undefined, not "truthy"
    if (j?.ok && r !== undefined && r !== null) return { ok: true as const, result: r };
  }
  return { ok: false as const, error: "No result within polling window" };
}

  async function readTextHead(f: File, max = 400_000) {
    const blob = f.size > max ? f.slice(0, max) : f;
    return (await blob.text()).trim();
  }

  async function readScimDocs(files: File[]) {
    const schemas: any[] = [];
    const resourceTypes: any[] = [];

    for (const f of files) {
      if (!f.name.toLowerCase().endsWith(".json")) continue;
      try {
        const txt = await readTextHead(f);
        const j = JSON.parse(txt);

        // /Schemas response: { Resources: [ ...schema objects...] }
        if (Array.isArray(j?.Resources) && j.Resources.some((r: any) => r?.attributes)) {
          const schemasPart = j.Resources.filter((r: any) => Array.isArray(r?.attributes));
          const rtPart = j.Resources.filter((r: any) => r?.schema || r?.schemaExtensions);
          schemas.push(...schemasPart);
          resourceTypes.push(...rtPart);
          continue;
        }

        // single Schema doc
        if (j?.attributes && typeof j?.id === "string") {
          schemas.push(j);
          continue;
        }

        // /ResourceTypes response or single ResourceType
        if (Array.isArray(j) && j.some((r: any) => r?.schema || r?.schemaExtensions)) {
          resourceTypes.push(...j);
          continue;
        }
        if (j?.schema || j?.schemaExtensions) {
          resourceTypes.push(j);
          continue;
        }
      } catch {
        // ignore non-JSON files in the batch
      }
    }

    return { schemas, resourceTypes };
  }
function revertAiSuggestion() {
  if (!baseSchemaText) return;
  setSchemaText(baseSchemaText);
  setAiUsed(false);
  try {
    applySchema(JSON.parse(baseSchemaText));
  } catch {
    // leave schemaText restored even if parse fails (shouldn't)
  }
}
function guessFileType(f: File) {
  const n = f.name.toLowerCase();
  if (n.endsWith(".json")) return "application/json";
  if (n.endsWith(".yaml") || n.endsWith(".yml")) return "application/x-yaml";
  if (n.endsWith(".wsdl") || n.endsWith(".xml") || n.endsWith(".xsd")) return "application/xml";
  return f.type || "application/octet-stream";
}
async function improveWithAi() {
  // We improve by sending the SPEC file to n8n, not Schema.json
  const specItems = items.filter((i) => i.role === "spec");
  if (!specItems.length) {
    setParseError("Please set at least one uploaded file to File role = Spec.");
    return;
  }

  // Prefer a file that matches the selected spec kind, otherwise first spec
  const preferred =
    specItems.find((x) => x.specKind === "openapi" && isJsonOrYaml(x.file)) ||
    specItems.find((x) => x.specKind === "soap" && isXmlLike(x.file)) ||
    specItems[0];

  // Validate file vs chosen specKind (if not auto)
  if (preferred.specKind && preferred.specKind !== "auto") {
    const err = validateSpecFile(preferred.file, preferred.specKind);
    if (err) {
      setItems((prev) =>
        prev.map((it) => (it.id === preferred.id ? { ...it, roleError: err, status: "error" } : it))
      );
      return;
    }
  }

  // Snapshot current schema for Revert AI (this should be the library result)
  setBaseSchemaText((prev) => prev ?? schemaText);
  setAiImproving(true);
  setParseError(null);

  try {
    const request_id = id30Base62();

    // Mark the spec file as uploading (UX)
    setItems((prev) =>
      prev.map((it) =>
        it.id === preferred.id ? { ...it, status: "uploading", message: "Sending spec to AI…" } : it
      )
    );

    const form = new FormData();
    form.append("file", preferred.file);
    form.append("request_id", request_id);
    form.append("fileName", preferred.file.name);
    form.append("fileType", guessFileType(preferred.file));

    // ✅ This is the key: tell n8n this is spec->schema extraction
    form.append("intent", "extract_schema_from_spec");
    form.append("source", "spec");
    form.append("specKind", preferred.specKind ?? "auto"); // openapi|soap|auto

    const res = await fetch("/api/ai/submitFile", { method: "POST", body: form });
const data = await res.json().catch(() => null);

if (!res.ok || !data?.ok) {
  throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
}

    setItems((prev) =>
      prev.map((it) =>
        it.id === preferred.id ? { ...it, status: "processing", message: "AI processing…" } : it
      )
    );

    const out = await pollResultWithDelays(request_id);
if (!out.ok) throw new Error(out.error);

const improvedRaw = parseAiSchemaResult(out.result);
const improved = normalizeConnectorSchema(improvedRaw);

if (!Array.isArray(improved.entities)) {
  throw new Error("AI returned JSON but not in Schema.json format (missing entities array).");
}

// Guard: prevent schema-of-schema
if (improved.entities.some((e: any) => e?.name === "Schema")) {
  throw new Error("AI returned schema-of-schema. Check your n8n spec branch prompt.");
}
console.log("AI out.result (raw):", out.result);
console.log("AI improved (normalized):", improved);
applySchema(improved);
setAiUsed(true);

    setItems((prev) =>
      prev.map((it) =>
        it.id === preferred.id ? { ...it, status: "done", message: "AI schema extracted" } : it
      )
    );
  } catch (e: any) {
    setParseError(e?.message ?? "AI extraction failed");
    setItems((prev) =>
      prev.map((it) =>
        it.role === "spec" ? { ...it, status: "error", message: e?.message ?? "AI failed" } : it
      )
    );
  } finally {
    setAiImproving(false);
  }
}


  /* ---------- submit ---------- */
 async function submitAll() {
  if (!items.length) return;
  setSubmitting(true);

  // helper: if detectUploadKind() returns unknown, sniff for OpenAPI
  const looksLikeOpenApi = async (files: File[]) => {
    for (const f of files) {
      if (!isJsonOrYaml(f)) continue;
      try {
        const head = await readTextHead(f, 200_000);
        // quick string sniff for JSON/YAML
        if (head.includes('"openapi"') || head.includes("openapi:")) return true;
        if (head.includes('"swagger"') || head.includes("swagger:")) return true;

        // stronger JSON sniff (only if head is JSON)
        try {
          const j = JSON.parse(head);
          if (typeof j?.openapi === "string") return true;
          if (typeof j?.swagger === "string") return true;
        } catch {
          // ignore
        }
      } catch {
        // ignore
      }
    }
    return false;
  };

  try {
    const specItems = items.filter((i) => i.role === "spec");
    const nonSpecItems = items.filter((i) => i.role !== "spec");

    const sampleItems = items.filter((i) => i.role === "sample");
    let parsedSpec = false;

    let kind: "openapi" | "scim" | "soap" | "unknown" = "unknown";
    let parseItems: Item[] = [];

    // -------------------------
    // 1) Decide what to parse
    // -------------------------
    if (specItems.length > 0) {
      // If user chose explicit spec kind, enforce only one
      const explicitKinds = Array.from(
        new Set(
          specItems
            .map((s) => s.specKind)
            .filter((k): k is "openapi" | "scim" | "soap" => !!k && k !== "auto")
        )
      );

      if (explicitKinds.length > 1) {
        setItems((prev) =>
          prev.map((i) => ({
            ...i,
            status: "error",
            message: "Choose only ONE spec type per submission (OpenAPI OR SCIM OR SOAP).",
          }))
        );
        return;
      }

      if (explicitKinds.length === 1) {
        kind = explicitKinds[0];
      } else {
        // Auto-detect from spec files
        const detected = await detectUploadKind(specItems.map((s) => s.file));
        kind = detected as any;

        // If your detectUploadKind doesn't detect OpenAPI, sniff for it
        if (kind === "unknown") {
          const isOas = await looksLikeOpenApi(specItems.map((s) => s.file));
          if (isOas) kind = "openapi";
        }
      }

      parseItems = specItems;
    } else {
      // No spec tagged: keep legacy behavior
      const detected = await detectUploadKind(items.map((i) => i.file));
      kind = detected as any;
      parseItems = items;
    }

    // If spec exists but still unknown => do NOT fall back to AI (avoid confusion)
    if (specItems.length > 0 && kind === "unknown") {
      setItems((prev) =>
        prev.map((i) =>
          i.role === "spec"
            ? {
                ...i,
                status: "error",
                message: "Could not detect spec type. Please choose OpenAPI / SCIM / SOAP in the dropdown.",
              }
            : i
        )
      );
      return;
    }

    // -------------------------
    // 2) Enforce spec file type rules
    // -------------------------
    if (kind === "openapi" || kind === "scim") {
      const bad = parseItems.find((it) => !isJsonOrYaml(it.file));
      if (bad) {
        setItems((prev) =>
          prev.map((i) =>
            i.id === bad.id
              ? {
                  ...i,
                  status: "error",
                  message: "Spec files for OpenAPI/SCIM must be JSON or YAML (.json/.yaml/.yml).",
                }
              : i
          )
        );
        return;
      }
    }

    if (kind === "soap") {
      const bad = parseItems.find((it) => !isXmlLike(it.file));
      if (bad) {
        setItems((prev) =>
          prev.map((i) =>
            i.id === bad.id
              ? {
                  ...i,
                  status: "error",
                  message: "SOAP specs must be XML/WSDL/XSD (.xml/.wsdl/.xsd).",
                }
              : i
          )
        );
        return;
      }
    }

    // -------------------------
    // 3) Parse: OpenAPI (NO AI)
    // -------------------------
    if (kind === "openapi") {
      const openapiItem = parseItems.find((i) => isJsonOrYaml(i.file)) ?? parseItems[0];

      if (!openapiItem) {
        setItems((prev) => prev.map((i) => ({ ...i, status: "error", message: "No OpenAPI spec file found." })));
        return;
      }

      setStatus(openapiItem.id, "processing", "Parsing OpenAPI…");

      try {
        const specText = await openapiItem.file.text();

        const schemaObj = await openApiToConnectorSchemaFromText(specText, {
          schemaName: "Connector",
          version: "1.0.0",
          keyCandidates: ["id"],
          flatten: true,
        });

        applySchema(schemaObj);

        // Mark spec files done; DO NOT send spec to AI
        setItems((prev) =>
          prev.map((i) => {
            if (i.role !== "spec") return i;

            if (i.id === openapiItem.id) {
              return { ...i, status: "done", message: "OpenAPI parsed", roleError: undefined, roleHint: undefined };
            }
            return { ...i, status: "done", message: i.message ?? "Not used for parsing", roleError: undefined, roleHint: undefined };
          })
        );
        parsedSpec = true;

      // OPTIONAL: baseline snapshot after library extraction
      // (so Improve-with-AI can revert to “pure library result” even if user never edits)
      setBaseSchemaText(JSON.stringify(schemaObj, null, 2));
      setAiUsed(false);
      } catch (e: any) {
        setStatus(openapiItem.id, "error", e?.message ?? "OpenAPI parse failed");
      }

      
          }

    // -------------------------
    // 4) Parse: SCIM (NO AI)
    // -------------------------
    if (kind === "scim") {
      const files = parseItems.map((i) => i.file);
      const { schemas, resourceTypes } = await readScimDocs(files);

      if (!schemas.length && !resourceTypes.length) {
        setItems((prev) =>
          prev.map((i) => ({ ...i, status: "error", message: "No SCIM schemas/resourceTypes found in uploaded files." }))
        );
        return;
      }

      const schemaObj = scimToSchema(resourceTypes, schemas, {
        schemaName: "Connector",
        version: "1.0.0",
        preferUserNameAsKey: true,
      });

      applySchema(schemaObj);

      setItems((prev) =>
        prev.map((i) => {
          if (specItems.length > 0 && i.role !== "spec") return i;
          return { ...i, status: "done", message: "SCIM parsed", roleError: undefined, roleHint: undefined };
        })
      );

      parsedSpec = true;

      // OPTIONAL: baseline snapshot after library extraction
      // (so Improve-with-AI can revert to “pure library result” even if user never edits)
      setBaseSchemaText(JSON.stringify(schemaObj, null, 2));
      setAiUsed(false);
    }

    // -------------------------
    // 5) Parse: SOAP (NO AI)
    // -------------------------
    if (kind === "soap") {
      const texts = await Promise.all(parseItems.map((i) => i.file.text()));
      const schemaObj = buildSchemaFromSoap(texts, { scope: "union" });
      applySchema(schemaObj);

      setItems((prev) =>
        prev.map((i) => {
          if (specItems.length > 0 && i.role !== "spec") return i;
          return { ...i, status: "done", message: "SOAP parsed", roleError: undefined, roleHint: undefined };
        })
      );

      parsedSpec = true;

      // OPTIONAL: baseline snapshot after library extraction
      // (so Improve-with-AI can revert to “pure library result” even if user never edits)
      setBaseSchemaText(JSON.stringify(schemaObj, null, 2));
      setAiUsed(false);
    }

    // -------------------------
    // 6) Fallback: AI pipeline (ONLY non-spec)
    // -------------------------
    const aiItems = sampleItems;

if (!aiItems.length) {
  // If we successfully parsed a spec, that's ok — no need to error.
  if (parsedSpec) return;

  setItems((prev) =>
    prev.map((i) => ({
      ...i,
      status: "error",
      message: "No sample files to send to AI.",
    }))
  );
  return;
}

    const request_id = id30Base62();

    await Promise.all(
      aiItems.map(async (it) => {
        setStatus(it.id, "uploading");

        const form = new FormData();
        form.append("file", it.file);
        form.append("request_id", request_id);
        form.append("filename", it.file.name);
        form.append("fileType", guessFileType(it.file));
        form.append("size", String(it.file.size));
        form.append("intent", "infer_from_samples");
        form.append("source", "samples");
        try {
          const res = await fetch("/api/ai/submitFile", { method: "POST", body: form });
const data = await res.json().catch(() => null);

if (!res.ok || !data?.ok) {
  throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
}
          setStatus(it.id, "processing", "Queued");
        } catch {
          setStatus(it.id, "error", "Network error");
        }
      })
    );

    const out = await pollResultWithDelays(request_id);
    if (out.ok) {
      const text = typeof out.result === "string" ? out.result : JSON.stringify(out.result, null, 2);
      const docs = JSON.parse(text);

      const merged = withStableIds(mergeSchemas(docs));
      applySchema(merged);

      setItems((prev) =>
        prev.map((i) => {
          if (specItems.length > 0 && i.role === "spec") {
            // spec was intentionally not sent
            return { ...i, status: "done", message: i.message ?? "Spec not sent to AI" };
          }
          // AI items
          return { ...i, status: "done", message: "Completed" };
        })
      );
    } else {
      setSchemaText(out.error);
      setItems((prev) => prev.map((i) => ({ ...i, status: "error", message: out.error })));
    }
  } finally {
    setSubmitting(false);
  }
}



  function downloadSchemaFile(text: string, filename = "schema.json") {
    const blob = new Blob([text ?? ""], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  const onDownloadSchema = () => {
    const raw = (schemaText || "").trim();
    if (!raw) return;

    try {
      const pretty = JSON.stringify(JSON.parse(raw), null, 2);
      downloadSchemaFile(pretty);
    } catch {
      const ok = confirm("The content isn’t valid JSON. Download it as-is?");
      if (ok) downloadSchemaFile(raw);
    }
  };

  /* ---------- schema editing actions ---------- */
  function updateEntityName(idx: number, name: string) {
    const current = schema ?? { name: "Connector", version: "1.0.0", entities: [] };
    if (!current.entities[idx]) return;
    const s = structuredClone(current);
    s.entities[idx].name = name; // allow empty
    setSchema(withStableIds(s));
  }
  function addAttribute(idx: number) {
    const current = schema ?? { name: "Connector", version: "1.0.0", entities: [] };
    if (!current.entities[idx]) return;
    const s = structuredClone(current);
    s.entities[idx].attributes.push({
      __id: newId(),
      name: "new_field",
      type: "String",
      MultiValue: false,
      IsKey: false,
      AutoFill: false, // NEW
      Mandatory: false, // NEW
    });
    setSchema(withStableIds(s));
  }

  function uniqueEntityName(base: string, existing: string[]) {
    if (!existing.includes(base)) return base;
    let i = 2;
    while (existing.includes(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  }

  function addEntity() {
    const empty: Schema = { name: "Connector", version: "1.0.0", entities: [] };
    const s = structuredClone(schema ?? empty);
    const existingNames = s.entities.map((e) => e.name);
    const name = uniqueEntityName("Entity", existingNames);
    s.entities.push({
      __id: newId(),
      name,
      attributes: [
        // default attribute is NOT a key anymore
        { __id: newId(), name: "id", type: "String", MultiValue: false, IsKey: false, AutoFill: false, Mandatory: false }, // NEW
      ],
    });
    setSchema(withStableIds(s));
    setSelectedEntity(s.entities.length - 1);
  }

  function removeEntity(idx: number) {
    const current = schema ?? { name: "Connector", version: "1.0.0", entities: [] };
    if (idx < 0 || idx >= current.entities.length) return;

    const s = structuredClone(current);
    s.entities.splice(idx, 1);

    setSchema(withStableIds(s));
    if (s.entities.length === 0) {
      setSelectedEntity(0);
    } else {
      const nextIdx = Math.max(0, Math.min(idx, s.entities.length - 1));
      setSelectedEntity(nextIdx);
    }
  }

  function removeAttribute(ei: number, ai: number) {
    const current = schema ?? { name: "Connector", version: "1.0.0", entities: [] };
    if (!current.entities[ei]?.attributes[ai]) return;
    const s = structuredClone(current);
    s.entities[ei].attributes.splice(ai, 1);
    setSchema(withStableIds(s));
  }
  function updateAttrName(ei: number, ai: number, name: string) {
    const current = schema ?? { name: "Connector", version: "1.0.0", entities: [] };
    if (!current.entities[ei]?.attributes[ai]) return;
    const s = structuredClone(current);
    s.entities[ei].attributes[ai].name = name; // allow empty
    setSchema(withStableIds(s));
  }
  function updateAttrType(ei: number, ai: number, type: AttrType) {
    const current = schema ?? { name: "Connector", version: "1.0.0", entities: [] };
    if (!current.entities[ei]?.attributes[ai]) return;
    const s = structuredClone(current);
    s.entities[ei].attributes[ai].type = type;
    setSchema(withStableIds(s));
  }
  function updateAttrMV(ei: number, ai: number, mv: boolean) {
    const current = schema ?? { name: "Connector", version: "1.0.0", entities: [] };
    if (!current.entities[ei]?.attributes[ai]) return;
    const s = structuredClone(current);
    s.entities[ei].attributes[ai].MultiValue = mv;
    setSchema(withStableIds(s));
  }

  function updateAttrMandatory(ei: number, ai: number, val: boolean) {
  const current = schema ?? { name: "Connector", version: "1.0.0", entities: [] };
  if (!current.entities[ei]?.attributes[ai]) return;
  const s = structuredClone(current);
  s.entities[ei].attributes[ai].Mandatory = val;
  setSchema(withStableIds(s));
}

  function toggleKey(ei: number, ai: number, makeKey: boolean) {
    const current = schema ?? { name: "Connector", version: "1.0.0", entities: [] };
    if (!current.entities[ei]?.attributes[ai]) return;
    const s = structuredClone(current);
    s.entities[ei].attributes.forEach((attr, idx) => {
      attr.IsKey = makeKey && idx === ai; // only the clicked one can be true; unchecking clears all
    });
    setSchema(withStableIds(s));
  }
  function updateAttrAutoFill(ei: number, ai: number, val: boolean) {
    const current = schema ?? { name: "Connector", version: "1.0.0", entities: [] };
    if (!current.entities[ei]?.attributes[ai]) return;
    const s = structuredClone(current);
    s.entities[ei].attributes[ai].AutoFill = val;
    setSchema(withStableIds(s));
  }

  function newBlankSchema() {
    const empty: Schema = { name: "Connector", version: "1.0.0", entities: [] };
    setSchema(withStableIds(empty));
    setSelectedEntity(0);
    setParseError(null);
  }

  /* ---------- ONE-WAY SYNC: schema -> schemaText ---------- */
  useEffect(() => {
    if (!schema) return;
    const replacer = (k: string, v: any) => (k.startsWith("__") ? undefined : v);
    setSchemaText(JSON.stringify(schema, replacer, 2));
  }, [schema]);

  /* ---------- Textarea change handler: schemaText -> schema (parse) ---------- */
  function onSchemaTextChange(val: string) {
    setSchemaText(val);
    if (!val.trim()) {
      setSchema(null);
      setParseError(null);
      return;
    }
    try {
      const parsed = JSON.parse(val) as Schema;
      if (!parsed || !Array.isArray(parsed.entities)) throw new Error("Missing entities[]");
      const normalized = withStableIds(parsed);
      setSchema(normalized);
      setParseError(null);
      if (selectedEntity >= normalized.entities.length) setSelectedEntity(0);
    } catch (e: any) {
      setParseError(e?.message || "Invalid JSON");
    }
  }

  // Safe schema for displaying the editor even when schema === null
  const safeSchema: Schema = schema ?? { name: "Connector", version: "1.0.0", entities: [] };
  const hasEntities = safeSchema.entities.length > 0;
  const currentEntity = hasEntities ? safeSchema.entities[selectedEntity] : null;

  /* ---------------- UI ---------------- */
  return (
    <main className="min-h-screen bg-slate-50 py-10">
      {/* Upload header */}
      <div className="mx-auto max-w-6xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">Upload &amp; Submit</h1>
        <p className="mt-1 text-sm text-slate-600">
          You can <b>build a schema from scratch</b> below or upload files and let us parse them.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-black"
          >
            Choose files
          </button>
          <input ref={inputRef} type="file" multiple className="hidden" onChange={onPick} />
          <button
            type="button"
            disabled={submitting || items.length === 0}
            onClick={submitAll}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {submitting ? "Submitting…" : `Submit ${items.length || ""}`}
          </button>
          <button
            type="button"
            disabled={submitting || items.length === 0}
            onClick={() => setItems([])}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            Clear
          </button>
          <a
  href="/"
  className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50"
>
  Home
</a>
          <button
            onClick={() => {
              window.location.href = "/.auth/logout?post_logout_redirect_uri=/";
            }}
            className="inline-flex items-center justify-center rounded-md bg-red-600 px-4 py-2 text-white
             hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
          >
            Sign out
          </button>
        </div>

        {items.length > 0 && (
          <div className="mt-5 rounded-lg border border-slate-200">
            <div className="border-b px-3 py-2 text-sm font-medium text-slate-900">Files ({items.length})</div>
            <ul className="divide-y">
              {items.map((it) => (
                <li key={it.id} className="flex items-center justify-between px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-xs text-slate-800">{it.file.name}</div>
                    <div className="text-[11px] text-slate-500">
                      {(it.file.size / 1024).toFixed(1)} KB · {it.file.type || "unknown type"}
                    </div>
                    {it.message && (
                      <div className="mt-1 text-[11px] text-slate-600 truncate max-w-[520px]">{it.message}</div>
                    )}
                    {it.roleHint && <div className="mt-1 text-[11px] text-slate-500">{it.roleHint}</div>}
                    {it.roleError && <div className="mt-1 text-[11px] text-rose-700">{it.roleError}</div>}

                  </div>
                  <div className="flex items-end gap-3">
  {/* Status pill aligned to bottom */}
  <span
    className={
      "mb-1 rounded-full px-2 py-0.5 text-xs " +
      (it.status === "pending"
        ? "bg-slate-100 text-slate-800"
        : it.status === "uploading"
        ? "bg-amber-100 text-amber-900"
        : it.status === "processing"
        ? "bg-blue-100 text-blue-900"
        : it.status === "done"
        ? "bg-emerald-100 text-emerald-900"
        : "bg-rose-100 text-rose-900")
    }
  >
    {it.status}
  </span>

  {/* Role dropdown (Spec / Samples only) */}
  <div className="flex flex-col gap-1">
    <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide text-left pr-20">
            File role
</div>


    <select
      className="h-8 w-[120px] rounded-md border border-slate-300 bg-white px-2 text-xs"
      value={it.role}
      disabled={submitting}
      onChange={(e) => {
        const role = e.target.value as FileRole;

        setItems((prev) =>
          prev.map((x) => {
            if (x.id !== it.id) return x;

            if (role === "spec") {
              // keep specKind; default to auto if missing
              return {
                ...x,
                role,
                specKind: x.specKind ?? "auto",
                roleError: undefined,
                roleHint: undefined,
              };
            }

            // role === "sample"
            return {
              ...x,
              role,
              specKind: "auto",
              roleError: undefined,
              roleHint: undefined,
            };
          })
        );
      }}
    >
      <option value="sample">Samples</option>
      <option value="spec">Spec</option>
    </select>
  </div>

  {/* Spec type dropdown (only when Spec selected) */}
  {it.role === "spec" && (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">
        Spec type
      </div>

      <select
        className="h-8 w-[160px] rounded-md border border-slate-300 bg-white px-2 text-xs"
        value={it.specKind ?? "auto"}
        disabled={submitting}
        onChange={(e) => {
          const specKind = e.target.value as SpecKind;

          setItems((prev) =>
            prev.map((x) => {
              if (x.id !== it.id) return x;
              const err = specKind !== "auto" ? validateSpecFile(x.file, specKind) : null;
              return {
                ...x,
                specKind,
                roleError: err ?? undefined,
                roleHint:
                  specKind === "openapi" || specKind === "scim"
                    ? "Spec must be JSON/YAML."
                    : specKind === "soap"
                    ? "Spec must be XML/WSDL/XSD."
                    : undefined,
              };
            })
          );
        }}
      >
        <option value="auto">Auto-detect</option>
        <option value="openapi">OpenAPI / Swagger</option>
        <option value="scim">SCIM</option>
        <option value="soap">SOAP</option>
      </select>
    </div>
  )}

  {/* Remove aligned to bottom */}
  <button
    disabled={submitting || it.status === "uploading"}
    onClick={() => removeOne(it.id)}
    className="mb-1 text-xs text-rose-700 hover:text-rose-900 disabled:opacity-50"
  >
    Remove
  </button>
</div>

                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* === Two-column editor + Schema.json === */}
      <div className="mx-auto max-w-6xl mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* LEFT: Entities & attributes */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-900">Schema Editor</div>
            <div className="flex items-center gap-2">
              <div className="text-xs text-slate-500">Entities: {safeSchema.entities.length}</div>
              <button
                type="button"
                onClick={newBlankSchema}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50"
                title="Start a fresh empty schema"
              >
                New blank schema
              </button>
            </div>
          </div>

          <div className="p-4">
            {/* Controls are ALWAYS visible */}
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs text-slate-600">Entities</div>
              <div className="flex items-center gap-2">
                <button
                  onClick={addEntity}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50"
                >
                  + Add entity
                </button>
                <button
                  onClick={() => removeEntity(selectedEntity)}
                  disabled={!hasEntities}
                  className="rounded-md border border-rose-300 text-rose-700 px-3 py-1.5 text-xs hover:bg-rose-50 disabled:opacity-50"
                  title="Remove current entity"
                >
                  Remove entity
                </button>
              </div>
            </div>

            {/* Entity picker + rename */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
              <div>
                <label className="text-xs text-slate-600">Select entity</label>
                <select
                  className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm disabled:opacity-50"
                  value={hasEntities ? selectedEntity : 0}
                  onChange={(e) => setSelectedEntity(Number(e.target.value))}
                  disabled={!hasEntities}
                >
                  {safeSchema.entities.map((e, i) => (
                    <option key={e.__id || i} value={i}>
                      {e.name?.trim() ? e.name : "(unnamed)"}
                    </option>
                  ))}
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="text-xs text-slate-600">Rename entity</label>
                <input
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50"
                  value={currentEntity?.name ?? ""}
                  onChange={(e) => updateEntityName(selectedEntity, e.target.value)}
                  disabled={!hasEntities}
                />
              </div>
            </div>

            {/* Attributes */}
            <div className="mt-4">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs text-slate-600">
                  Attributes ({currentEntity?.attributes.length ?? 0})
                </div>
                <button
                  onClick={() => addAttribute(selectedEntity)}
                  disabled={!hasEntities}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50 disabled:opacity-50"
                >
                  + Add attribute
                </button>
              </div>

              {!hasEntities ? (
                <div className="text-sm text-slate-500">
                  No entities yet. Click <b>+ Add entity</b> to get started.
                </div>
              ) : (
                <div className="space-y-4">
                  {currentEntity!.attributes.map((a, ai) => (
                    <div key={a.__id || ai} className="grid grid-cols-12 gap-3 items-center">
  {/* Name */}
  <textarea
    rows={1}
    wrap="off"
    className="col-span-5 min-w-0 w-full h-10 resize-none rounded-md border border-slate-300
               px-3 py-2 text-sm whitespace-nowrap overflow-x-auto"
    value={a.name}
    title={a.name} // hover shows full name too
    onChange={(e) => updateAttrName(selectedEntity, ai, e.target.value)}
    onInput={(e) => {
      // optional: keep end visible while typing
      const el = e.currentTarget;
      el.scrollLeft = el.scrollWidth;
    }}
  />

  {/* Type */}
  <select
    className="col-span-2 min-w-0 w-full h-10 rounded-md border border-slate-300 px-2 text-sm"
    value={a.type}
    onChange={(e) => updateAttrType(selectedEntity, ai, e.target.value as AttrType)}
  >
    {TYPE_OPTIONS.map((t) => (
      <option key={t} value={t}>{t}</option>
    ))}
  </select>

  {/* Toggles (2x2) */}
  <div className="col-span-4 grid grid-cols-2 gap-x-10 gap-y-2">
    <label className="flex items-center gap-2 text-xs whitespace-nowrap">
      <input type="checkbox" checked={!!a.Mandatory} onChange={(e) => updateAttrMandatory(selectedEntity, ai, e.target.checked)} />
      <span>Mandatory</span>
    </label>

    <label className="flex items-center gap-2 text-xs whitespace-nowrap">
      <input type="checkbox" checked={!!a.MultiValue} onChange={(e) => updateAttrMV(selectedEntity, ai, e.target.checked)} />
      <span>MultiValue</span>
    </label>

    <label className="flex items-center gap-2 text-xs whitespace-nowrap">
      <input type="checkbox" checked={!!a.AutoFill} onChange={(e) => updateAttrAutoFill(selectedEntity, ai, e.target.checked)} />
      <span>AutoFill</span>
    </label>

    <label className="flex items-center gap-2 text-xs whitespace-nowrap">
      <input type="checkbox" checked={!!a.IsKey} onChange={(e) => toggleKey(selectedEntity, ai, e.target.checked)} />
      <span>Key</span>
    </label>
  </div>

  {/* Remove */}
  <button
    className="col-span-1 justify-self-end self-center text-xs text-rose-700 hover:text-rose-900"
    onClick={() => removeAttribute(selectedEntity, ai)}
    title="Remove attribute"
  >
    ✕
  </button>
</div>



                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT: Schema.json with Expand */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-900">Schema.json</div>
            <div className="flex items-center gap-2">
  <button
    type="button"
    onClick={improveWithAi}
    disabled={aiImproving || !items.some((i) => i.role === "spec")}
    className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50 disabled:opacity-50"
    title="Send the extracted schema to n8n to edit it"
  >
    {aiImproving ? "Editing…" : "Edit with AI"}
  </button>

  <button
    type="button"
    onClick={revertAiSuggestion}
    disabled={!aiUsed || !baseSchemaText || aiImproving}
    className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50 disabled:opacity-50"
    title="Revert back to the schema before AI changes"
  >
    Revert AI
  </button>

  <button
    type="button"
    onClick={() => setExpanded(true)}
    className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50"
    title="Expand"
  >
    Expand
  </button>
</div>

          </div>
          <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
            <button
              onClick={onDownloadSchema}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
              disabled={!schemaText.trim()}
            >
              Download schema.json
            </button>
          </div>
          {parseError && (
            <div className="px-4 py-2 text-xs text-rose-700 border-t border-rose-200 bg-rose-50">
              JSON parse error: {parseError}
            </div>
          )}
          <textarea
            className="w-full h=[520px] h-[520px] font-mono text-xs leading-5 p-3 outline-none"
            value={schemaText}
            onChange={(e) => onSchemaTextChange(e.target.value)}
            spellCheck={false}
            placeholder="Start building on the left, or paste/edit JSON here…"
          />
          
        </div>
      </div>

      {/* Expand modal */}
      {expanded && (
        <div className="fixed inset-0 z-50 bg-black/60 grid place-items-center">
          <div className="w-[92vw] h-[86vh] rounded-xl overflow-hidden border border-slate-300 bg-white shadow-2xl">
            <div className="px-4 py-3 border-b flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-900">Schema.json (Expanded)</div>
              <div className="flex items-center gap-2">
                 <button
    type="button"
    onClick={improveWithAi}
    disabled={aiImproving || !items.some((i) => i.role === "spec")}
    className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50 disabled:opacity-50"
    title="Send the extracted schema to n8n to improve it"
  >
    {aiImproving ? "Editing…" : "Edit with AI"}
  </button>

  <button
    type="button"
    onClick={revertAiSuggestion}
    disabled={!aiUsed || !baseSchemaText || aiImproving}
    className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50 disabled:opacity-50"
    title="Revert back to the schema before AI changes"
  >
    Revert AI
  </button>
                <button
                  onClick={() => {
                    try {
                      navigator.clipboard.writeText(schemaText);
                    } catch {}
                  }}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50"
                >
                  Copy
                </button>
                <button
                  onClick={() => setExpanded(false)}
                  className="rounded-md bg-slate-900 text-white px-3 py-1.5 text-xs hover:bg-black"
                >
                  Close
                </button>
              </div>
            </div>
            {parseError && (
  <div className="px-4 py-2 text-xs text-rose-700 border-b border-rose-200 bg-rose-50">
    JSON parse error: {parseError}
  </div>
)}
            <textarea
              className="w-full h-[calc(86vh-56px)] font-mono text-sm leading-6 p-3 outline-none"
              value={schemaText}
              onChange={(e) => onSchemaTextChange(e.target.value)}
              spellCheck={false}
            />
          </div>
        </div>
      )}
    </main>
  );
}
