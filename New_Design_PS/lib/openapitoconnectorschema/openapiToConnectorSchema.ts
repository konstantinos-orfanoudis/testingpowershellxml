import SwaggerParser from "@apidevtools/swagger-parser";
import * as yaml from "js-yaml";

type AttrType = "String" | "Int" | "Bool" | "Datetime";
type Attribute = {
  name: string;
  type: AttrType;
  MultiValue: boolean;
  IsKey: boolean;
  AutoFill: boolean;
  Mandatory: boolean;
};
type Entity = { name: string; attributes: Attribute[] };
type Schema = { name: string; version: string; entities: Entity[] };

type Options = {
  schemaName?: string;
  version?: string;
  // prefer "id" if present; otherwise you can extend heuristics
  keyCandidates?: string[];
  flatten?: boolean; // default true -> profile_email style
};

function parseJsonOrYaml(text: string): any {
  const t = text.trim();
  if (!t) throw new Error("Empty spec file");
  if (t.startsWith("{") || t.startsWith("[")) return JSON.parse(t);
  return yaml.load(t);
}

function mapType(s: any): AttrType {
  const t = s?.type;
  const f = s?.format;

  if (t === "boolean") return "Bool";
  if (t === "integer") return "Int";
  if (t === "number") return "Int"; // or "String"/"Double" if you later add it
  if (t === "string" && (f === "date-time" || f === "datetime")) return "Datetime";
  if (t === "string") return "String";
  return "String";
}

function mergeAllOf(schema: any): any {
  if (!schema?.allOf || !Array.isArray(schema.allOf)) return schema;
  const out: any = { ...schema, properties: {}, required: [] as string[] };
  for (const part of schema.allOf) {
    const p = mergeAllOf(part);
    if (p?.properties) Object.assign(out.properties, p.properties);
    if (Array.isArray(p?.required)) out.required.push(...p.required);
  }
  out.required = Array.from(new Set(out.required));
  delete out.allOf;
  return out;
}


function getRequiredSet(schema: any): Set<string> {
  const req = schema?.required;
  if (!Array.isArray(req)) return new Set<string>();
  return new Set<string>(req.filter((x: unknown): x is string => typeof x === "string"));
}

function flattenProps(args: {
  entityName: string;
  schema: any;
  out: Attribute[];
  prefix?: string;
  required?: Set<string>;
  options: Required<Pick<Options, "keyCandidates" | "flatten">>;
}) {
  const { entityName, out, options } = args;
  const prefix = args.prefix ?? "";
  const schema = mergeAllOf(args.schema);

  const required = args.required ?? getRequiredSet(schema);

  if (schema?.type === "array") {
    const name = prefix;
    const items = mergeAllOf(schema.items ?? {});
    out.push({
      name,
      type: mapType(items),
      MultiValue: true,
      IsKey: options.keyCandidates.includes(name) || options.keyCandidates.includes(name.toLowerCase()),
      AutoFill: !!schema.readOnly,
      Mandatory: required.has(name),
    });
    return;
  }

  const isObj = schema?.type === "object" || schema?.properties;
  if (isObj && schema?.properties && typeof schema.properties === "object") {
    const req = getRequiredSet(schema);

    for (const [prop, propSchema] of Object.entries<any>(schema.properties)) {
      const fullName = prefix ? `${prefix}_${prop}` : prop;
      const child = mergeAllOf(propSchema);
      const childIsObj = (child?.type === "object" || child?.properties) && child?.properties;

      if (options.flatten && childIsObj) {
        flattenProps({ entityName, schema: child, out, prefix: fullName, required: req, options });
      } else if (child?.type === "array") {
        flattenProps({ entityName, schema: child, out, prefix: fullName, required: req, options });
      } else {
        out.push({
          name: fullName,
          type: mapType(child),
          MultiValue: false,
          IsKey:
            options.keyCandidates.includes(prop) ||
            options.keyCandidates.includes(fullName) ||
            prop.toLowerCase() === "id" ||
            fullName.toLowerCase() === "id",
          AutoFill: !!child?.readOnly,
          Mandatory: req.has(prop),
        });
      }
    }
    return;
  }

  if (prefix) {
    out.push({
      name: prefix,
      type: mapType(schema),
      MultiValue: false,
      IsKey: options.keyCandidates.includes(prefix) || prefix.toLowerCase() === "id",
      AutoFill: !!schema?.readOnly,
      Mandatory: required.has(prefix),
    });
  }
}


export async function openApiToConnectorSchemaFromText(
  specText: string,
  options: Options = {}
): Promise<Schema> {
  const raw = parseJsonOrYaml(specText);

  // Dereference $ref so walking schemas is predictable
  const api: any = await SwaggerParser.dereference(raw);

  const title = options.schemaName ?? api?.info?.title ?? "Connector";
  const version = options.version ?? api?.info?.version ?? "1.0.0";

  const schemas: Record<string, any> =
    api?.components?.schemas ?? api?.definitions ?? {};

  const keyCandidates = options.keyCandidates ?? ["id"];
  const flatten = options.flatten ?? true;

  const entities: Entity[] = Object.entries(schemas).map(([name, schema]) => {
    const attributes: Attribute[] = [];
    flattenProps({
      entityName: name,
      schema,
      out: attributes,
      options: { keyCandidates, flatten },
    });

    // Ensure you always have at least something
    if (attributes.length === 0) {
      attributes.push({
        name: "id",
        type: "String",
        MultiValue: false,
        IsKey: false,
        AutoFill: false,
        Mandatory: false,
      });
    }

    // Optional: enforce single key (your UI enforces one key anyway)
    // If multiple keys were marked, keep the first.
    const keyIdx = attributes.findIndex((a) => a.IsKey);
    if (keyIdx >= 0) {
      attributes.forEach((a, i) => (a.IsKey = i === keyIdx));
    }

    return { name, attributes };
  });

  return { name: title, version, entities };
}
