import { open } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { parseDocument } from "yaml";

export const MAX_FRONTMATTER_BYTES = 262_144;
export const MAX_FRONTMATTER_ALIASES = 20;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type SkillMetadata =
  | { frontmatter_status: "ok"; frontmatter: Record<string, JsonValue> }
  | { frontmatter_status: "missing" | "invalid"; frontmatter: null };

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, seen))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.entries(value as Record<string, unknown>).every(([key, entry]) =>
        typeof key === "string" && isJsonValue(entry, seen));
  seen.delete(value);
  return valid;
}

function extractBlock(bytes: Buffer): { kind: "missing" } | { kind: "invalid" } | { kind: "block"; bytes: Buffer } {
  let openingLength: number;
  if (bytes.subarray(0, 4).equals(Buffer.from("---\n"))) openingLength = 4;
  else if (bytes.subarray(0, 5).equals(Buffer.from("---\r\n"))) openingLength = 5;
  else if (bytes.equals(Buffer.from("---")) || bytes.subarray(0, 4).equals(Buffer.from("---\r"))) {
    return { kind: "invalid" };
  }
  else return { kind: "missing" };

  let lineStart = openingLength;
  while (lineStart <= bytes.length) {
    const lineFeed = bytes.indexOf(0x0a, lineStart);
    const lineEnd = lineFeed === -1 ? bytes.length : lineFeed;
    let contentEnd = lineEnd;
    if (contentEnd > lineStart && bytes[contentEnd - 1] === 0x0d) contentEnd -= 1;
    if (bytes.subarray(lineStart, contentEnd).equals(Buffer.from("---"))) {
      return { kind: "block", bytes: bytes.subarray(openingLength, lineStart) };
    }
    if (lineFeed === -1) break;
    lineStart = lineFeed + 1;
  }
  return { kind: "invalid" };
}

export async function readSkillFrontmatter(skillMdPath: string): Promise<SkillMetadata> {
  let handle;
  try {
    handle = await open(skillMdPath, "r");
    const chunks: Buffer[] = [];
    let read = 0;
    const scanLimit = MAX_FRONTMATTER_BYTES + 16;
    while (read <= scanLimit) {
      const chunk = Buffer.allocUnsafe(Math.min(16_384, scanLimit + 1 - read));
      const result = await handle.read(chunk, 0, chunk.length, read);
      if (result.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, result.bytesRead));
      read += result.bytesRead;
      const candidate = extractBlock(Buffer.concat(chunks));
      if (candidate.kind === "block" || candidate.kind === "missing") break;
    }
    const extraction = extractBlock(Buffer.concat(chunks));
    if (extraction.kind === "missing") return { frontmatter_status: "missing", frontmatter: null };
    if (extraction.kind === "invalid" || extraction.bytes.length > MAX_FRONTMATTER_BYTES) {
      return { frontmatter_status: "invalid", frontmatter: null };
    }
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(extraction.bytes);
    } catch {
      return { frontmatter_status: "invalid", frontmatter: null };
    }
    const document = parseDocument(source, {
      schema: "core",
      customTags: [],
      resolveKnownTags: false,
      merge: false,
      strict: true,
      uniqueKeys: true,
      stringKeys: true,
      logLevel: "silent",
    });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      return { frontmatter_status: "invalid", frontmatter: null };
    }
    const value: unknown = document.toJS({ maxAliasCount: MAX_FRONTMATTER_ALIASES });
    if (value === null || Array.isArray(value) || typeof value !== "object" || !isJsonValue(value)) {
      return { frontmatter_status: "invalid", frontmatter: null };
    }
    const mapping = value as Record<string, JsonValue>;
    for (const scalarKey of ["name", "description"]) {
      const field = mapping[scalarKey];
      if (field !== undefined && typeof field === "object") {
        return { frontmatter_status: "invalid", frontmatter: null };
      }
    }
    return { frontmatter_status: "ok", frontmatter: mapping };
  } catch {
    return { frontmatter_status: "invalid", frontmatter: null };
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
}
