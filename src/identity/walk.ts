import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { classifyFile } from "./classify.js";
import { compareUtf8, computeRootDigest, type ManifestEntry } from "./canonical.js";
import { equivalenceKey, isAssignedUnicode15_1 } from "./unicode-15-1.js";

export const WALK_LIMITS = Object.freeze({
  maxFiles: 4_096,
  maxDirectories: 4_096,
  maxEntries: 65_536,
  maxFileBytes: 67_108_864,
  maxTotalBytes: 268_435_456,
  maxDepth: 64,
  maxPathBytes: 1_024,
  maxNameBytes: 255,
});

export type WalkFailureRule =
  | "root"
  | "entry_type"
  | "read"
  | "mutation"
  | "name"
  | "path"
  | "collision"
  | "limit"
  | "tool";

export interface WalkFailure {
  ok: false;
  rule: WalkFailureRule;
  path?: string;
  paths?: readonly [string, string];
  limit?: keyof typeof WALK_LIMITS;
  message: string;
}

export interface WalkSuccess {
  ok: true;
  root: string;
  manifest: ManifestEntry[];
  rootDigest: string;
}

export type WalkResult = WalkSuccess | WalkFailure;

export interface WalkHooks {
  /** Test seam invoked after pass 1 and before any pass-2 observation. */
  afterPass1?: () => void | Promise<void>;
  /** Test seam invoked between an in-scope file's `lstat` and its `open`. */
  beforeFileOpen?: (recordedPath: string) => void | Promise<void>;
  /** Test seam invoked after each descriptor read, with bytes hashed for that file. */
  afterFileChunk?: (recordedPath: string, hashedBytes: number) => void | Promise<void>;
}

export interface WalkOptions {
  hooks?: WalkHooks;
}

interface IdentityStat {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mode: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface DirectorySnapshot {
  absolute: Buffer;
  recordedPath: string;
  identity: Pick<IdentityStat, "dev" | "ino">;
  entries: Buffer[];
}

interface FileSnapshot {
  absolute: Buffer;
  recordedPath: string;
  identity: IdentityStat;
}

/** An entry with an excluded name (§3.2): pruned from the manifest, still observed. */
interface ExcludedSnapshot {
  absolute: Buffer;
  recordedPath: string;
  isDirectory: boolean;
  identity: Pick<IdentityStat, "dev" | "ino">;
}

class ExpectedWalkFailure extends Error {
  constructor(readonly failure: WalkFailure) {
    super(failure.message);
  }
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function fail(
  rule: WalkFailureRule,
  message: string,
  details: Pick<WalkFailure, "path" | "paths" | "limit"> = {},
): never {
  throw new ExpectedWalkFailure({ ok: false, rule, message, ...details });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function displayPath(path: string): string {
  return path === "" ? "." : path;
}

function joinAbsolute(parent: Buffer, name: Buffer): Buffer {
  return Buffer.concat([parent, Buffer.from("/"), name]);
}

function decodeAndValidateName(nameBytes: Buffer, parentPath: string, maxNameBytes: number): string {
  const fallback = `${parentPath ? `${parentPath}/` : ""}<bytes:${nameBytes.toString("hex")}>`;
  if (nameBytes.length > maxNameBytes) {
    fail("limit", `Name component exceeds ${maxNameBytes} UTF-8 bytes: ${fallback}`, {
      path: fallback,
      limit: "maxNameBytes",
    });
  }
  let name: string;
  try {
    name = utf8Decoder.decode(nameBytes);
  } catch {
    fail("name", `Directory entry name is not valid UTF-8: ${fallback}`, { path: fallback });
  }
  for (const character of name) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      fail("name", `Directory entry name contains a control character: ${fallback}`, { path: fallback });
    }
    if (!isAssignedUnicode15_1(codePoint)) {
      fail("name", `Directory entry name contains a code point unassigned in Unicode 15.1: ${fallback}`, {
        path: fallback,
      });
    }
  }
  return name;
}

export function validateRecordedPath(recordedPath: string, allowDot = false): string | null {
  if (allowDot && recordedPath === ".") return null;
  const bytes = Buffer.from(recordedPath, "utf8");
  if (recordedPath.length === 0 || recordedPath.startsWith("/") || recordedPath.startsWith("./") ||
      recordedPath.endsWith("/") || recordedPath.includes("//")) return "path is not in relative POSIX form";
  const components = recordedPath.split("/");
  if (components.some((component) => component === "." || component === ".." || component.length === 0)) {
    return "path contains a forbidden component";
  }
  if (bytes.length > WALK_LIMITS.maxPathBytes) return "path exceeds 1024 UTF-8 bytes";
  for (const component of components) {
    const componentBytes = Buffer.from(component, "utf8");
    if (componentBytes.length > WALK_LIMITS.maxNameBytes) return "path component exceeds 255 UTF-8 bytes";
    for (const character of component) {
      const codePoint = character.codePointAt(0)!;
      if (codePoint <= 0x1f || codePoint === 0x7f) return "path contains a control character";
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) return "path is not valid UTF-8";
      if (!isAssignedUnicode15_1(codePoint)) return "path contains a code point unassigned in Unicode 15.1";
    }
  }
  return null;
}

function statIdentity(stats: Awaited<ReturnType<typeof lstat>> & { mtimeNs?: bigint }): IdentityStat {
  const bigintStats = stats as unknown as {
    dev: bigint; ino: bigint; size: bigint; mode: bigint; mtimeNs: bigint; ctimeNs: bigint;
  };
  return {
    dev: bigintStats.dev,
    ino: bigintStats.ino,
    size: bigintStats.size,
    mode: bigintStats.mode,
    mtimeNs: bigintStats.mtimeNs,
    ctimeNs: bigintStats.ctimeNs,
  };
}

function sameDirectoryIdentity(stats: { dev: bigint; ino: bigint }, expected: Pick<IdentityStat, "dev" | "ino">): boolean {
  return stats.dev === expected.dev && stats.ino === expected.ino;
}

function sameFileIdentity(actual: IdentityStat, expected: IdentityStat): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino && actual.size === expected.size &&
    actual.mtimeNs === expected.mtimeNs && actual.ctimeNs === expected.ctimeNs;
}

async function lstatBigint(absolute: Buffer) {
  return lstat(absolute, { bigint: true });
}

async function readEntryNames(absolute: Buffer): Promise<Buffer[]> {
  const names = await readdir(absolute, { encoding: "buffer" });
  return (names as Buffer[]).sort(Buffer.compare);
}

function equalEntryLists(left: readonly Buffer[], right: readonly Buffer[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry.equals(right[index]!));
}

/**
 * Pass-2 observation for an excluded entry (§3.2). Exclusion prunes what is *beneath*
 * the entry, never the entry itself: pass 1 type-validates it before pruning, and this
 * re-observation closes the window in which a verified `.git`/`.sigildex` directory or
 * file is swapped for a symlink or special file afterwards. The parent's entry-name list
 * is identical across such a swap, so only the entry's own type and `(dev, inode)` can
 * see it. Contents beneath an excluded entry are out of scope and are not compared.
 */
async function verifyExcludedEntry(entry: ExcludedSnapshot): Promise<void> {
  const named = entry.recordedPath;
  let current;
  try {
    current = await lstatBigint(entry.absolute);
  } catch (error) {
    fail("read", `Cannot re-verify excluded entry ${named}: ${errorText(error)}`, { path: named });
  }
  if (current.isSymbolicLink()) {
    fail("mutation", `Excluded entry became a symlink: ${named}`, { path: named });
  }
  if (!current.isFile() && !current.isDirectory()) {
    fail("mutation", `Excluded entry became a special file: ${named}`, { path: named });
  }
  if (current.isDirectory() !== entry.isDirectory) {
    fail("mutation", `Excluded entry changed type: ${named}`, { path: named });
  }
  if (current.dev !== entry.identity.dev || current.ino !== entry.identity.ino) {
    fail("mutation", `Excluded entry identity changed: ${named}`, { path: named });
  }
}

async function walkSkillInternal(
  skillRoot: string,
  options: WalkOptions,
  lowerTestLimits?: Partial<typeof WALK_LIMITS>,
): Promise<WalkResult> {
  const limits = Object.fromEntries(
    Object.entries(WALK_LIMITS).map(([name, value]) => [
      name,
      Math.min(value, lowerTestLimits?.[name as keyof typeof WALK_LIMITS] ?? value),
    ]),
  ) as unknown as typeof WALK_LIMITS;
  try {
    let resolvedRoot: string;
    try {
      resolvedRoot = await realpath(skillRoot);
    } catch (error) {
      fail("root", `Cannot resolve skill root: ${errorText(error)}`, { path: skillRoot });
    }
    const rootAbsolute = Buffer.from(resolvedRoot);
    let rootStats;
    try {
      rootStats = await lstatBigint(rootAbsolute);
    } catch (error) {
      fail("root", `Cannot read skill root: ${errorText(error)}`, { path: resolvedRoot });
    }
    if (!rootStats.isDirectory()) fail("root", "Skill root is not a directory", { path: resolvedRoot });

    const directories: DirectorySnapshot[] = [];
    const files: FileSnapshot[] = [];
    const excluded: ExcludedSnapshot[] = [];
    const manifest: ManifestEntry[] = [];
    let directoryCount = 0;
    let entryCount = 0;
    let fileCount = 0;
    let totalHashedBytes = 0;

    const enumerate = async (absolute: Buffer, recordedPath: string, depth: number): Promise<void> => {
      if (depth > limits.maxDepth) {
        fail("limit", `Directory depth exceeds ${limits.maxDepth}: ${displayPath(recordedPath)}`, {
          path: displayPath(recordedPath), limit: "maxDepth",
        });
      }
      if (directoryCount >= limits.maxDirectories) {
        fail("limit", `Traversed-directory limit exceeded at ${displayPath(recordedPath)}`, {
          path: displayPath(recordedPath), limit: "maxDirectories",
        });
      }
      directoryCount += 1;
      let directoryStats;
      let entryNames;
      try {
        directoryStats = await lstatBigint(absolute);
        if (!directoryStats.isDirectory()) fail("mutation", `Directory changed type: ${displayPath(recordedPath)}`, { path: displayPath(recordedPath) });
        entryNames = await readEntryNames(absolute);
      } catch (error) {
        if (error instanceof ExpectedWalkFailure) throw error;
        fail("read", `Cannot enumerate directory ${displayPath(recordedPath)}: ${errorText(error)}`, { path: displayPath(recordedPath) });
      }
      const directoryIdentity = statIdentity(directoryStats);
      directories.push({
        absolute,
        recordedPath,
        identity: { dev: directoryIdentity.dev, ino: directoryIdentity.ino },
        entries: entryNames,
      });

      const equivalences = new Map<string, string>();
      for (const nameBytes of entryNames) {
        if (entryCount >= limits.maxEntries) {
          fail("limit", `Traversal-entry limit exceeded in ${displayPath(recordedPath)}`, {
            path: displayPath(recordedPath), limit: "maxEntries",
          });
        }
        entryCount += 1;
        const absoluteEntry = joinAbsolute(absolute, nameBytes);
        let entryStats;
        try {
          entryStats = await lstatBigint(absoluteEntry);
        } catch (error) {
          fail("read", `Cannot lstat entry under ${displayPath(recordedPath)}: ${errorText(error)}`, { path: displayPath(recordedPath) });
        }
        const name = decodeAndValidateName(nameBytes, recordedPath, limits.maxNameBytes);
        const entryPath = recordedPath ? `${recordedPath}/${name}` : name;
        if (entryStats.isSymbolicLink()) fail("entry_type", `Symlink is forbidden: ${entryPath}`, { path: entryPath });
        if (!entryStats.isFile() && !entryStats.isDirectory()) {
          fail("entry_type", `Special file is forbidden: ${entryPath}`, { path: entryPath });
        }
        const key = equivalenceKey(name);
        const prior = equivalences.get(key);
        if (prior !== undefined && prior !== name) {
          const priorPath = recordedPath ? `${recordedPath}/${prior}` : prior;
          fail("collision", `Ambiguous directory-entry names: ${priorPath} and ${entryPath}`, {
            path: entryPath, paths: [priorPath, entryPath],
          });
        }
        equivalences.set(key, name);

        if (name === ".git" || name === ".sigildex") {
          excluded.push({
            absolute: absoluteEntry,
            recordedPath: entryPath,
            isDirectory: entryStats.isDirectory(),
            identity: { dev: entryStats.dev, ino: entryStats.ino },
          });
          continue;
        }
        if (entryStats.isDirectory()) {
          await enumerate(absoluteEntry, entryPath, depth + 1);
          continue;
        }
        if (fileCount >= limits.maxFiles) {
          fail("limit", `In-scope file limit exceeded at ${entryPath}`, { path: entryPath, limit: "maxFiles" });
        }
        fileCount += 1;
        const recordedPathError = validateRecordedPath(entryPath);
        if (recordedPathError !== null || Buffer.byteLength(entryPath) > limits.maxPathBytes) {
          fail(recordedPathError?.includes("exceeds") ? "limit" : "path", `${recordedPathError ?? "path exceeds limit"}: ${entryPath}`, {
            path: entryPath,
            ...(Buffer.byteLength(entryPath) > limits.maxPathBytes ? { limit: "maxPathBytes" as const } : {}),
          });
        }
        if (entryStats.size > BigInt(limits.maxFileBytes)) {
          fail("limit", `Single-file byte limit exceeded: ${entryPath}`, { path: entryPath, limit: "maxFileBytes" });
        }

        if (options.hooks?.beforeFileOpen !== undefined) await options.hooks.beforeFileOpen(entryPath);
        let handle;
        try {
          // O_NONBLOCK is inert for a regular file and is what keeps the open from parking
          // on a FIFO swapped in after the lstat: it returns, and the fstat below rejects it.
          handle = await open(absoluteEntry, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const descriptorStats = await handle.stat({ bigint: true });
          if (!descriptorStats.isFile()) fail("mutation", `Opened entry is no longer a regular file: ${entryPath}`, { path: entryPath });
          if (descriptorStats.dev !== entryStats.dev || descriptorStats.ino !== entryStats.ino) {
            fail("mutation", `File identity changed before hashing: ${entryPath}`, { path: entryPath });
          }
          if (descriptorStats.size > BigInt(limits.maxFileBytes)) {
            fail("limit", `Single-file byte limit exceeded: ${entryPath}`, { path: entryPath, limit: "maxFileBytes" });
          }
          const hash = createHash("sha256");
          const buffer = Buffer.allocUnsafe(64 * 1024);
          let position = 0;
          let hashedBytes = 0;
          for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
            if (bytesRead === 0) break;
            if (hashedBytes + bytesRead > limits.maxFileBytes) {
              fail("limit", `Single-file streaming byte limit exceeded: ${entryPath}`, { path: entryPath, limit: "maxFileBytes" });
            }
            if (totalHashedBytes + bytesRead > limits.maxTotalBytes) {
              fail("limit", `Total streaming byte limit exceeded: ${entryPath}`, { path: entryPath, limit: "maxTotalBytes" });
            }
            hash.update(buffer.subarray(0, bytesRead));
            hashedBytes += bytesRead;
            totalHashedBytes += bytesRead;
            position += bytesRead;
            if (options.hooks?.afterFileChunk !== undefined) {
              await options.hooks.afterFileChunk(entryPath, hashedBytes);
            }
          }
          if (BigInt(hashedBytes) !== descriptorStats.size) {
            fail("mutation", `Hashed byte count differs from file size: ${entryPath}`, { path: entryPath });
          }
          const identity = statIdentity(descriptorStats as never);
          const executable = (identity.mode & 0o111n) !== 0n;
          manifest.push({
            path: entryPath,
            sha256: hash.digest("hex"),
            size: hashedBytes,
            executable,
            class: classifyFile(entryPath, executable),
          });
          files.push({ absolute: absoluteEntry, recordedPath: entryPath, identity });
        } catch (error) {
          if (error instanceof ExpectedWalkFailure) throw error;
          fail("read", `Cannot read file ${entryPath}: ${errorText(error)}`, { path: entryPath });
        } finally {
          if (handle !== undefined) await handle.close().catch(() => undefined);
        }
      }
    };

    await enumerate(rootAbsolute, "", 0);
    if (options.hooks?.afterPass1 !== undefined) await options.hooks.afterPass1();

    for (const directory of directories) {
      const named = displayPath(directory.recordedPath);
      try {
        const opening = await lstatBigint(directory.absolute);
        if (!opening.isDirectory() || !sameDirectoryIdentity(opening, directory.identity)) {
          fail("mutation", `Directory identity changed: ${named}`, { path: named });
        }
        const currentEntries = await readEntryNames(directory.absolute);
        if (!equalEntryLists(currentEntries, directory.entries)) {
          fail("mutation", `Directory entry list changed: ${named}`, { path: named });
        }
        const closing = await lstatBigint(directory.absolute);
        if (!closing.isDirectory() || !sameDirectoryIdentity(closing, directory.identity)) {
          fail("mutation", `Directory identity changed after enumeration: ${named}`, { path: named });
        }
      } catch (error) {
        if (error instanceof ExpectedWalkFailure) throw error;
        fail("read", `Cannot re-verify directory ${named}: ${errorText(error)}`, { path: named });
      }
    }
    for (const entry of excluded) await verifyExcludedEntry(entry);
    for (const file of files) {
      try {
        const current = await lstatBigint(file.absolute);
        if (!current.isFile() || !sameFileIdentity(statIdentity(current as never), file.identity)) {
          fail("mutation", `File changed during walk: ${file.recordedPath}`, { path: file.recordedPath });
        }
      } catch (error) {
        if (error instanceof ExpectedWalkFailure) throw error;
        fail("read", `Cannot re-verify file ${file.recordedPath}: ${errorText(error)}`, { path: file.recordedPath });
      }
    }

    manifest.sort((left, right) => compareUtf8(left.path, right.path));
    for (let index = 1; index < manifest.length; index += 1) {
      if (manifest[index - 1]!.path === manifest[index]!.path) {
        fail("collision", `Duplicate recorded path: ${manifest[index]!.path}`, { path: manifest[index]!.path });
      }
    }
    return { ok: true, root: resolvedRoot, manifest, rootDigest: computeRootDigest(manifest) };
  } catch (error) {
    if (error instanceof ExpectedWalkFailure) return error.failure;
    return { ok: false, rule: "tool", message: `Unexpected walker failure: ${errorText(error)}` };
  }
}

export function walkSkill(skillRoot: string, options: WalkOptions = {}): Promise<WalkResult> {
  return walkSkillInternal(skillRoot, options);
}

/** @internal Test seam. Limits are lower-only and cannot weaken a normative ceiling. */
export function walkSkillWithTestLimits(
  skillRoot: string,
  options: WalkOptions & { limits: Partial<typeof WALK_LIMITS> },
): Promise<WalkResult> {
  const { limits, ...walkOptions } = options;
  return walkSkillInternal(skillRoot, walkOptions, limits);
}
