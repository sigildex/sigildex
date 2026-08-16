import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { parseDocument } from "yaml";

export const MAX_FRONTMATTER_BYTES = 262_144;
export const MAX_FRONTMATTER_ALIASES = 20;

/** Bytes pulled per read. The extraction rules must not depend on this value. */
const READ_CHUNK_BYTES = 16_384;

/**
 * The file is opened under the same discipline as the walk: symlinks are never
 * followed, and O_NONBLOCK keeps the open from parking indefinitely on a FIFO
 * left at the path — it returns, and the descriptor check rejects it.
 */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

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

type Extraction =
  | { kind: "missing" | "invalid" | "incomplete" }
  | { kind: "block"; bytes: Buffer };

/** True when the bytes from `lineStart` up to `lineEnd` are exactly a `---` delimiter. */
function isDelimiterLine(bytes: Buffer, lineStart: number, lineEnd: number): boolean {
  const contentEnd = lineEnd > lineStart && bytes[lineEnd - 1] === 0x0d ? lineEnd - 1 : lineEnd;
  return bytes.subarray(lineStart, contentEnd).equals(Buffer.from("---"));
}

/**
 * Locates the frontmatter block in a prefix of the file.
 *
 * `atEof` separates "this buffer ends here" from "the file ends here". Only at end
 * of file may an unterminated final line be read as a delimiter — otherwise a read
 * boundary landing inside a `----` line would present it as a closing `---` and
 * yield a truncated block, making the outcome depend on how reads were split
 * (§8.4). Short of end of file such a prefix is reported as `incomplete`, and the
 * caller reads more bytes.
 */
function extractBlock(bytes: Buffer, atEof: boolean): Extraction {
  let openingLength: number;
  if (bytes.subarray(0, 4).equals(Buffer.from("---\n"))) openingLength = 4;
  else if (bytes.subarray(0, 5).equals(Buffer.from("---\r\n"))) openingLength = 5;
  else if (!atEof && bytes.length < 5) return { kind: "incomplete" };
  else if (bytes.equals(Buffer.from("---")) || bytes.subarray(0, 4).equals(Buffer.from("---\r"))) {
    return { kind: "invalid" };
  }
  else return { kind: "missing" };

  let lineStart = openingLength;
  for (;;) {
    const lineFeed = bytes.indexOf(0x0a, lineStart);
    if (lineFeed === -1) {
      if (!atEof) return { kind: "incomplete" };
      return isDelimiterLine(bytes, lineStart, bytes.length)
        ? { kind: "block", bytes: bytes.subarray(openingLength, lineStart) }
        : { kind: "invalid" };
    }
    if (isDelimiterLine(bytes, lineStart, lineFeed)) {
      return { kind: "block", bytes: bytes.subarray(openingLength, lineStart) };
    }
    lineStart = lineFeed + 1;
  }
}

/**
 * Reads up to the scan window, stopping as soon as the outcome is decided. Rejects
 * when the path cannot be read as a regular file: a status must describe bytes that
 * were actually observed, never stand in for bytes that could not be read.
 */
async function readFrontmatterWindow(path: string): Promise<{ bytes: Buffer; atEof: boolean }> {
  const handle = await open(path, OPEN_FLAGS);
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`${path} is not a regular file`);
    const chunks: Buffer[] = [];
    const scanLimit = MAX_FRONTMATTER_BYTES + 16;
    let read = 0;
    let atEof = false;
    while (read <= scanLimit) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, scanLimit + 1 - read));
      const result = await handle.read(chunk, 0, chunk.length, read);
      if (result.bytesRead === 0) {
        atEof = true;
        break;
      }
      chunks.push(chunk.subarray(0, result.bytesRead));
      read += result.bytesRead;
      const candidate = extractBlock(Buffer.concat(chunks), false);
      if (candidate.kind === "block" || candidate.kind === "missing") break;
    }
    return { bytes: Buffer.concat(chunks), atEof };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Reads the frontmatter of a `SKILL.md`.
 *
 * Two outcome classes, deliberately kept apart. Bytes that were read but do not
 * form a valid block are reported as `missing` or `invalid` — §10.3 keeps that
 * out of the failure path, since byte identity is unaffected. A path that cannot
 * be read as a regular file is the other class: it rejects, and the caller
 * surfaces that as a tool error (exit 1) rather than recording a status for
 * bytes it never saw.
 */
export async function readSkillFrontmatter(skillMdPath: string): Promise<SkillMetadata> {
  const { bytes, atEof } = await readFrontmatterWindow(skillMdPath);
  const extraction = extractBlock(bytes, atEof);
  if (extraction.kind === "missing") return { frontmatter_status: "missing", frontmatter: null };
  if (extraction.kind !== "block" || extraction.bytes.length > MAX_FRONTMATTER_BYTES) {
    return { frontmatter_status: "invalid", frontmatter: null };
  }
  return parseFrontmatterBlock(extraction.bytes);
}

/** §10.4: parsing is bounded and total — every failure mode becomes `invalid`, never a crash. */
function parseFrontmatterBlock(block: Buffer): SkillMetadata {
  try {
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(block);
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
      // Null is a YAML scalar; only collections are the non-scalar values §10.2 rejects.
      if (field !== undefined && field !== null && typeof field === "object") {
        return { frontmatter_status: "invalid", frontmatter: null };
      }
    }
    return { frontmatter_status: "ok", frontmatter: mapping };
  } catch {
    return { frontmatter_status: "invalid", frontmatter: null };
  }
}
