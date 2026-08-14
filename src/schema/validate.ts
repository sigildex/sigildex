import { TextDecoder } from "node:util";
import { computeRootDigest, compareUtf8, type ManifestEntry } from "../identity/canonical.js";
import { FILE_CLASSES } from "../identity/classify.js";
import { equivalenceKey } from "../identity/unicode-15-1.js";
import { validateRecordedPath } from "../identity/walk.js";
import type { JsonValue, SkillMetadata } from "../identity/frontmatter.js";

export const LIMITATIONS = "This record attests the byte identity of the listed files at lock time only. It does not attest safety, provenance, or future content.";

export interface DeclaredSource {
  kind?: string;
  repository?: string;
  path?: string;
  approved_commit?: string;
  tracking_policy?: string;
  verification: "user_supplied";
}

export interface ApprovalRecord {
  schema_version: 1;
  spec_version: 1;
  tool_version: string;
  approval_id: string;
  artifact_path: string;
  root_digest: string;
  files: ManifestEntry[];
  skill: SkillMetadata;
  created_at: string;
  declared_source?: DeclaredSource;
  limitations: typeof LIMITATIONS;
}

export type ValidationStep = "syntax" | "versions" | "shape" | "manifest_integrity" | "internal_consistency";

export type ValidationResult =
  | { ok: true; record: ApprovalRecord }
  | { ok: false; step: ValidationStep; message: string };

class JsonNumber {
  constructor(readonly raw: string) {}
}

class JsonScanError extends Error {}

class DuplicateKeyJsonParser {
  private position = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.position !== this.source.length) throw new JsonScanError("Trailing content after JSON value");
    return value;
  }

  private skipWhitespace(): void {
    while (/^[\t\n\r ]$/.test(this.source[this.position] ?? "")) this.position += 1;
  }

  private parseValue(): unknown {
    this.skipWhitespace();
    const current = this.source[this.position];
    if (current === "{") return this.parseObject();
    if (current === "[") return this.parseArray();
    if (current === '"') return this.parseString();
    if (current === "t" && this.source.slice(this.position, this.position + 4) === "true") {
      this.position += 4; return true;
    }
    if (current === "f" && this.source.slice(this.position, this.position + 5) === "false") {
      this.position += 5; return false;
    }
    if (current === "n" && this.source.slice(this.position, this.position + 4) === "null") {
      this.position += 4; return null;
    }
    return this.parseNumber();
  }

  private parseObject(): Record<string, unknown> {
    this.position += 1;
    this.skipWhitespace();
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    if (this.source[this.position] === "}") { this.position += 1; return result; }
    for (;;) {
      if (this.source[this.position] !== '"') throw new JsonScanError("Object key must be a JSON string");
      const key = this.parseString();
      if (keys.has(key)) throw new JsonScanError(`Duplicate JSON key: ${key}`);
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.position] !== ":") throw new JsonScanError("Missing colon after object key");
      this.position += 1;
      result[key] = this.parseValue();
      this.skipWhitespace();
      const separator = this.source[this.position];
      if (separator === "}") { this.position += 1; return result; }
      if (separator !== ",") throw new JsonScanError("Missing comma between object properties");
      this.position += 1;
      this.skipWhitespace();
    }
  }

  private parseArray(): unknown[] {
    this.position += 1;
    this.skipWhitespace();
    const result: unknown[] = [];
    if (this.source[this.position] === "]") { this.position += 1; return result; }
    for (;;) {
      result.push(this.parseValue());
      this.skipWhitespace();
      const separator = this.source[this.position];
      if (separator === "]") { this.position += 1; return result; }
      if (separator !== ",") throw new JsonScanError("Missing comma between array elements");
      this.position += 1;
    }
  }

  private parseString(): string {
    const start = this.position;
    this.position += 1;
    for (;;) {
      const character = this.source[this.position];
      if (character === undefined) throw new JsonScanError("Unterminated JSON string");
      const code = character.charCodeAt(0);
      if (code < 0x20) throw new JsonScanError("Unescaped control character in JSON string");
      if (character === '"') {
        this.position += 1;
        try {
          return JSON.parse(this.source.slice(start, this.position)) as string;
        } catch {
          throw new JsonScanError("Invalid JSON string escape");
        }
      }
      if (character === "\\") {
        this.position += 1;
        const escape = this.source[this.position];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(this.source.slice(this.position + 1, this.position + 5))) {
            throw new JsonScanError("Invalid Unicode escape in JSON string");
          }
          this.position += 5;
          continue;
        }
        if (escape === undefined || !'"\\/bfnrt'.includes(escape)) throw new JsonScanError("Invalid JSON string escape");
      }
      this.position += 1;
    }
  }

  private parseNumber(): JsonNumber {
    const remainder = this.source.slice(this.position);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(remainder);
    if (match === null) throw new JsonScanError("Invalid JSON value");
    this.position += match[0].length;
    return new JsonNumber(match[0]);
  }
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key)) &&
    keys.length === required.length + optional.filter((key) => keys.includes(key)).length;
}

function objectValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof JsonNumber);
}

function exactInteger(value: unknown): bigint | null {
  if (!(value instanceof JsonNumber)) return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value.raw)!;
  const negative = match[1] === "-";
  let digits = `${match[2]}${match[3] ?? ""}`.replace(/^0+(?=\d)/, "");
  const scale = (match[3]?.length ?? 0) - Number(match[4] ?? 0);
  if (!Number.isSafeInteger(scale)) return null;
  if (scale > 0) {
    if (scale > digits.length) return /^0+$/.test(digits) ? 0n : null;
    const discarded = digits.slice(digits.length - scale);
    if (!/^0*$/.test(discarded)) return null;
    digits = digits.slice(0, digits.length - scale) || "0";
  } else if (scale < 0) {
    if (-scale > 1_000_000) return null;
    digits += "0".repeat(-scale);
  }
  const integer = BigInt(digits);
  return negative ? -integer : integer;
}

function jsonData(value: unknown): JsonValue | null | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (value instanceof JsonNumber) {
    const number = Number(value.raw);
    return Number.isFinite(number) ? number : undefined;
  }
  if (Array.isArray(value)) {
    const entries: JsonValue[] = [];
    for (const item of value) {
      const converted = jsonData(item);
      if (converted === undefined) return undefined;
      entries.push(converted);
    }
    return entries;
  }
  if (objectValue(value)) {
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, item] of Object.entries(value)) {
      const converted = jsonData(item);
      if (converted === undefined) return undefined;
      result[key] = converted;
    }
    return result;
  }
  return undefined;
}

function validateSkill(value: unknown): SkillMetadata | null {
  if (!objectValue(value) || !exactKeys(value, ["frontmatter_status", "frontmatter"])) return null;
  const status = value.frontmatter_status;
  if (status === "ok") {
    if (!objectValue(value.frontmatter)) return null;
    const data = jsonData(value.frontmatter);
    if (data === undefined || data === null || Array.isArray(data) || typeof data !== "object") return null;
    return { frontmatter_status: "ok", frontmatter: data };
  }
  if ((status === "missing" || status === "invalid") && value.frontmatter === null) {
    return { frontmatter_status: status, frontmatter: null };
  }
  return null;
}

function validateDeclaredSource(value: unknown): DeclaredSource | null {
  const allowed = ["kind", "repository", "path", "approved_commit", "tracking_policy", "verification"];
  if (!objectValue(value) || !exactKeys(value, ["verification"], allowed.filter((key) => key !== "verification"))) return null;
  if (value.verification !== "user_supplied") return null;
  if (value.kind !== undefined && (typeof value.kind !== "string" || !/^[a-z0-9-]{1,32}$/.test(value.kind))) return null;
  if (value.repository !== undefined && (typeof value.repository !== "string" || Buffer.byteLength(value.repository) > 512)) return null;
  if (value.path !== undefined && (typeof value.path !== "string" || validateRecordedPath(value.path, true) !== null)) return null;
  if (value.approved_commit !== undefined && (typeof value.approved_commit !== "string" || !/^[0-9a-f]{7,64}$/.test(value.approved_commit))) return null;
  if (value.tracking_policy !== undefined && (typeof value.tracking_policy !== "string" || Buffer.byteLength(value.tracking_policy) > 128)) return null;
  return value as unknown as DeclaredSource;
}

function manifestCollision(manifest: readonly ManifestEntry[]): readonly [string, string] | null {
  const byDirectory = new Map<string, Map<string, string>>();
  for (const file of manifest) {
    const components = file.path.split("/");
    let parent = "";
    for (const component of components) {
      let entries = byDirectory.get(parent);
      if (entries === undefined) { entries = new Map(); byDirectory.set(parent, entries); }
      const key = equivalenceKey(component);
      const prior = entries.get(key);
      const full = parent ? `${parent}/${component}` : component;
      if (prior !== undefined && prior !== component) {
        const priorFull = parent ? `${parent}/${prior}` : prior;
        return [priorFull, full];
      }
      entries.set(key, component);
      parent = full;
    }
  }
  return null;
}

export function validateApprovalRecord(bytes: Uint8Array | string): ValidationResult {
  try {
    let source: string;
    try {
      if (typeof bytes === "string") {
        source = bytes;
      } else {
        if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
          return { ok: false, step: "syntax", message: "Approval record must not contain a UTF-8 BOM" };
        }
        source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      }
      if (source.charCodeAt(0) === 0xfeff) {
        return { ok: false, step: "syntax", message: "Approval record must not contain a UTF-8 BOM" };
      }
    } catch {
      return { ok: false, step: "syntax", message: "Approval record is not valid UTF-8" };
    }
    let parsed: unknown;
    try {
      parsed = new DuplicateKeyJsonParser(source).parse();
    } catch (error) {
      return { ok: false, step: "syntax", message: error instanceof Error ? error.message : "Invalid JSON" };
    }
    if (!objectValue(parsed)) return { ok: false, step: "syntax", message: "Top-level JSON value must be an object" };

    if (exactInteger(parsed.schema_version) !== 1n || exactInteger(parsed.spec_version) !== 1n) {
      return { ok: false, step: "versions", message: "Unsupported schema_version or spec_version" };
    }

    const topRequired = [
      "schema_version", "spec_version", "tool_version", "approval_id", "artifact_path", "root_digest",
      "files", "skill", "created_at", "limitations",
    ];
    if (!exactKeys(parsed, topRequired, ["declared_source"])) {
      return { ok: false, step: "shape", message: "Approval record has missing or unknown top-level keys" };
    }
    if (typeof parsed.tool_version !== "string" || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(parsed.tool_version) ||
        typeof parsed.approval_id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(parsed.approval_id) ||
        typeof parsed.artifact_path !== "string" || validateRecordedPath(parsed.artifact_path, true) !== null ||
        typeof parsed.root_digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(parsed.root_digest) ||
        typeof parsed.created_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(parsed.created_at) ||
        parsed.limitations !== LIMITATIONS || !Array.isArray(parsed.files)) {
      return { ok: false, step: "shape", message: "Approval record field type or grammar is invalid" };
    }
    const skill = validateSkill(parsed.skill);
    if (skill === null) return { ok: false, step: "shape", message: "skill has an invalid shape or status" };
    let declaredSource: DeclaredSource | undefined;
    if (parsed.declared_source !== undefined) {
      const validatedSource = validateDeclaredSource(parsed.declared_source);
      if (validatedSource === null) {
        return { ok: false, step: "shape", message: "declared_source is invalid" };
      }
      declaredSource = validatedSource;
    }

    const manifest: ManifestEntry[] = [];
    for (const value of parsed.files) {
      if (!objectValue(value) || !exactKeys(value, ["path", "sha256", "size", "executable", "class"]) ||
          typeof value.path !== "string" || validateRecordedPath(value.path) !== null ||
          typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256) ||
          typeof value.executable !== "boolean" || typeof value.class !== "string" ||
          !(FILE_CLASSES as readonly string[]).includes(value.class)) {
        return { ok: false, step: "shape", message: "files[] entry is invalid" };
      }
      const size = exactInteger(value.size);
      if (size === null || size < 0n) return { ok: false, step: "shape", message: "File size must be a non-negative integer" };
      manifest.push({
        path: value.path,
        sha256: value.sha256,
        size: size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(size) : size,
        executable: value.executable,
        class: value.class as ManifestEntry["class"],
      });
    }

    for (let index = 1; index < manifest.length; index += 1) {
      const order = compareUtf8(manifest[index - 1]!.path, manifest[index]!.path);
      if (order >= 0) {
        return { ok: false, step: "manifest_integrity", message: order === 0 ? "Duplicate manifest path" : "Manifest is not byte-wise sorted" };
      }
    }
    const collision = manifestCollision(manifest);
    if (collision !== null) {
      return { ok: false, step: "manifest_integrity", message: `Manifest path collision: ${collision[0]} and ${collision[1]}` };
    }

    if (computeRootDigest(manifest) !== parsed.root_digest) {
      return { ok: false, step: "internal_consistency", message: "root_digest does not match files[]" };
    }
    const record: ApprovalRecord = {
      schema_version: 1,
      spec_version: 1,
      tool_version: parsed.tool_version,
      approval_id: parsed.approval_id,
      artifact_path: parsed.artifact_path,
      root_digest: parsed.root_digest,
      files: manifest,
      skill,
      created_at: parsed.created_at,
      ...(declaredSource === undefined ? {} : { declared_source: declaredSource }),
      limitations: LIMITATIONS,
    };
    return { ok: true, record };
  } catch (error) {
    return { ok: false, step: "syntax", message: error instanceof Error ? error.message : "Unexpected validation failure" };
  }
}
