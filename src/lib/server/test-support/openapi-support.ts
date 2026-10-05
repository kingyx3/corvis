/**
 * Test-only helpers for holding route responses to openapi/corvis-v1.yaml without
 * adding a dependency: a parser for the small YAML subset the spec is written in
 * and a validator for the small JSON Schema subset the spec uses.
 *
 * Both fail loudly on anything they do not understand (an unknown YAML construct
 * or an unsupported schema keyword) so a spec edit can never make the response
 * checks silently vacuous.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

// ---------------------------------------------------------------- YAML subset

type Line = { indent: number; text: string; no: number };

function stripComment(text: string): string {
  // The spec has no comments; a whole-line comment is the only form tolerated.
  return /^\s*#/.test(text) ? "" : text;
}

class FlowParser {
  private pos = 0;
  private readonly src: string;
  private readonly line: number;
  constructor(src: string, line: number) {
    this.src = src;
    this.line = line;
  }

  parse(): Json {
    const value = this.value();
    this.ws();
    if (this.pos !== this.src.length) this.fail("trailing characters in flow value");
    return value;
  }

  private fail(message: string): never {
    throw new Error(`YAML line ${this.line}: ${message}: ${this.src}`);
  }
  private ws() { while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos += 1; }

  private value(): Json {
    this.ws();
    const ch = this.src[this.pos];
    if (ch === "{") return this.map();
    if (ch === "[") return this.seq();
    if (ch === "'" || ch === '"') return this.quoted();
    return scalar(this.plain());
  }

  private map(): Json {
    const result: Obj = {};
    this.pos += 1;
    this.ws();
    if (this.src[this.pos] === "}") { this.pos += 1; return result; }
    for (;;) {
      this.ws();
      const key = this.src[this.pos] === "'" || this.src[this.pos] === '"' ? this.quoted() : this.plain(true);
      this.ws();
      if (this.src[this.pos] !== ":") this.fail("expected ':' in flow map");
      this.pos += 1;
      // Standard YAML loaders reject a repeated key; silently keeping the last one hid a broken contract.
      if (Object.hasOwn(result, String(key))) this.fail(`duplicate key ${String(key)} in flow map`);
      result[String(key)] = this.value();
      this.ws();
      if (this.src[this.pos] === ",") { this.pos += 1; continue; }
      if (this.src[this.pos] === "}") { this.pos += 1; return result; }
      this.fail("expected ',' or '}' in flow map");
    }
  }

  private seq(): Json {
    const result: Json[] = [];
    this.pos += 1;
    this.ws();
    if (this.src[this.pos] === "]") { this.pos += 1; return result; }
    for (;;) {
      result.push(this.value());
      this.ws();
      if (this.src[this.pos] === ",") { this.pos += 1; continue; }
      if (this.src[this.pos] === "]") { this.pos += 1; return result; }
      this.fail("expected ',' or ']' in flow sequence");
    }
  }

  private quoted(): string {
    const quote = this.src[this.pos]!;
    this.pos += 1;
    let out = "";
    for (;;) {
      const ch = this.src[this.pos];
      if (ch === undefined) this.fail("unterminated quoted scalar");
      if (ch === quote) {
        if (quote === "'" && this.src[this.pos + 1] === "'") { out += "'"; this.pos += 2; continue; }
        this.pos += 1;
        return out;
      }
      if (quote === '"' && ch === "\\") { out += this.src[this.pos + 1]; this.pos += 2; continue; }
      out += ch;
      this.pos += 1;
    }
  }

  private plain(isKey = false): string {
    const start = this.pos;
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]!;
      if (ch === "," || ch === "}" || ch === "]") break;
      if (ch === ":" && (isKey ? true : /\s/.test(this.src[this.pos + 1] ?? " "))) break;
      this.pos += 1;
    }
    return this.src.slice(start, this.pos).trim();
  }
}

function scalar(text: string): Json {
  if (text === "" || text === "null" || text === "~") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function parseValue(text: string, line: number): Json {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return new FlowParser(trimmed, line).parse();
  if (trimmed.startsWith("'") || trimmed.startsWith('"')) return new FlowParser(trimmed, line).parse();
  if (/^[|>]/.test(trimmed)) throw new Error(`YAML line ${line}: block scalars are not supported`);
  return scalar(trimmed);
}

/** Splits `key: value` (or `key:`) at the first key/value colon; returns null when the text is not a mapping entry. */
function splitEntry(text: string): { key: string; rest: string } | null {
  let key: string;
  let after: number;
  if (text[0] === "'" || text[0] === '"') {
    const quote = text[0];
    const end = text.indexOf(quote, 1);
    if (end < 0) return null;
    key = text.slice(1, end);
    after = end + 1;
  } else {
    const match = /^([^\s:{}[\],'"#][^:]*?):(\s|$)/.exec(text);
    if (!match) return null;
    key = match[1]!;
    after = match[1]!.length;
  }
  if (text[after] !== ":" || (after + 1 < text.length && !/\s/.test(text[after + 1]!))) return null;
  return { key, rest: text.slice(after + 1).trim() };
}

export function parseYaml(source: string): Json {
  const lines: Line[] = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    const text = stripComment(raw);
    if (!text.trim()) return;
    if (/\t/.test(text.slice(0, text.length - text.trimStart().length))) throw new Error(`YAML line ${index + 1}: tabs are not allowed`);
    lines.push({ indent: text.length - text.trimStart().length, text: text.trim(), no: index + 1 });
  });
  let pos = 0;

  function parseBlock(indent: number): Json {
    const first = lines[pos]!;
    if (first.text === "-" || first.text.startsWith("- ")) return parseSeq(indent);
    return parseMap(indent);
  }

  function parseMap(indent: number): Json {
    const result: Obj = {};
    while (pos < lines.length && lines[pos]!.indent === indent) {
      const line = lines[pos]!;
      if (line.text === "-" || line.text.startsWith("- ")) break;
      const entry = splitEntry(line.text);
      if (!entry) throw new Error(`YAML line ${line.no}: expected 'key: value': ${line.text}`);
      if (entry.key in result) throw new Error(`YAML line ${line.no}: duplicate key ${entry.key}`);
      pos += 1;
      if (entry.rest === "") {
        const next = lines[pos];
        if (next && next.indent > indent) result[entry.key] = parseBlock(next.indent);
        else if (next && next.indent === indent && (next.text === "-" || next.text.startsWith("- "))) result[entry.key] = parseSeq(indent);
        else result[entry.key] = null;
      } else {
        result[entry.key] = parseValue(entry.rest, line.no);
      }
    }
    return result;
  }

  function parseSeq(indent: number): Json {
    const result: Json[] = [];
    while (pos < lines.length && lines[pos]!.indent === indent && (lines[pos]!.text === "-" || lines[pos]!.text.startsWith("- "))) {
      const line = lines[pos]!;
      const rest = line.text === "-" ? "" : line.text.slice(2).trim();
      if (rest === "") {
        pos += 1;
        const next = lines[pos];
        result.push(next && next.indent > indent ? parseBlock(next.indent) : null);
      } else if (splitEntry(rest) && !/^[{['"]/.test(rest)) {
        // "- key: value" opens a mapping whose remaining keys align with the first.
        const childIndent = indent + 2;
        lines[pos] = { indent: childIndent, text: rest, no: line.no };
        result.push(parseMap(childIndent));
      } else {
        pos += 1;
        result.push(parseValue(rest, line.no));
      }
    }
    return result;
  }

  if (lines.length === 0) return null;
  const value = parseBlock(lines[0]!.indent);
  if (pos !== lines.length) throw new Error(`YAML line ${lines[pos]!.no}: unexpected indentation`);
  return value;
}

// ------------------------------------------------------------ JSON Schema subset

const ANNOTATION_KEYWORDS = new Set(["description", "default", "example", "examples", "title"]);
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OpenApiDocument = {
  paths: Record<string, Record<string, { responses?: Record<string, unknown>; [key: string]: unknown }>>;
  components: { schemas: Record<string, Json>; responses: Record<string, Json> };
};

function resolveRef(doc: OpenApiDocument, ref: string): Json {
  const match = /^#\/components\/(schemas|responses)\/([A-Za-z0-9_]+)$/.exec(ref);
  const found = match ? (doc.components[match[1] as "schemas" | "responses"] as Record<string, Json>)[match[2]!] : undefined;
  if (found === undefined) throw new Error(`Unresolvable $ref ${ref}`);
  return found;
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    default: throw new Error(`Unsupported schema type ${type}`);
  }
}

/** Returns a list of violations (empty when the value conforms to the schema). */
export function validateSchema(doc: OpenApiDocument, schema: Json, value: unknown, at = "$"): string[] {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) throw new Error(`Schema at ${at} is not an object`);
  const s = schema as Obj;
  if (typeof s.$ref === "string") return validateSchema(doc, resolveRef(doc, s.$ref), value, at);

  const errors: string[] = [];
  for (const keyword of Object.keys(s)) {
    if (ANNOTATION_KEYWORDS.has(keyword)) continue;
    switch (keyword) {
      case "type": {
        const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
        if (!types.some((type) => typeMatches(type, value))) errors.push(`${at}: expected ${types.join("|")}, got ${JSON.stringify(value)}`);
        break;
      }
      case "enum":
        if (!(s.enum as Json[]).some((option) => option === value)) errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(s.enum)}`);
        break;
      case "format":
        if (typeof value === "string") {
          if (s.format === "date-time" && !DATE_TIME.test(value)) errors.push(`${at}: ${JSON.stringify(value)} is not an RFC 3339 date-time`);
          else if (s.format === "uuid" && !UUID.test(value)) errors.push(`${at}: ${JSON.stringify(value)} is not a uuid`);
          else if (!["date-time", "uuid", "uri", "binary"].includes(String(s.format))) throw new Error(`Unsupported format ${String(s.format)}`);
        }
        break;
      case "required":
        if (typeMatches("object", value)) {
          for (const key of s.required as string[]) if (!(key in (value as object))) errors.push(`${at}: missing required property ${key}`);
        }
        break;
      case "properties":
        if (typeMatches("object", value)) {
          for (const [key, sub] of Object.entries(s.properties as Obj)) {
            const child = (value as Record<string, unknown>)[key];
            if (child !== undefined) errors.push(...validateSchema(doc, sub, child, `${at}.${key}`));
          }
        }
        break;
      case "additionalProperties":
        if (typeMatches("object", value)) {
          const declared = new Set(Object.keys((s.properties as Obj | undefined) ?? {}));
          for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            if (declared.has(key)) continue;
            if (s.additionalProperties === false) errors.push(`${at}: unexpected property ${key}`);
            else if (typeof s.additionalProperties === "object") errors.push(...validateSchema(doc, s.additionalProperties as Json, child, `${at}.${key}`));
          }
        }
        break;
      case "items":
        if (Array.isArray(value)) value.forEach((item, index) => errors.push(...validateSchema(doc, s.items as Json, item, `${at}[${index}]`)));
        break;
      case "allOf":
        for (const sub of s.allOf as Json[]) errors.push(...validateSchema(doc, sub, value, at));
        break;
      case "oneOf": {
        const passing = (s.oneOf as Json[]).filter((sub) => validateSchema(doc, sub, value, at).length === 0).length;
        if (passing !== 1) errors.push(`${at}: matches ${passing} oneOf branches, expected exactly 1`);
        break;
      }
      case "minimum": if (typeof value === "number" && value < (s.minimum as number)) errors.push(`${at}: below minimum ${String(s.minimum)}`); break;
      case "maximum": if (typeof value === "number" && value > (s.maximum as number)) errors.push(`${at}: above maximum ${String(s.maximum)}`); break;
      case "minLength": if (typeof value === "string" && value.length < (s.minLength as number)) errors.push(`${at}: shorter than ${String(s.minLength)}`); break;
      case "maxLength": if (typeof value === "string" && value.length > (s.maxLength as number)) errors.push(`${at}: longer than ${String(s.maxLength)}`); break;
      case "minItems": if (Array.isArray(value) && value.length < (s.minItems as number)) errors.push(`${at}: fewer than ${String(s.minItems)} items`); break;
      default:
        throw new Error(`Unsupported JSON Schema keyword "${keyword}" at ${at}; extend src/lib/server/test-support/openapi-support.ts`);
    }
  }
  return errors;
}

/** The JSON response schema documented for `method path` with `status`, following a shared $ref if needed. */
export function responseSchema(doc: OpenApiDocument, path: string, method: string, status: number): Json {
  const operation = doc.paths[path]?.[method];
  if (!operation) throw new Error(`Spec has no ${method.toUpperCase()} ${path}`);
  let response = (operation.responses ?? {})[String(status)] as Json | undefined;
  if (response === undefined) throw new Error(`Spec documents no ${status} response for ${method.toUpperCase()} ${path}`);
  if (typeof response === "object" && response !== null && !Array.isArray(response) && typeof (response as Obj).$ref === "string") {
    response = resolveRef(doc, (response as Obj).$ref as string);
  }
  const content = ((response as Obj).content as Obj | undefined)?.["application/json"] as Obj | undefined;
  if (!content?.schema) throw new Error(`Spec response ${status} for ${method.toUpperCase()} ${path} has no application/json schema`);
  return content.schema;
}
