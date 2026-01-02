"use client";

import React, { JSX, useEffect, useMemo, useRef, useState } from "react";

/**
 * ObjectAssignmentBuilder - single-file page
 *
 * Supports:
 * - Multiple object types (schema editor)
 * - Per-property Required + Unique flags
 * - Objects CRUD per type + CSV import/export
 * - Uniqueness validation for all Unique properties (and display-name property)
 * - Assignments between any chosen LeftType and RightType (dropdowns)
 * - Export assignments + unassigned
 */

type PropertyType = "text" | "number" | "boolean" | "date";

type PropertyDef = {
  id: string;
  key: string;
  type: PropertyType;
  required: boolean;
  unique: boolean;
};

type ObjectTypeDef = {
  id: string;
  label: string;
  titlePropId: string; // display-name property id
  properties: PropertyDef[];
};

type ObjectInstance = {
  id: string;
  typeId: string;
  values: Record<string, unknown>;
  manualMissing?: boolean;
};

type Assignment = {
  id: string;
  leftObjectId: string;
  rightObjectId: string;
};

type AppState = {
  types: ObjectTypeDef[];
  objects: ObjectInstance[];
  assignments: Assignment[];
};

type StepId = "schema" | "objects" | "assign";

type ExportedJson = {
  version: 1;
  exportedAt: string;
  state: AppState;
};

// -------------------- Utilities --------------------

function uid(): string {
  // crypto.randomUUID is widely available in modern browsers; fallback just in case.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `id_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function normalizeUnique(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v).trim().toLowerCase();
  return s;
}

function isEmptyValue(type: PropertyType, v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (type === "boolean") return false; // boolean is always either true/false in our UI
  const s = String(v).trim();
  return s.length === 0;
}

function coerceValue(type: PropertyType, raw: string): unknown {
  const s = raw.trim();
  if (type === "text") return s;
  if (type === "number") {
    if (s === "") return "";
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  }
  if (type === "boolean") {
    const t = s.toLowerCase();
    if (t === "true" || t === "1" || t === "yes" || t === "y") return true;
    if (t === "false" || t === "0" || t === "no" || t === "n") return false;
    return false;
  }
  // date: keep as string (yyyy-mm-dd or any)
  return s;
}

function defaultExportFilename(label: string, suffix: string): string {
  const safe = (label || "objects").trim().replace(/\s+/g, "_").replace(/[^\w\-]/g, "");
  return `${safe}_${suffix}.csv`;
}

function downloadTextFile(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function sanitizeImportedState(raw: unknown): { ok: true; state: AppState; droppedAssignments: number } | { ok: false; message: string } {
  const payload = (raw && typeof raw === "object" && "state" in (raw as any) ? (raw as any).state : raw) as any;
  if (!payload || typeof payload !== "object") return { ok: false, message: "Invalid JSON format." };

  const typesIn = payload.types;
  const objectsIn = payload.objects;
  const assignmentsIn = payload.assignments;
  if (!Array.isArray(typesIn) || typesIn.length === 0) return { ok: false, message: "JSON must include a non-empty 'types' array." };
  if (!Array.isArray(objectsIn)) return { ok: false, message: "JSON must include an 'objects' array." };
  if (!Array.isArray(assignmentsIn)) return { ok: false, message: "JSON must include an 'assignments' array." };

  const validPropTypes = new Set<PropertyType>(["text", "number", "boolean", "date"]);

  const types: ObjectTypeDef[] = [];
  for (const t of typesIn) {
    if (!t || typeof t !== "object") return { ok: false, message: "Each type must be an object." };
    if (typeof t.id !== "string" || !t.id) return { ok: false, message: "Each type must have a string 'id'." };
    if (typeof t.label !== "string") return { ok: false, message: "Each type must have a string 'label'." };
    if (typeof t.titlePropId !== "string" || !t.titlePropId) return { ok: false, message: "Each type must have a string 'titlePropId'." };
    if (!Array.isArray(t.properties) || t.properties.length === 0) return { ok: false, message: `Type '${t.label || t.id}' must have a non-empty 'properties' array.` };

    const props: PropertyDef[] = [];
    const propIds = new Set<string>();
    const propKeys = new Set<string>();
    for (const p of t.properties) {
      if (!p || typeof p !== "object") return { ok: false, message: `Type '${t.label || t.id}': each property must be an object.` };
      if (typeof p.id !== "string" || !p.id) return { ok: false, message: `Type '${t.label || t.id}': each property must have a string 'id'.` };
      if (typeof p.key !== "string" || !p.key.trim()) return { ok: false, message: `Type '${t.label || t.id}': each property must have a non-empty 'key'.` };
      if (typeof p.type !== "string" || !validPropTypes.has(p.type as PropertyType)) {
        return { ok: false, message: `Type '${t.label || t.id}': property '${p.key}' has invalid type.` };
      }

      if (propIds.has(p.id)) return { ok: false, message: `Type '${t.label || t.id}': duplicate property id '${p.id}'.` };
      const keyNorm = p.key.trim().toLowerCase();
      if (propKeys.has(keyNorm)) return { ok: false, message: `Type '${t.label || t.id}': duplicate property key '${p.key}'.` };
      propIds.add(p.id);
      propKeys.add(keyNorm);

      props.push({
        id: p.id,
        key: p.key,
        type: p.type as PropertyType,
        required: Boolean(p.required),
        unique: Boolean(p.unique),
      });
    }

    if (!propIds.has(t.titlePropId)) return { ok: false, message: `Type '${t.label || t.id}': titlePropId does not match any property.` };
    types.push({ id: t.id, label: t.label, titlePropId: t.titlePropId, properties: props });
  }

  const typeIdSet = new Set(types.map((t) => t.id));

  const objects: ObjectInstance[] = [];
  const objectIdSet = new Set<string>();
  for (const o of objectsIn) {
    if (!o || typeof o !== "object") return { ok: false, message: "Each object must be an object." };
    if (typeof o.id !== "string" || !o.id) return { ok: false, message: "Each object must have a string 'id'." };
    if (objectIdSet.has(o.id)) return { ok: false, message: `Duplicate object id '${o.id}'.` };
    if (typeof o.typeId !== "string" || !typeIdSet.has(o.typeId)) return { ok: false, message: `Object '${o.id}' references an unknown typeId.` };
    if (!o.values || typeof o.values !== "object") return { ok: false, message: `Object '${o.id}' must include a 'values' object.` };
    objectIdSet.add(o.id);
    objects.push({
      id: o.id,
      typeId: o.typeId,
      values: o.values as Record<string, unknown>,
      manualMissing: Boolean(o.manualMissing),
    });
  }

  const existingObjectIds = new Set(objects.map((o) => o.id));
  const assignments: Assignment[] = [];
  let dropped = 0;
  const assignmentIds = new Set<string>();
  for (const a of assignmentsIn) {
    if (!a || typeof a !== "object") {
      dropped += 1;
      continue;
    }
    const id = typeof a.id === "string" && a.id ? a.id : uid();
    if (assignmentIds.has(id)) {
      dropped += 1;
      continue;
    }
    if (typeof a.leftObjectId !== "string" || typeof a.rightObjectId !== "string") {
      dropped += 1;
      continue;
    }
    if (!existingObjectIds.has(a.leftObjectId) || !existingObjectIds.has(a.rightObjectId)) {
      dropped += 1;
      continue;
    }
    assignmentIds.add(id);
    assignments.push({ id, leftObjectId: a.leftObjectId, rightObjectId: a.rightObjectId });
  }

  return { ok: true, state: { types, objects, assignments }, droppedAssignments: dropped };
}

/**
 * Delimited parser with quote support.
 * - Supports commas, tabs, semicolons, or any single-character delimiter
 * - Supports quoted fields with escaped quotes ("")
 */
function parseDelimitedFile(content: string, delimiter: string): string[][] {
  const sep = delimiter ?? ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    // avoid pushing a trailing empty line
    if (row.length === 1 && row[0] === "" && rows.length > 0) return;
    rows.push(row);
    row = [];
  };

  while (i < content.length) {
    const ch = content[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = content[i + 1];
        if (next === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (ch === sep) {
      pushField();
      i += 1;
      continue;
    }

    if (ch === "\n") {
      pushField();
      pushRow();
      i += 1;
      continue;
    }

    if (ch === "\r") {
      // handle CRLF
      const next = content[i + 1];
      if (next === "\n") {
        pushField();
        pushRow();
        i += 2;
        continue;
      }
      // lone \r
      pushField();
      pushRow();
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  pushField();
  pushRow();

  return rows;
}

// Back-compat alias (some earlier iterations referenced this name)
function parseDelimitFile(content: string, delimiter: string): string[][] {
  return parseDelimitedFile(content, delimiter);
}

// -------------------- Basic UI components --------------------

function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" }) {
  const { className, variant = "primary", ...rest } = props;
  return <button {...rest} className={cx("oab-btn", `oab-btn-${variant}`, className)} />;
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props;
  return <input {...rest} className={cx("oab-input", className)} />;
}

function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, ...rest } = props;
  return <select {...rest} className={cx("oab-select", className)} />;
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="oab-badge">{children}</span>;
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
}) {
  return (
    <label className="oab-switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="oab-switch-ui" />
      {label ? <span className="oab-switch-label">{label}</span> : null}
    </label>
  );
}

function Modal({
  open,
  title,
  children,
  onClose,
  footer,
  width = 720,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  footer?: React.ReactNode;
  width?: number;
}) {
  if (!open) return null;
  return (
    <div className="oab-modalOverlay" role="dialog" aria-modal="true">
      <div className="oab-modal" style={{ maxWidth: width }}>
        <div className="oab-modalHead">
          <div className="oab-modalTitle">{title}</div>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </div>
        <div className="oab-modalBody">{children}</div>
        {footer ? <div className="oab-modalFoot">{footer}</div> : null}
      </div>
    </div>
  );
}

function Card({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="oab-card">
      <div className="oab-cardHead">
        <div>
          <div className="oab-cardTitle">{title}</div>
          {subtitle ? <div className="oab-muted">{subtitle}</div> : null}
        </div>
        {actions ? <div className="oab-cardActions">{actions}</div> : null}
      </div>
      <div className="oab-cardBody">{children}</div>
    </div>
  );
}

function LabelEl({ children }: { children: React.ReactNode }) {
  return <div className="oab-label">{children}</div>;
}

// -------------------- Schema Editor --------------------

function SchemaEditor({
  types,
  selectedTypeId,
  setSelectedTypeId,
  onAddType,
  onDeleteType,
  updateType,
}: {
  types: ObjectTypeDef[];
  selectedTypeId: string;
  setSelectedTypeId: (id: string) => void;
  onAddType: () => void;
  onDeleteType: (typeId: string) => void;
  updateType: (typeId: string, updater: (prev: ObjectTypeDef) => ObjectTypeDef) => void;
}) {
  const typeDef = types.find((t) => t.id === selectedTypeId) ?? types[0];

  const canDelete = types.length > 1;

  return (
    <div className="oab-stack">
      <div className="oab-row oab-between">
        <div>
          <div className="oab-h2">Define object types and properties</div>
          <div className="oab-muted">Add as many types as you need. Mark properties as Required and/or Unique.</div>
        </div>
        <Button onClick={onAddType}>+ Add type</Button>
      </div>

      <div className="oab-row oab-gap8 oab-wrap">
        {types.map((t) => (
          <button
            key={t.id}
            className={cx("oab-pill", t.id === typeDef.id && "is-active")}
            onClick={() => setSelectedTypeId(t.id)}
            type="button"
          >
            {t.label || "Untitled"}
          </button>
        ))}
      </div>

      <Card
        title={typeDef.label || "Type"}
        subtitle="Define the object type name and its properties."
        actions={
          canDelete ? (
            <Button variant="secondary" onClick={() => onDeleteType(typeDef.id)}>
              Delete type
            </Button>
          ) : null
        }
      >
        <div className="oab-grid2">
          <div>
            <LabelEl>Type name</LabelEl>
            <Input
              value={typeDef.label}
              onChange={(e) =>
                updateType(typeDef.id, (prev) => ({
                  ...prev,
                  label: e.target.value,
                }))
              }
              placeholder="e.g. Country"
            />
          </div>

          <div>
            <LabelEl>Display name property</LabelEl>
            <Select
              value={typeDef.titlePropId}
              onChange={(e) =>
                updateType(typeDef.id, (prev) => ({
                  ...prev,
                  titlePropId: e.target.value,
                }))
              }
            >
              {typeDef.properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.key}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="oab-row oab-between oab-mt14">
          <div>
            <div className="oab-h3">Properties</div>
            <div className="oab-mutedSmall">Set Required and Unique per property.</div>
          </div>
          <Button
            variant="secondary"
            onClick={() =>
              updateType(typeDef.id, (prev) => {
                const id = uid();
                const nextKey = `prop_${prev.properties.length + 1}`;
                const next: PropertyDef = { id, key: nextKey, type: "text", required: false, unique: false };
                const properties = [...prev.properties, next];
                // if no title prop, make first property title
                const titlePropId = prev.titlePropId || properties[0]?.id || id;
                return { ...prev, properties, titlePropId };
              })
            }
          >
            + Add property
          </Button>
        </div>

        <div className="oab-propList">
          {typeDef.properties.map((p) => (
            <div key={p.id} className="oab-propRow">
              <div>
                <LabelEl>Key</LabelEl>
                <Input
                  value={p.key}
                  onChange={(e) => {
                    const nextKey = e.target.value;
                    updateType(typeDef.id, (prev) => ({
                      ...prev,
                      properties: prev.properties.map((x) => (x.id === p.id ? { ...x, key: nextKey } : x)),
                    }));
                  }}
                />
              </div>

              <div>
                <LabelEl>Type</LabelEl>
                <Select
                  value={p.type}
                  onChange={(e) => {
                    const nextType = e.target.value as PropertyType;
                    updateType(typeDef.id, (prev) => ({
                      ...prev,
                      properties: prev.properties.map((x) => (x.id === p.id ? { ...x, type: nextType } : x)),
                    }));
                  }}
                >
                  <option value="text">Text</option>
                  <option value="number">Number</option>
                  <option value="boolean">Boolean</option>
                  <option value="date">Date</option>
                </Select>
              </div>

              <div>
                <LabelEl>Required</LabelEl>
                <div className="oab-inlineBox">
                  <Switch
                    checked={!!p.required}
                    onChange={(checked) =>
                      updateType(typeDef.id, (prev) => ({
                        ...prev,
                        properties: prev.properties.map((x) => (x.id === p.id ? { ...x, required: checked } : x)),
                      }))
                    }
                    label={p.required ? "Yes" : "No"}
                  />
                </div>
              </div>

              <div>
                <LabelEl>Unique</LabelEl>
                <div className="oab-inlineBox">
                  <Switch
                    checked={!!p.unique}
                    onChange={(checked) =>
                      updateType(typeDef.id, (prev) => ({
                        ...prev,
                        properties: prev.properties.map((x) => (x.id === p.id ? { ...x, unique: checked } : x)),
                      }))
                    }
                    label={p.unique ? "Yes" : "No"}
                  />
                </div>
              </div>

              <div className="oab-propRowActions">
                {typeDef.titlePropId === p.id ? <Badge>Display name</Badge> : null}
                <Button
                  variant="ghost"
                  disabled={typeDef.properties.length <= 1}
                  onClick={() => {
                    updateType(typeDef.id, (prev) => {
                      const properties = prev.properties.filter((x) => x.id !== p.id);
                      const titlePropId = prev.titlePropId === p.id ? (properties[0]?.id ?? "") : prev.titlePropId;
                      return { ...prev, properties, titlePropId };
                    });
                  }}
                >
                  🗑 Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// -------------------- Objects Step --------------------

function computeMissing(typeDef: ObjectTypeDef, obj: ObjectInstance): boolean {
  if (obj.manualMissing) return true;
  for (const p of typeDef.properties) {
    if (!p.required) continue;
    if (isEmptyValue(p.type, obj.values[p.id])) return true;
  }
  return false;
}

function validateUniquenessForType(
  typeDef: ObjectTypeDef,
  objectsOfType: ObjectInstance[],
  candidateValues: Record<string, unknown>,
  excludeId?: string
): { ok: boolean; message?: string } {
  const uniqueProps = typeDef.properties.filter((p) => p.unique || p.id === typeDef.titlePropId);

  for (const p of uniqueProps) {
    const cand = normalizeUnique(candidateValues[p.id]);
    if (cand === "") continue; // ignore empty
    const clash = objectsOfType.find((o) => o.id !== excludeId && normalizeUnique(o.values[p.id]) === cand);
    if (clash) {
      return { ok: false, message: `Value for "${p.key}" must be unique.` };
    }
  }

  return { ok: true };
}

function ObjectsStep({
  types,
  selectedTypeId,
  setSelectedTypeId,
  objects,
  setObjects,
  setAssignments,
  updateType,
}: {
  types: ObjectTypeDef[];
  selectedTypeId: string;
  setSelectedTypeId: (id: string) => void;
  objects: ObjectInstance[];
  setObjects: (updater: (prev: ObjectInstance[]) => ObjectInstance[]) => void;
  setAssignments: (updater: (prev: Assignment[]) => Assignment[]) => void;
  updateType: (typeId: string, updater: (prev: ObjectTypeDef) => ObjectTypeDef) => void;
}) {
  const typeDef = types.find((t) => t.id === selectedTypeId) ?? types[0];
  const objectsOfType = useMemo(() => objects.filter((o) => o.typeId === typeDef.id), [objects, typeDef.id]);

  const [onlyMissing, setOnlyMissing] = useState(false);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    for (const p of typeDef.properties) init[p.id] = p.type === "boolean" ? false : "";
    return init;
  });

  useEffect(() => {
    // reset draft when switching type
    const init: Record<string, unknown> = {};
    for (const p of typeDef.properties) init[p.id] = p.type === "boolean" ? false : "";
    setDraft(init);
    setSearch("");
    setOnlyMissing(false);
  }, [typeDef.id]);

  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<string>("");
  const [editDraft, setEditDraft] = useState<Record<string, unknown>>({});

  const [exportOpen, setExportOpen] = useState(false);
  const [exportSep, setExportSep] = useState(",");
  const [exportFilename, setExportFilename] = useState(() => defaultExportFilename(typeDef.label, "export"));

  const [importOpen, setImportOpen] = useState(false);
  const [importSep, setImportSep] = useState(",");
  const [importError, setImportError] = useState<string>("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Selection (bulk operations)
  const [selectedIdsByType, setSelectedIdsByType] = useState<Record<string, string[]>>({});
  const selectedIds = selectedIdsByType[typeDef.id] ?? [];
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allIds = useMemo(() => objectsOfType.map((o) => o.id), [objectsOfType]);
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  const allSelected = allIds.length > 0 && selectedIds.length === allIds.length;
  const noneSelected = selectedIds.length === 0;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = !allSelected && !noneSelected;
    }
  }, [allSelected, noneSelected, typeDef.id]);

  // Clean selection if objects are deleted
  useEffect(() => {
    setSelectedIdsByType((prev) => {
      const cur = prev[typeDef.id] ?? [];
      const allowed = new Set(allIds);
      const next = cur.filter((id) => allowed.has(id));
      if (next.length === cur.length) return prev;
      return { ...prev, [typeDef.id]: next };
    });
  }, [typeDef.id, allIds.join("|")]);

  function setSelectedForCurrent(ids: string[]) {
    setSelectedIdsByType((prev) => ({ ...prev, [typeDef.id]: ids }));
  }

  function toggleSelected(id: string) {
    setSelectedIdsByType((prev) => {
      const cur = new Set(prev[typeDef.id] ?? []);
      if (cur.has(id)) cur.delete(id);
      else cur.add(id);
      return { ...prev, [typeDef.id]: Array.from(cur) };
    });
  }

  function toggleSelectAll(checked: boolean) {
    setSelectedForCurrent(checked ? allIds : []);
  }

  function deleteSelected() {
    const ids = selectedIdsByType[typeDef.id] ?? [];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} object(s) of type "${typeDef.label || "Type"}"?`)) return;
    const idSet = new Set(ids);
    setObjects((prev) => prev.filter((o) => !idSet.has(o.id)));
    setAssignments((prev) => prev.filter((a) => !idSet.has(a.leftObjectId) && !idSet.has(a.rightObjectId)));
    setSelectedForCurrent([]);
  }


  useEffect(() => {
    setExportFilename(defaultExportFilename(typeDef.label, "export"));
  }, [typeDef.label]);

  const displayProp = typeDef.properties.find((p) => p.id === typeDef.titlePropId) ?? typeDef.properties[0];

  const missingRequiredInDraft = useMemo(() => {
    for (const p of typeDef.properties) {
      if (!p.required) continue;
      if (isEmptyValue(p.type, draft[p.id])) return true;
    }
    return false;
  }, [draft, typeDef]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return objectsOfType
      .filter((o) => {
        if (onlyMissing && !computeMissing(typeDef, o)) return false;
        if (!q) return true;
        const name = normalizeUnique(o.values[displayProp.id]);
        return name.includes(q);
      })
      .map((o) => ({ o, missing: computeMissing(typeDef, o) }));
  }, [objectsOfType, onlyMissing, search, typeDef, displayProp.id]);

  function addObjectFromValues(values: Record<string, unknown>) {
    setObjects((prev) => [...prev, { id: uid(), typeId: typeDef.id, values }]);
  }

  function deleteObject(id: string) {
    setObjects((prev) => prev.filter((o) => o.id !== id));
    setAssignments((prev) => prev.filter((a) => a.leftObjectId !== id && a.rightObjectId !== id));
    setSelectedIdsByType((prev) => {
      const cur = prev[typeDef.id] ?? [];
      if (!cur.includes(id)) return prev;
      return { ...prev, [typeDef.id]: cur.filter((x) => x !== id) };
    });
  }

  function updateObject(id: string, values: Record<string, unknown>) {
    setObjects((prev) => prev.map((o) => (o.id === id ? { ...o, values } : o)));
  }

  function toggleMissing(id: string) {
    setObjects((prev) => prev.map((o) => (o.id === id ? { ...o, manualMissing: !o.manualMissing } : o)));
  }

  function onAdd() {
    if (missingRequiredInDraft) return;
    const uniq = validateUniquenessForType(typeDef, objectsOfType, draft);
    if (!uniq.ok) {
      alert(uniq.message);
      return;
    }
    addObjectFromValues(draft);
    // reset
    const init: Record<string, unknown> = {};
    for (const p of typeDef.properties) init[p.id] = p.type === "boolean" ? false : "";
    setDraft(init);
  }

  function openEdit(obj: ObjectInstance) {
    setEditId(obj.id);
    setEditDraft(obj.values);
    setEditOpen(true);
  }

  function saveEdit() {
    const uniq = validateUniquenessForType(typeDef, objectsOfType, editDraft, editId);
    if (!uniq.ok) {
      alert(uniq.message);
      return;
    }
    // required check
    for (const p of typeDef.properties) {
      if (!p.required) continue;
      if (isEmptyValue(p.type, editDraft[p.id])) {
        alert("Fill all required fields.");
        return;
      }
    }
    updateObject(editId, editDraft);
    setEditOpen(false);
  }

  function toCSV(sep: string, rows: string[][]): string {
    const escapeCell = (s: string) => {
      const mustQuote = s.includes('"') || s.includes("\n") || s.includes("\r") || s.includes(sep);
      const v = s.replace(/"/g, '""');
      return mustQuote ? `"${v}"` : v;
    };
    return rows.map((r) => r.map((c) => escapeCell(c ?? "")).join(sep)).join("\n");
  }

  function openExportModal() {
    setExportSep(",");
    setExportFilename(defaultExportFilename(typeDef.label, "export"));
    setExportOpen(true);
  }

  function doExport() {
    const sep = exportSep || ",";
    const header = typeDef.properties.map((p) => p.key);
    const rows: string[][] = [header];

    for (const o of objectsOfType) {
      const row = typeDef.properties.map((p) => {
        const v = o.values[p.id];
        return v === undefined || v === null ? "" : String(v);
      });
      rows.push(row);
    }

    const csv = toCSV(sep, rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFilename || defaultExportFilename(typeDef.label, "export");
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setExportOpen(false);
  }

  async function doImportFromFile() {
    setImportError("");
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setImportError("Choose a CSV file first.");
      return;
    }
    const sep = importSep || ",";
    const text = await file.text();
    const grid = parseDelimitedFile(text, sep);
    if (grid.length < 2) {
      setImportError("CSV must include a header row and at least one data row.");
      return;
    }
    const header = grid[0].map((h) => h.trim());
    const requiredKeys = typeDef.properties.map((p) => p.key);
    const missingCols = requiredKeys.filter((k) => !header.includes(k));
    if (missingCols.length) {
      setImportError(`Header must include all properties. Missing: ${missingCols.join(", ")}`);
      return;
    }

    const keyToProp = new Map(typeDef.properties.map((p) => [p.key, p]));
    const idxByKey = new Map<string, number>();
    header.forEach((h, i) => idxByKey.set(h, i));

    const newObjects: ObjectInstance[] = [];
    const seen = new Map<string, Set<string>>(); // propId -> set(normalized)
    for (const p of typeDef.properties) seen.set(p.id, new Set<string>());

    // seed with existing values for unique props
    const uniqueProps = typeDef.properties.filter((p) => p.unique || p.id === typeDef.titlePropId);
    for (const p of uniqueProps) {
      const set = seen.get(p.id)!;
      for (const o of objectsOfType) {
        const n = normalizeUnique(o.values[p.id]);
        if (n) set.add(n);
      }
    }

    for (let r = 1; r < grid.length; r++) {
      const row = grid[r];
      if (row.every((c) => String(c ?? "").trim() === "")) continue;

      const values: Record<string, unknown> = {};
      for (const key of requiredKeys) {
        const p = keyToProp.get(key)!;
        const idx = idxByKey.get(key)!;
        const raw = row[idx] ?? "";
        values[p.id] = coerceValue(p.type, String(raw));
      }

      // required check
      for (const p of typeDef.properties) {
        if (!p.required) continue;
        if (isEmptyValue(p.type, values[p.id])) {
          setImportError(`Row ${r + 1}: missing required "${p.key}".`);
          return;
        }
      }

      // uniqueness check (existing + within import)
      for (const p of uniqueProps) {
        const n = normalizeUnique(values[p.id]);
        if (!n) continue;
        const set = seen.get(p.id)!;
        if (set.has(n)) {
          setImportError(`Row ${r + 1}: value for "${p.key}" must be unique.`);
          return;
        }
        set.add(n);
      }

      newObjects.push({ id: uid(), typeId: typeDef.id, values });
    }

    if (!newObjects.length) {
      setImportError("No objects found to import.");
      return;
    }

    setObjects((prev) => [...prev, ...newObjects]);
    setImportOpen(false);
  }

  return (
    <div className="oab-stack">
      <div className="oab-row oab-between">
        <div>
          <div className="oab-h2">Create objects</div>
          <div className="oab-muted">Add at least one object for each type.</div>
        </div>

        <div className="oab-row oab-gap8">
          <Button variant="secondary" onClick={() => setImportOpen(true)}>
            Import from CSV
          </Button>
          <Button variant="secondary" onClick={openExportModal}>
            Export {typeDef.label || "Type"}
          </Button>
        </div>
      </div>

      <div className="oab-row oab-gap8 oab-wrap">
        {types.map((t) => (
          <button
            key={t.id}
            className={cx("oab-pill", t.id === typeDef.id && "is-active")}
            onClick={() => setSelectedTypeId(t.id)}
            type="button"
          >
            {t.label || "Untitled"}
          </button>
        ))}
      </div>

      <Card
        title={typeDef.label || "Type"}
        subtitle="Create objects of this type. You can also edit objects here."
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              // quick open schema editor for this type: just set selected type; actual step switch happens in Page
              // handled outside; this keeps Objects step clean
              updateType(typeDef.id, (prev) => prev);
              alert("Edit properties in the 'Types & Properties' tab.");
            }}
          >
            Edit properties
          </Button>
        }
      >
        <div className="oab-newObj">
          <div className="oab-h3">New {typeDef.label || "Object"}</div>
          <div className="oab-grid3">
            {typeDef.properties.map((p) => (
              <div key={p.id}>
                <LabelEl>
                  {p.key} {p.required ? <span className="oab-req">*</span> : null}{" "}
                  {(p.unique || p.id === typeDef.titlePropId) && <span className="oab-mutedSmall">(unique)</span>}
                </LabelEl>

                {p.type === "boolean" ? (
                  <div className="oab-inlineBox">
                    <Switch
                      checked={!!draft[p.id]}
                      onChange={(checked) => setDraft((prev) => ({ ...prev, [p.id]: checked }))}
                      label={draft[p.id] ? "True" : "False"}
                    />
                  </div>
                ) : p.type === "date" ? (
                  <Input
                    type="date"
                    value={String(draft[p.id] ?? "")}
                    onChange={(e) => setDraft((prev) => ({ ...prev, [p.id]: e.target.value }))}
                  />
                ) : (
                  <Input
                    value={String(draft[p.id] ?? "")}
                    onChange={(e) => setDraft((prev) => ({ ...prev, [p.id]: e.target.value }))}
                  />
                )}
              </div>
            ))}
          </div>

          <div className="oab-row oab-between oab-mt10">
            <div className={cx("oab-mutedSmall", missingRequiredInDraft && "oab-warn")}>
              {missingRequiredInDraft ? "Fill all required fields." : "Ready to add."}
            </div>
            <Button onClick={onAdd} disabled={missingRequiredInDraft}>
              + Add
            </Button>
          </div>
        </div>

        <div className="oab-row oab-between oab-mt14">
          <div>
            <div className="oab-h3">Objects</div>
            <div className="oab-mutedSmall">{filtered.length} shown</div>
          </div>
          <div className="oab-row oab-gap10 oab-wrap">
            <Input placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 240 }} />
            <label className="oab-check">
              <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} /> Only missing
            </label>
            <label className="oab-check">
              <input ref={selectAllRef} type="checkbox" checked={allSelected} onChange={(e) => toggleSelectAll(e.target.checked)} /> Select all
            </label>
            <Button variant="secondary" onClick={deleteSelected} disabled={selectedIds.length === 0}>
              Delete selected ({selectedIds.length})
            </Button>
          </div>
        </div>

        <div className="oab-objList">
          {filtered.length === 0 ? (
            <div className="oab-empty">No objects yet.</div>
          ) : (
            filtered.map(({ o, missing }) => {
              const name = String(o.values[displayProp.id] ?? "").trim() || "(unnamed)";
              return (
                <div key={o.id} className={cx("oab-objRow", missing && "is-missing")}>
                  <div className="oab-objRowMain">
                    <label className="oab-check oab-check-tight" aria-label="Select object">
                      <input type="checkbox" checked={selectedSet.has(o.id)} onChange={() => toggleSelected(o.id)} />
                    </label>

                    <div className="oab-objName">{name}</div>

                    {missing ? <Badge>Missing</Badge> : <span className="oab-mutedSmall">OK</span>}
</div>

                  <div className="oab-objRowActions">
                    <label className="oab-check oab-check-tight">
                      <input type="checkbox" checked={!!o.manualMissing} onChange={() => toggleMissing(o.id)} />
                      <span>Missing</span>
                    </label>
                    <Button variant="secondary" onClick={() => openEdit(o)}>
                      Edit
                    </Button>
                    <Button variant="ghost" onClick={() => deleteObject(o.id)} aria-label="Delete">
                      🗑
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </Card>

      <Modal
        open={exportOpen}
        title={`Export ${typeDef.label || "Type"} to CSV`}
        onClose={() => setExportOpen(false)}
        footer={
          <div className="oab-row oab-between">
            <Button variant="secondary" onClick={() => setExportOpen(false)}>
              Cancel
            </Button>
            <Button onClick={doExport}>Download</Button>
          </div>
        }
      >
        <div className="oab-grid2">
          <div>
            <LabelEl>Separator</LabelEl>
            <Input value={exportSep} onChange={(e) => setExportSep(e.target.value)} placeholder="," />
            <div className="oab-mutedSmall">Use "," for CSV, "\\t" for TSV.</div>
          </div>
          <div>
            <LabelEl>Filename</LabelEl>
            <Input value={exportFilename} onChange={(e) => setExportFilename(e.target.value)} />
          </div>
        </div>
        <div className="oab-mutedSmall oab-mt10">Header columns: {typeDef.properties.map((p) => p.key).join(", ")}</div>
      </Modal>

      <Modal
        open={importOpen}
        title={`Import ${typeDef.label || "Type"} from CSV`}
        onClose={() => {
          setImportOpen(false);
          setImportError("");
        }}
        footer={
          <div className="oab-row oab-between">
            <Button
              variant="secondary"
              onClick={() => {
                setImportOpen(false);
                setImportError("");
              }}
            >
              Close
            </Button>
            <Button onClick={doImportFromFile}>Import</Button>
          </div>
        }
      >
        <div className="oab-stack">
          <div className="oab-muted">
            Your file must include a <b>header row</b> with the properties defined for this object type, then one object per line.
          </div>

          <div className="oab-callout">
            <div className="oab-mutedSmall">Expected columns (order doesn’t matter):</div>
            <div className="oab-mono">{typeDef.properties.map((p) => p.key).join(", ")}</div>
          </div>

          <div className="oab-grid2">
            <div>
              <LabelEl>Separator</LabelEl>
              <Input value={importSep} onChange={(e) => setImportSep(e.target.value)} placeholder="," />
              <div className="oab-mutedSmall">Use "," for CSV, "\\t" for TSV.</div>
            </div>
            <div>
              <LabelEl>File</LabelEl>
              <input ref={fileRef} type="file" accept=".csv,.tsv,text/csv,text/plain" className="oab-file" />
            </div>
          </div>

          <div className="oab-mutedSmall">
            Notes:
            <ul className="oab-ul">
              <li>Required properties must be filled.</li>
              <li>Unique properties (and the display-name property) must not duplicate existing objects.</li>
            </ul>
          </div>

          {importError ? <div className="oab-error">{importError}</div> : null}
        </div>
      </Modal>

      <Modal
        open={editOpen}
        title={`Edit ${typeDef.label || "Object"}`}
        onClose={() => setEditOpen(false)}
        footer={
          <div className="oab-row oab-between">
            <Button variant="secondary" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveEdit}>Save</Button>
          </div>
        }
      >
        <div className="oab-grid3">
          {typeDef.properties.map((p) => (
            <div key={p.id}>
              <LabelEl>
                {p.key} {p.required ? <span className="oab-req">*</span> : null}{" "}
                {(p.unique || p.id === typeDef.titlePropId) && <span className="oab-mutedSmall">(unique)</span>}
              </LabelEl>

              {p.type === "boolean" ? (
                <div className="oab-inlineBox">
                  <Switch
                    checked={!!editDraft[p.id]}
                    onChange={(checked) => setEditDraft((prev) => ({ ...prev, [p.id]: checked }))}
                    label={editDraft[p.id] ? "True" : "False"}
                  />
                </div>
              ) : p.type === "date" ? (
                <Input
                  type="date"
                  value={String(editDraft[p.id] ?? "")}
                  onChange={(e) => setEditDraft((prev) => ({ ...prev, [p.id]: e.target.value }))}
                />
              ) : (
                <Input
                  value={String(editDraft[p.id] ?? "")}
                  onChange={(e) => setEditDraft((prev) => ({ ...prev, [p.id]: e.target.value }))}
                />
              )}
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}

// -------------------- Assignments Step --------------------

function AssignmentsStep({
  types,
  objects,
  assignments,
  setAssignments,
}: {
  types: ObjectTypeDef[];
  objects: ObjectInstance[];
  assignments: Assignment[];
  setAssignments: (updater: (prev: Assignment[]) => Assignment[]) => void;
}) {
  const [leftTypeId, setLeftTypeId] = useState(types[0]?.id ?? "");
  const [rightTypeId, setRightTypeId] = useState(types[1]?.id ?? types[0]?.id ?? "");
  const leftType = types.find((t) => t.id === leftTypeId) ?? types[0];
  const rightType = types.find((t) => t.id === rightTypeId) ?? types[0];

  useEffect(() => {
    if (!leftTypeId && types[0]) setLeftTypeId(types[0].id);
    if (!rightTypeId && (types[1] || types[0])) setRightTypeId((types[1] ?? types[0]).id);
  }, [types, leftTypeId, rightTypeId]);

  const leftObjects = useMemo(() => objects.filter((o) => o.typeId === leftType.id), [objects, leftType.id]);
  const rightObjects = useMemo(() => objects.filter((o) => o.typeId === rightType.id), [objects, rightType.id]);

  const leftDisplayProp = leftType.properties.find((p) => p.id === leftType.titlePropId) ?? leftType.properties[0];
  const rightDisplayProp = rightType.properties.find((p) => p.id === rightType.titlePropId) ?? rightType.properties[0];

  const [leftSearch, setLeftSearch] = useState("");
  const [leftOnlyMissing, setLeftOnlyMissing] = useState(false);

  const [rightSearch, setRightSearch] = useState("");
  const [rightOnlyMissing, setRightOnlyMissing] = useState(false);
  const [rightCols, setRightCols] = useState(5);

  const [selectedLeftId, setSelectedLeftId] = useState<string>("");


  const pairAssignments = useMemo(() => {
    const leftSet = new Set(leftObjects.map((o) => o.id));
    const rightSet = new Set(rightObjects.map((o) => o.id));
    return assignments.filter((a) => leftSet.has(a.leftObjectId) && rightSet.has(a.rightObjectId));
  }, [assignments, leftObjects, rightObjects]);

  function isAssigned(leftId: string, rightId: string): boolean {
    return pairAssignments.some((a) => a.leftObjectId === leftId && a.rightObjectId === rightId);
  }

  const selectAllRef = useRef<HTMLInputElement | null>(null);

  const allRightSelected = useMemo(() => {
    if (!selectedLeftId) return false;
    if (rightObjects.length === 0) return false;
    return rightObjects.every((ro) => isAssigned(selectedLeftId, ro.id));
  }, [selectedLeftId, rightObjects, pairAssignments]);

  const someRightSelected = useMemo(() => {
    if (!selectedLeftId) return false;
    return rightObjects.some((ro) => isAssigned(selectedLeftId, ro.id));
  }, [selectedLeftId, rightObjects, pairAssignments]);

  useEffect(() => {
    if (!selectAllRef.current) return;
    selectAllRef.current.indeterminate = !!selectedLeftId && !allRightSelected && someRightSelected;
  }, [selectedLeftId, allRightSelected, someRightSelected]);
  function setAllRightAssignments(on: boolean) {
    if (!selectedLeftId) return;
    setAssignments((prev) => {
      const rightIds = new Set(rightObjects.map((o) => o.id));

      // Remove all assignments for this selected left + any right of the selected right type
      const withoutForLeft = prev.filter(
        (a) => !(a.leftObjectId === selectedLeftId && rightIds.has(a.rightObjectId))
      );

      if (!on) return withoutForLeft;

      // Add assignments to every right object (avoid duplicates just in case)
      const existingRightIds = new Set(
        prev.filter((a) => a.leftObjectId === selectedLeftId && rightIds.has(a.rightObjectId)).map((a) => a.rightObjectId)
      );

      const newOnes: Assignment[] = rightObjects
        .filter((ro) => !existingRightIds.has(ro.id))
        .map((ro) => ({ id: uid(), leftObjectId: selectedLeftId, rightObjectId: ro.id }));

      return [...withoutForLeft, ...newOnes];
    });
  }
  function toggleAssign(rightId: string) {
    if (!selectedLeftId) return;
    setAssignments((prev) => {
      const idx = prev.findIndex((a) => a.leftObjectId === selectedLeftId && a.rightObjectId === rightId);
      if (idx >= 0) {
        // Remove this single pair (keep everything else untouched)
        return prev.filter((a) => !(a.leftObjectId === selectedLeftId && a.rightObjectId === rightId));
      }
      // Add (one left -> many rights)
      const newA: Assignment = { id: uid(), leftObjectId: selectedLeftId, rightObjectId: rightId };
      return [...prev, newA];
    });
  }

  const leftList = useMemo(() => {
    const q = leftSearch.trim().toLowerCase();
    return leftObjects
      .map((o) => ({ o, missing: computeMissing(leftType, o) }))
      .filter(({ o, missing }) => {
        if (leftOnlyMissing && !missing) return false;
        if (!q) return true;
        return normalizeUnique(o.values[leftDisplayProp.id]).includes(q);
      });
  }, [leftObjects, leftSearch, leftOnlyMissing, leftType, leftDisplayProp.id]);

  const rightList = useMemo(() => {
    const q = rightSearch.trim().toLowerCase();
    return rightObjects
      .map((o) => ({ o, missing: computeMissing(rightType, o) }))
      .filter(({ o, missing }) => {
        if (rightOnlyMissing && !missing) return false;
        if (!q) return true;
        return normalizeUnique(o.values[rightDisplayProp.id]).includes(q);
      });
  }, [rightObjects, rightSearch, rightOnlyMissing, rightType, rightDisplayProp.id]);

  // Export modals (simple)
  const [exportOpen, setExportOpen] = useState<null | "left_unassigned" | "right_unassigned" | "assignments">(null);
  const [exportSep, setExportSep] = useState(",");
  const [exportFilename, setExportFilename] = useState("export.csv");

  function toCSV(sep: string, rows: string[][]): string {
    const escapeCell = (s: string) => {
      const mustQuote = s.includes('"') || s.includes("\n") || s.includes("\r") || s.includes(sep);
      const v = s.replace(/"/g, '""');
      return mustQuote ? `"${v}"` : v;
    };
    return rows.map((r) => r.map((c) => escapeCell(c ?? "")).join(sep)).join("\n");
  }

  function downloadCSV(filename: string, csv: string) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function openExport(kind: "left_unassigned" | "right_unassigned" | "assignments") {
    setExportSep(",");
    if (kind === "left_unassigned") setExportFilename(defaultExportFilename(leftType.label, "unassigned"));
    if (kind === "right_unassigned") setExportFilename(defaultExportFilename(rightType.label, "unassigned"));
    if (kind === "assignments") setExportFilename(`${leftType.label}-${rightType.label}_assignments.csv`.replace(/\s+/g, "_"));
    setExportOpen(kind);
  }

  function doExport(kind: "left_unassigned" | "right_unassigned" | "assignments") {
    const sep = exportSep || ",";
    if (kind === "assignments") {
      const rows: string[][] = [[`${leftType.label}_id`, `${leftType.label}_name`, `${rightType.label}_id`, `${rightType.label}_name`]];
      for (const a of pairAssignments) {
        const lo = leftObjects.find((o) => o.id === a.leftObjectId);
        const ro = rightObjects.find((o) => o.id === a.rightObjectId);
        if (!lo || !ro) continue;
        rows.push([
          lo.id,
          String(lo.values[leftDisplayProp.id] ?? ""),
          ro.id,
          String(ro.values[rightDisplayProp.id] ?? ""),
        ]);
      }
      downloadCSV(exportFilename, toCSV(sep, rows));
      setExportOpen(null);
      return;
    }

    if (kind === "left_unassigned") {
      const assignedLeft = new Set(pairAssignments.map((a) => a.leftObjectId));
      const rows: string[][] = [[...leftType.properties.map((p) => p.key)]];
      for (const o of leftObjects) {
        if (assignedLeft.has(o.id)) continue;
        rows.push(leftType.properties.map((p) => String(o.values[p.id] ?? "")));
      }
      downloadCSV(exportFilename, toCSV(sep, rows));
      setExportOpen(null);
      return;
    }

    if (kind === "right_unassigned") {
      const assignedRight = new Set(pairAssignments.map((a) => a.rightObjectId));
      const rows: string[][] = [[...rightType.properties.map((p) => p.key)]];
      for (const o of rightObjects) {
        if (assignedRight.has(o.id)) continue;
        rows.push(rightType.properties.map((p) => String(o.values[p.id] ?? "")));
      }
      downloadCSV(exportFilename, toCSV(sep, rows));
      setExportOpen(null);
      return;
    }
  }

  return (
    <div className="oab-stack">
      <div className="oab-row oab-between">
        <div>
          <div className="oab-h2">Define assignments</div>
          <div className="oab-muted">Select a left object, then choose right objects from the grid.</div>
        </div>

        <div className="oab-row oab-gap8 oab-wrap">
          <Button variant="secondary" onClick={() => openExport("left_unassigned")}>
            Export {leftType.label} unassigned
          </Button>
          <Button variant="secondary" onClick={() => openExport("right_unassigned")}>
            Export {rightType.label} unassigned
          </Button>
          <Button variant="secondary" onClick={() => openExport("assignments")}>
            Export {leftType.label}-{rightType.label}_assignments
          </Button>
        </div>
      </div>

      <div className="oab-row oab-gap12 oab-wrap">
        <div className="oab-row oab-gap8">
          <LabelEl>Left type</LabelEl>
          <Select value={leftTypeId} onChange={(e) => setLeftTypeId(e.target.value)}>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label || "Untitled"}
              </option>
            ))}
          </Select>
        </div>

        <div className="oab-row oab-gap8">
          <LabelEl>Right type</LabelEl>
          <Select value={rightTypeId} onChange={(e) => setRightTypeId(e.target.value)}>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label || "Untitled"}
              </option>
            ))}
          </Select>
        </div>

        {leftTypeId === rightTypeId ? (
          <div className="oab-warnText">Left and Right are the same type.</div>
        ) : null}
      </div>

      <div className="oab-assignGrid">
        <Card
          title="Left list"
          subtitle="Pick a left object. The selected one shows compact details."
        >
          <div className="oab-row oab-gap12 oab-mt6">
            <div className="oab-grow">
              <Input placeholder="Search..." value={leftSearch} onChange={(e) => setLeftSearch(e.target.value)} />
            </div>
            <label className="oab-check oab-mlAuto oab-onlyMissingLeft">
              <input type="checkbox" checked={leftOnlyMissing} onChange={(e) => setLeftOnlyMissing(e.target.checked)} /> Only missing
            </label>
          </div>

          <div className="oab-leftList">
            {leftList.map(({ o, missing }) => {
              const name = String(o.values[leftDisplayProp.id] ?? "").trim() || "(unnamed)";
              const active = selectedLeftId === o.id;
              return (
                <button
                  key={o.id}
                  type="button"
                  className={cx("oab-leftItem", active && "is-active")}
                  onClick={() => setSelectedLeftId(o.id)}
                >
                  <div className="oab-row oab-between">
                    <div className="oab-leftName">{name}</div>
                    {missing ? <Badge>Missing</Badge> : null}
                  </div>
                </button>
              );
            })}
            {leftList.length === 0 ? <div className="oab-empty">No left objects.</div> : null}
          </div>
        </Card>

        <Card title="Right grid" subtitle="Assigned items are highlighted. Unassigned items are dimmed.">
          <div className="oab-rightControls">
            <div>
              <LabelEl>Columns</LabelEl>
              <Input
                type="number"
                min={1}
                max={12}
                value={rightCols}
                onChange={(e) => setRightCols(Math.max(1, Math.min(12, Number(e.target.value || 5))))}
                style={{ width: 120 }}
              />
            </div>

            <div className="oab-grow">
              <LabelEl>Filter</LabelEl>
              <Input placeholder="Type to search..." value={rightSearch} onChange={(e) => setRightSearch(e.target.value)} />
            </div>

            <label className="oab-check oab-rightOnlyMissing">
              <input type="checkbox" checked={rightOnlyMissing} onChange={(e) => setRightOnlyMissing(e.target.checked)} /> Only missing
            </label>

<label className="oab-check">
  <input
    ref={selectAllRef}
    type="checkbox"
    disabled={!selectedLeftId || rightObjects.length === 0}
    checked={allRightSelected}
    onChange={(e) => setAllRightAssignments(e.target.checked)}
  />{" "}
  Select all {rightType.label}
</label>

          </div>

          {!selectedLeftId ? (
            <div className="oab-empty oab-mt10">Select a left object to start assigning.</div>
          ) : (
            <div className="oab-gridScroller oab-mt10">
              <div className="oab-rectGrid" style={{ gridTemplateColumns: `repeat(${rightCols}, minmax(140px, 1fr))` }}>
                {rightList.map(({ o, missing }) => {
                  const name = String(o.values[rightDisplayProp.id] ?? "").trim() || "(unnamed)";
                  const assigned = isAssigned(selectedLeftId, o.id);
                  return (
                    <button
                      key={o.id}
                      type="button"
                      className={cx("oab-rect", assigned && "is-assigned", missing && "is-missing")}
                      onClick={() => toggleAssign(o.id)}
                    >
                      <div className="oab-rectTitle">{name}</div>
                      <div className="oab-rectMeta">
                        {missing ? <span className="oab-warnText">Missing</span> : <span className="oab-mutedSmall"> </span>}
                        <span className={cx("oab-pillTiny", assigned ? "is-on" : "is-off")}>{assigned ? "Assigned" : "Unassigned"}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </Card>
      </div>

      <Modal
        open={exportOpen !== null}
        title="Export CSV"
        onClose={() => setExportOpen(null)}
        footer={
          <div className="oab-row oab-between">
            <Button variant="secondary" onClick={() => setExportOpen(null)}>
              Cancel
            </Button>
            <Button onClick={() => exportOpen && doExport(exportOpen)}>Download</Button>
          </div>
        }
      >
        <div className="oab-grid2">
          <div>
            <LabelEl>Separator</LabelEl>
            <Input value={exportSep} onChange={(e) => setExportSep(e.target.value)} />
            <div className="oab-mutedSmall">Use "," for CSV, "\\t" for TSV.</div>
          </div>
          <div>
            <LabelEl>Filename</LabelEl>
            <Input value={exportFilename} onChange={(e) => setExportFilename(e.target.value)} />
          </div>
        </div>
      </Modal>
    </div>
  );
}

// -------------------- Page --------------------

const STORAGE_KEY = "oab_state_multi_v1";

function createDefaultState(): AppState {
  const namePropId = uid();
  const leftType: ObjectTypeDef = {
    id: uid(),
    label: "Left",
    titlePropId: namePropId,
    properties: [{ id: namePropId, key: "name", type: "text", required: true, unique: true }],
  };

  const rightNamePropId = uid();
  const rightType: ObjectTypeDef = {
    id: uid(),
    label: "Right",
    titlePropId: rightNamePropId,
    properties: [{ id: rightNamePropId, key: "name", type: "text", required: true, unique: true }],
  };

  return { types: [leftType, rightType], objects: [], assignments: [] };
}

export default function Page(): JSX.Element {
  const [activeStep, setActiveStep] = useState<StepId>("schema");
  const [state, setState] = useState<AppState>(() => createDefaultState());

  const [selectedTypeId, setSelectedTypeId] = useState<string>(() => createDefaultState().types[0].id);

  const [jsonImportOpen, setJsonImportOpen] = useState(false);
  const [jsonImportError, setJsonImportError] = useState<string>("");
  const jsonFileRef = useRef<HTMLInputElement>(null);

  // Load from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as AppState;
      if (!parsed.types?.length) return;
      setState(parsed);
      setSelectedTypeId(parsed.types[0].id);
    } catch {
      // ignore
    }
  }, []);

  // Persist
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore
    }
  }, [state]);

  const schemaReady = state.types.every((t) => t.label.trim() && t.properties.length >= 1 && t.titlePropId);
  const objectsCount = state.objects.length;
  const assignmentsCount = state.assignments.length;

  function updateType(typeId: string, updater: (prev: ObjectTypeDef) => ObjectTypeDef) {
    setState((prev) => ({
      ...prev,
      types: prev.types.map((t) => (t.id === typeId ? updater(t) : t)),
    }));
  }

  function addType() {
    const id = uid();
    const propId = uid();
    const next: ObjectTypeDef = {
      id,
      label: `Type ${state.types.length + 1}`,
      titlePropId: propId,
      properties: [{ id: propId, key: "name", type: "text", required: true, unique: true }],
    };
    setState((prev) => ({ ...prev, types: [...prev.types, next] }));
    setSelectedTypeId(id);
  }

  function deleteType(typeId: string) {
    if (state.types.length <= 1) return;
    if (!confirm("Delete this type and all its objects/assignments?")) return;

    const remainingTypes = state.types.filter((t) => t.id !== typeId);
    const remainingTypeIds = new Set(remainingTypes.map((t) => t.id));

    const remainingObjects = state.objects.filter((o) => remainingTypeIds.has(o.typeId));
    const remainingObjectIds = new Set(remainingObjects.map((o) => o.id));
    const remainingAssignments = state.assignments.filter((a) => remainingObjectIds.has(a.leftObjectId) && remainingObjectIds.has(a.rightObjectId));

    setState((prev) => ({ ...prev, types: remainingTypes, objects: remainingObjects, assignments: remainingAssignments }));
    setSelectedTypeId(remainingTypes[0].id);
  }

  function exportStateToJson() {
    const payload: ExportedJson = {
      version: 1,
      exportedAt: new Date().toISOString(),
      state,
    };
    const text = JSON.stringify(payload, null, 2);
    const filename = `oab_state_${new Date().toISOString().slice(0, 10)}.json`;
    downloadTextFile(filename, text, "application/json;charset=utf-8");
  }

  async function importStateFromJsonFile() {
    setJsonImportError("");
    const file = jsonFileRef.current?.files?.[0];
    if (!file) {
      setJsonImportError("Choose a JSON file first.");
      return;
    }

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const res = sanitizeImportedState(parsed);
      if (!res.ok) {
        setJsonImportError(res.message);
        return;
      }

      // Replace current work completely
      setState(res.state);
      setSelectedTypeId(res.state.types[0].id);
      setActiveStep("schema");

      // Clear file input so you can re-import the same file if needed
      if (jsonFileRef.current) jsonFileRef.current.value = "";
      setJsonImportOpen(false);

      if (res.droppedAssignments > 0) {
        alert(`Imported successfully. Dropped ${res.droppedAssignments} invalid assignment(s) referencing missing objects.`);
      }
    } catch {
      setJsonImportError("Could not parse JSON. Make sure the file is a valid export from this app.");
    }
  }

  return (
    <div className="oab-bg">
      <div className="oab-wrapPage">
        <div className="oab-header">
          <div>
            <div className="oab-title">Object Assignment Builder</div>
            <div className="oab-muted">Define object types, create objects, then assign them (one left → many rights).</div>
          </div>
          <div className="oab-row oab-gap8">
            <Button variant="secondary" onClick={exportStateToJson}>
              Save JSON
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setJsonImportError("");
                setJsonImportOpen(true);
              }}
            >
              Load JSON
            </Button>
            <span className="oab-chip">Objects: {objectsCount}</span>
            <span className="oab-chip">Assignments: {assignmentsCount}</span>
          </div>
        </div>

        <div className="oab-steps">
          <button className={cx("oab-step", activeStep === "schema" && "is-active")} onClick={() => setActiveStep("schema")} type="button">
            1) Types & Properties {activeStep === "schema" ? <Badge>Active</Badge> : null}
          </button>
          <button
            className={cx("oab-step", activeStep === "objects" && "is-active")}
            onClick={() => setActiveStep("objects")}
            type="button"
            disabled={!schemaReady}
            title={!schemaReady ? "Complete schema first" : ""}
          >
            2) Objects {activeStep === "objects" ? <Badge>Active</Badge> : null}
          </button>
          <button
            className={cx("oab-step", activeStep === "assign" && "is-active")}
            onClick={() => setActiveStep("assign")}
            type="button"
            disabled={!schemaReady}
            title={!schemaReady ? "Complete schema first" : ""}
          >
            3) Assignments {activeStep === "assign" ? <Badge>Active</Badge> : null}
          </button>
        </div>

        {activeStep === "schema" ? (
          <SchemaEditor
            types={state.types}
            selectedTypeId={selectedTypeId}
            setSelectedTypeId={setSelectedTypeId}
            onAddType={addType}
            onDeleteType={deleteType}
            updateType={updateType}
          />
        ) : null}

        {activeStep === "objects" ? (
          <ObjectsStep
            types={state.types}
            selectedTypeId={selectedTypeId}
            setSelectedTypeId={setSelectedTypeId}
            objects={state.objects}
            setObjects={(updater) => setState((prev) => ({ ...prev, objects: updater(prev.objects) }))}
            setAssignments={(updater) => setState((prev) => ({ ...prev, assignments: updater(prev.assignments) }))}
            updateType={updateType}
          />
        ) : null}

        {activeStep === "assign" ? (
          <AssignmentsStep
            types={state.types}
            objects={state.objects}
            assignments={state.assignments}
            setAssignments={(updater) => setState((prev) => ({ ...prev, assignments: updater(prev.assignments) }))}
          />
        ) : null}

        <Modal
          open={jsonImportOpen}
          title="Load from JSON"
          onClose={() => setJsonImportOpen(false)}
          footer={
            <div className="oab-row oab-between">
              <Button variant="secondary" onClick={() => setJsonImportOpen(false)}>
                Cancel
              </Button>
              <Button onClick={importStateFromJsonFile}>Load</Button>
            </div>
          }
        >
          <div className="oab-stack">
            <div className="oab-muted">
              Choose a JSON file previously saved from this app. Loading will <b>replace your current work</b> (types, objects and assignments).
            </div>

            <div>
              <LabelEl>JSON file</LabelEl>
              <input ref={jsonFileRef} type="file" accept="application/json,.json" />
            </div>

            <div className="oab-mutedSmall">
              The JSON contains your schema (types & properties), objects and assignments. Tip: you can send this file to another user to continue the same work.
            </div>

            {jsonImportError ? <div className="oab-errorBox">{jsonImportError}</div> : null}
          </div>
        </Modal>
      </div>

      <style jsx global>{`
        :root{
          --oab-radius: 14px;
          --oab-border: rgba(17,24,39,.10);
          --oab-shadow: 0 10px 30px rgba(0,0,0,.10);
          --oab-bg: #f7f3ea;
          --oab-card: rgba(255,255,255,.72);
          --oab-text: #111827;
          --oab-muted: rgba(17,24,39,.62);
          --oab-accent: #7c5ce4;
          --oab-accent2: rgba(124,92,228,.14);
          --oab-warn: #b45309;
          --oab-error: #b91c1c;
        }
        *{ box-sizing: border-box; }
        body{ margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"; color: var(--oab-text); }
        .oab-bg{
          min-height: 100vh;
          background:
            radial-gradient(circle at 15% 30%, rgba(16,185,129,.20) 0 40%, transparent 41%),
            radial-gradient(circle at 80% 75%, rgba(124,92,228,.28) 0 28%, transparent 29%),
            radial-gradient(circle at 15% 65%, rgba(245,158,11,.18) 0 22%, transparent 23%),
            var(--oab-bg);
        }
        .oab-wrapPage{ max-width: 1320px; margin: 0 auto; padding: 28px 16px 48px; display:flex; flex-direction:column; gap: 16px; }
        .oab-header{ display:flex; justify-content:space-between; gap: 14px; align-items:flex-start; }
        .oab-title{ font-size: 28px; font-weight: 800; letter-spacing: .2px; }
        .oab-muted{ color: var(--oab-muted); }
        .oab-mutedSmall{ color: var(--oab-muted); font-size: 12px; }
        .oab-h2{ font-size: 20px; font-weight: 800; }
        .oab-h3{ font-size: 14px; font-weight: 800; }
        .oab-chip{
          border: 1px solid var(--oab-border);
          background: rgba(255,255,255,.65);
          border-radius: 999px;
          padding: 6px 10px;
          font-size: 12px;
          color: var(--oab-muted);
        }

        .oab-steps{
          display:grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 12px;
          align-items: stretch;
        }
        .oab-step{
          text-align:left;
          border: 1px solid var(--oab-border);
          background: rgba(255,255,255,.55);
          border-radius: 999px;
          padding: 12px 14px;
          font-weight: 700;
          display:flex;
          justify-content:space-between;
          gap: 10px;
          cursor:pointer;
        }
        .oab-step.is-active{
          border-color: rgba(124,92,228,.35);
          box-shadow: 0 0 0 4px rgba(124,92,228,.08);
          background: rgba(255,255,255,.72);
        }
        .oab-step:disabled{
          opacity: .55;
          cursor:not-allowed;
        }

        .oab-stack{ display:flex; flex-direction:column; gap: 14px; }
        .oab-row{ display:flex; align-items:center; }
        .oab-between{ justify-content:space-between; }
        .oab-gap8{ gap: 8px; }
        .oab-gap10{ gap: 10px; }
        .oab-gap12{ gap: 12px; }
        .oab-wrap{ flex-wrap: wrap; }
        .oab-grow{ flex: 1; min-width: 240px; }
        .oab-mlAuto{ margin-left:auto; }
        .oab-onlyMissingLeft{ padding-left: 6px; }
        .oab-mt6{ margin-top: 6px; }
        .oab-mt10{ margin-top: 10px; }
        .oab-mt14{ margin-top: 14px; }

        .oab-btn{
          border-radius: 12px;
          padding: 10px 12px;
          font-weight: 800;
          border: 1px solid var(--oab-border);
          cursor:pointer;
          background: white;
        }
        .oab-btn-primary{
          background: var(--oab-accent);
          color: white;
          border-color: rgba(124,92,228,.6);
        }
        .oab-btn-secondary{
          background: rgba(255,255,255,.78);
          color: var(--oab-text);
        }
        .oab-btn-ghost{
          background: transparent;
          border-color: transparent;
          color: var(--oab-muted);
        }
        .oab-btn:disabled{ opacity:.55; cursor:not-allowed; }

        .oab-input, .oab-select{
          width: 100%;
          border-radius: 12px;
          border: 1px solid rgba(17,24,39,.16);
          padding: 10px 12px;
          background: rgba(255,255,255,.92);
          outline: none;
          font-size: 14px;
        }
        .oab-input:focus, .oab-select:focus{
          border-color: rgba(124,92,228,.55);
          box-shadow: 0 0 0 4px rgba(124,92,228,.10);
        }

        .oab-pill{
          border: 1px solid var(--oab-border);
          background: rgba(255,255,255,.62);
          padding: 7px 10px;
          border-radius: 999px;
          font-weight: 800;
          cursor:pointer;
        }
        .oab-pill.is-active{
          border-color: rgba(124,92,228,.40);
          background: rgba(255,255,255,.82);
          box-shadow: 0 0 0 4px rgba(124,92,228,.08);
        }

        .oab-card{
          border: 1px solid var(--oab-border);
          border-radius: var(--oab-radius);
          background: var(--oab-card);
          box-shadow: var(--oab-shadow);
          overflow:hidden;
        }
        .oab-cardHead{
          padding: 14px 16px;
          border-bottom: 1px solid rgba(17,24,39,.08);
          display:flex;
          justify-content:space-between;
          align-items:flex-start;
          gap: 12px;
        }
        .oab-cardTitle{ font-weight: 900; }
        .oab-cardActions{ display:flex; gap: 8px; align-items:center; flex-wrap:wrap; }
        .oab-cardBody{ padding: 14px 16px; }

        .oab-label{ font-size: 12px; font-weight: 800; color: rgba(17,24,39,.72); margin-bottom: 6px; }
        .oab-req{ color: var(--oab-error); }

        .oab-badge{
          display:inline-flex;
          align-items:center;
          gap: 6px;
          font-size: 12px;
          padding: 4px 10px;
          border-radius: 999px;
          border: 1px solid rgba(17,24,39,.10);
          background: rgba(255,255,255,.75);
          color: rgba(17,24,39,.72);
          white-space: nowrap;
        }

        .oab-switch{ display:flex; gap: 10px; align-items:center; cursor:pointer; user-select:none; }
        .oab-switch input{ display:none; }
        .oab-switch-ui{
          width: 44px; height: 24px;
          border-radius: 999px;
          background: rgba(17,24,39,.18);
          position: relative;
          box-shadow: inset 0 0 0 1px rgba(0,0,0,.05);
        }
        .oab-switch-ui::after{
          content:"";
          width: 18px; height: 18px;
          border-radius: 999px;
          background: white;
          position: absolute;
          top: 3px; left: 3px;
          transition: transform .15s ease;
          box-shadow: 0 6px 16px rgba(0,0,0,.12);
        }
        .oab-switch input:checked + .oab-switch-ui{ background: rgba(124,92,228,.68); }
        .oab-switch input:checked + .oab-switch-ui::after{ transform: translateX(20px); }
        .oab-switch-label{ font-size: 12px; color: var(--oab-muted); font-weight: 800; }

        .oab-grid2{ display:grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .oab-grid3{ display:grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
        @media (max-width: 980px){ .oab-grid3{ grid-template-columns: 1fr; } .oab-grid2{ grid-template-columns: 1fr; } .oab-steps{ grid-template-columns: 1fr; } }

        .oab-propList{ display:flex; flex-direction:column; gap: 10px; margin-top: 12px; }
        .oab-propRow{
          display:grid;
          grid-template-columns: 1.2fr .9fr .7fr .7fr 1fr;
          gap: 10px;
          padding: 12px;
          border: 1px solid rgba(17,24,39,.10);
          border-radius: 14px;
          background: rgba(255,255,255,.55);
          align-items:end;
        }
        .oab-propRowActions{ display:flex; justify-content:space-between; align-items:center; gap: 10px; }

        .oab-inlineBox{ min-height: 42px; display:flex; align-items:center; }
        .oab-newObj{
          border: 1px solid rgba(17,24,39,.08);
          background: rgba(255,255,255,.62);
          border-radius: 16px;
          padding: 14px;
        }
        .oab-check{ display:flex; align-items:center; gap: 8px; font-size: 12px; color: var(--oab-muted); font-weight: 800; }
        .oab-check-tight{ gap: 6px; }
        .oab-check input{ width: 16px; height: 16px; }

        .oab-objList{ margin-top: 10px; display:flex; flex-direction:column; gap: 10px; }
        .oab-empty{
          border: 1px dashed rgba(17,24,39,.18);
          border-radius: 14px;
          padding: 12px;
          color: var(--oab-muted);
          background: rgba(255,255,255,.42);
        }
        .oab-objRow{
          border: 1px solid rgba(17,24,39,.10);
          border-radius: 14px;
          background: rgba(255,255,255,.62);
          padding: 10px 12px;
          display:flex;
          justify-content:space-between;
          align-items:center;
          gap: 12px;
        }
        .oab-objRow.is-missing{ box-shadow: 0 0 0 3px rgba(180,83,9,.10); border-color: rgba(180,83,9,.25); }
        .oab-objRowMain{
          display:grid;
          grid-template-columns: 46px minmax(220px, 1fr) 140px;
          align-items:center;
          gap: 18px; /* requested more horizontal space */
          min-width: 0;
          flex: 1;
        }
        .oab-objName{ font-weight: 900; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .oab-objRowActions{ display:flex; align-items:center; gap: 14px; }

        /* Assignments layout (right wider) */
        .oab-assignGrid{ display:grid; grid-template-columns: minmax(340px, .75fr) minmax(0, 1.25fr); gap: 14px; }
        @media (max-width: 1080px){ .oab-assignGrid{ grid-template-columns: 1fr; } }

        .oab-leftList{ display:flex; flex-direction:column; gap: 8px; margin-top: 10px; }
        .oab-leftItem{
          text-align:left;
          border: 1px solid rgba(17,24,39,.10);
          background: rgba(255,255,255,.62);
          border-radius: 14px;
          padding: 10px 12px;
          cursor:pointer;
        }
        .oab-leftItem.is-active{
          border-color: rgba(124,92,228,.45);
          box-shadow: 0 0 0 4px rgba(124,92,228,.10);
          background: rgba(255,255,255,.82);
        }
        .oab-leftName{ font-weight: 900; }

        .oab-rightControls{
          display:flex;
          gap: 12px;
          align-items:flex-end;
          flex-wrap:wrap;
        }
        .oab-rightOnlyMissing{ margin-left:auto; }

        .oab-gridScroller{
          border: 1px solid rgba(17,24,39,.10);
          border-radius: 14px;
          background: rgba(255,255,255,.55);
          padding: 10px;
          overflow:auto;
        }
        .oab-rectGrid{ display:grid; gap: 8px; min-width: 0; }

        .oab-rect{
          text-align:left;
          border: 1px solid rgba(17,24,39,.10);
          border-radius: 14px;
          background: rgba(255,255,255,.70);
          padding: 10px 10px;
          cursor:pointer;
          min-height: 70px;
        }
        .oab-rect.is-assigned{
          border-color: rgba(124,92,228,.55);
          box-shadow: 0 0 0 4px rgba(124,92,228,.10);
          background: rgba(124,92,228,.10);
        }
        .oab-rect.is-missing{
          border-color: rgba(180,83,9,.25);
        }
        .oab-rectTitle{ font-weight: 900; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .oab-rectMeta{ display:flex; justify-content:space-between; align-items:center; margin-top: 6px; }
        .oab-pillTiny{
          font-size: 11px;
          padding: 3px 8px;
          border-radius: 999px;
          border: 1px solid rgba(17,24,39,.10);
          color: rgba(17,24,39,.62);
          background: rgba(255,255,255,.70);
        }
        .oab-pillTiny.is-on{ border-color: rgba(124,92,228,.40); background: rgba(124,92,228,.10); color: rgba(17,24,39,.70); }
        .oab-pillTiny.is-off{ opacity: .75; }

        .oab-warn{ color: var(--oab-warn); }
        .oab-warnText{ color: var(--oab-warn); font-weight: 800; font-size: 12px; }
        .oab-error{ color: var(--oab-error); font-weight: 900; padding: 10px 12px; border-radius: 12px; background: rgba(185,28,28,.08); border: 1px solid rgba(185,28,28,.18); }
        .oab-callout{ padding: 10px 12px; border-radius: 14px; border: 1px solid rgba(17,24,39,.10); background: rgba(255,255,255,.65); }
        .oab-mono{ font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; }
        .oab-ul{ margin: 8px 0 0 18px; padding: 0; }
        .oab-file{ width: 100%; }

        /* Modal */
        .oab-modalOverlay{
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,.30);
          display:flex;
          align-items:center;
          justify-content:center;
          padding: 18px;
          z-index: 50;
        }
        .oab-modal{
          width: 100%;
          border-radius: 16px;
          background: rgba(255,255,255,.96);
          border: 1px solid rgba(17,24,39,.12);
          box-shadow: 0 24px 60px rgba(0,0,0,.25);
          overflow:hidden;
        }
        .oab-modalHead{
          display:flex;
          justify-content:space-between;
          align-items:center;
          padding: 12px 14px;
          border-bottom: 1px solid rgba(17,24,39,.10);
        }
        .oab-modalTitle{ font-weight: 950; }
        .oab-modalBody{ padding: 14px; }
        .oab-modalFoot{
          padding: 12px 14px;
          border-top: 1px solid rgba(17,24,39,.10);
        }
      `}</style>
    </div>
  );
}