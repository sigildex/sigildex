import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LIMITATIONS,
  canonicalManifestLine,
  check,
  computeRootDigest,
  diff,
  lock,
  readSkillFrontmatter,
  validateApprovalRecord,
  walkSkill,
  type ManifestEntry,
  type ValidationStep,
} from "../src/index.js";
import { fixture, writeSkill } from "./helpers.js";

/**
 * Adversarial coverage for canonical serialization (§8), lock serialization
 * stability and validation (§9), and frontmatter recording (§10).
 *
 * The known-answer tests deliberately re-derive the §8.1 line bytes and the
 * §8.2 root digest from the specification text with `node:crypto` instead of
 * calling the library's own helpers; asserting the library against itself
 * would prove nothing. The expected digests are frozen literals so a future
 * refactor of both sides cannot move the answer.
 */

interface KatEntry {
  path: string;
  sha256: string;
  size: number;
  executable: boolean;
  class: ManifestEntry["class"];
}

/** §8.1, rebuilt from the spec text: `<sha256> <size> <x-flag> <path>\n`, ASCII spaces, LF. */
function independentLine(entry: KatEntry): Buffer {
  const space = Buffer.from([0x20]);
  return Buffer.concat([
    Buffer.from(entry.sha256, "ascii"),
    space,
    Buffer.from(entry.size.toString(10), "ascii"),
    space,
    Buffer.from(entry.executable ? "x" : "-", "ascii"),
    space,
    Buffer.from(entry.path, "utf8"),
    Buffer.from([0x0a]),
  ]);
}

/** §8.2, rebuilt from the spec text: header line, then every line in manifest order. */
function independentRootDigest(entries: readonly KatEntry[]): string {
  const hash = createHash("sha256");
  hash.update(Buffer.from("sigildex-root-digest-v1\n", "utf8"));
  for (const entry of entries) hash.update(independentLine(entry));
  return `sha256:${hash.digest("hex")}`;
}

const KAT_ENTRIES: KatEntry[] = [
  // Empty file: size renders as the single digit `0`, never `00` or empty.
  { path: "SKILL.md", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", size: 0, executable: false, class: "instructions" },
  // Executable: the x-flag is `x`.
  { path: "bin/run.sh", sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", size: 18, executable: true, class: "script" },
  // Non-ASCII path with an astral-plane code point: recorded as raw UTF-8 bytes.
  { path: "docs/café-😀.md", sha256: "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae", size: 1234, executable: false, class: "reference" },
  // Large size: base 10, no separators, no exponent.
  { path: "payload.bin", sha256: "fcde2b2edba56bf408601fb721fe9b5c338d10ee429ea04fae5511b68fbf8fb9", size: 67_108_864, executable: false, class: "other" },
];

const KAT_LINES = [
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 0 - SKILL.md\n",
  "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 18 x bin/run.sh\n",
  "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae 1234 - docs/café-😀.md\n",
  "fcde2b2edba56bf408601fb721fe9b5c338d10ee429ea04fae5511b68fbf8fb9 67108864 - payload.bin\n",
];
const KAT_ROOT_DIGEST = "sha256:a1c8897c13e5d2665c68d22a83c0d387ea919823d04a6afbfef8e5dc69afb209";
const EMPTY_MANIFEST_DIGEST = "sha256:ffae35139e6e51e41ed7ded7b964f81ad5c794a77e11f72ac63d32068602d4a2";

const BASE_FILES: ManifestEntry[] = [
  { path: "SKILL.md", sha256: "a".repeat(64), size: 24, executable: false, class: "instructions" },
  { path: "notes.txt", sha256: "b".repeat(64), size: 4, executable: false, class: "reference" },
];

/** A schema-valid record with `root_digest` derived from `files`, then patched. */
function record(patch: Record<string, unknown> = {}, files: readonly ManifestEntry[] = BASE_FILES): Record<string, unknown> {
  return {
    schema_version: 1,
    spec_version: 1,
    tool_version: "0.1.0",
    approval_id: "demo",
    artifact_path: "skills/demo",
    root_digest: computeRootDigest(files),
    files,
    skill: { frontmatter_status: "ok", frontmatter: { name: "demo" } },
    created_at: "2026-08-14T12:34:56Z",
    limitations: LIMITATIONS,
    ...patch,
  };
}

/** The §9.5 step a lock fails at, or "ok" when all five steps pass. */
function stepOf(value: unknown): ValidationStep | "ok" {
  const result = validateApprovalRecord(typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
  return result.ok ? "ok" : result.step;
}

async function frontmatterStatus(body: string | Buffer, root: string, name: string) {
  const path = join(root, name);
  await writeFile(path, body);
  return readSkillFrontmatter(path);
}

function sh(script: string, cwd: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolvePromise) => {
    execFile("/bin/sh", ["-c", script], { cwd, encoding: "utf8", timeout: 60_000 }, (error, stdout) => {
      resolvePromise({ code: error === null ? 0 : 1, stdout });
    });
  });
}

describe("§8.1/§8.2 canonical line and root-digest known answers", () => {
  it("§8.1: emits the exact line bytes for size 0, an executable, a non-ASCII path, and a large size", () => {
    for (const [index, entry] of KAT_ENTRIES.entries()) {
      const expected = KAT_LINES[index]!;
      expect(independentLine(entry).toString("utf8"), `spec line ${entry.path}`).toBe(expected);
      expect(canonicalManifestLine(entry), `library line ${entry.path}`).toBe(expected);
      // The path is carried as raw UTF-8 bytes: the astral code point is 4 bytes.
      expect(Buffer.from(canonicalManifestLine(entry), "utf8").length, `byte length ${entry.path}`)
        .toBe(Buffer.byteLength(expected, "utf8"));
    }
    expect(Buffer.byteLength(KAT_LINES[2]!, "utf8")).toBe(91);
  });

  it("§8.2: the frozen root digest matches an independent re-derivation and the library", () => {
    expect(independentRootDigest(KAT_ENTRIES)).toBe(KAT_ROOT_DIGEST);
    expect(computeRootDigest(KAT_ENTRIES)).toBe(KAT_ROOT_DIGEST);
  });

  it("§8.2: the domain-separation header is hashed even for an empty manifest", () => {
    expect(independentRootDigest([])).toBe(EMPTY_MANIFEST_DIGEST);
    expect(computeRootDigest([])).toBe(EMPTY_MANIFEST_DIGEST);
  });

  it("§7.2/§8.2: identity inputs are exactly path, size, executable flag, sha256, and order", () => {
    const flipped = KAT_ENTRIES.map((entry, index) => index === 1 ? { ...entry, executable: false } : entry);
    expect(computeRootDigest(flipped), "exec flip").not.toBe(KAT_ROOT_DIGEST);
    expect(computeRootDigest([...KAT_ENTRIES].reverse()), "reordered").not.toBe(KAT_ROOT_DIGEST);
    // Classification is excluded from identity (§7.3), so it cannot move the digest.
    expect(computeRootDigest(KAT_ENTRIES.map((entry) => ({ ...entry, class: "other" as const })))).toBe(KAT_ROOT_DIGEST);
  });

  it("§8.1: a size beyond 2^53 renders as exact decimal digits, never an exponent", () => {
    const huge: ManifestEntry = { path: "a", sha256: "a".repeat(64), size: 9_007_199_254_740_993n, executable: false, class: "other" };
    expect(canonicalManifestLine(huge)).toBe(`${"a".repeat(64)} 9007199254740993 - a\n`);
  });
});

describe("§8.3 independent reproduction with standard tools", () => {
  const supported = process.platform === "darwin" || process.platform === "linux";

  it.skipIf(!supported)("§8.3: the documented shell recipe reproduces the library root digest byte-for-byte", async () => {
    const { root } = await fixture();
    await mkdir(join(root, "sub"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, ".sigildex"), { recursive: true });
    await writeSkill(root);
    await writeFile(join(root, "empty.bin"), "");
    await writeFile(join(root, "run.sh"), "#!/bin/sh\necho hi\n");
    await chmod(join(root, "run.sh"), 0o755);
    await writeFile(join(root, "sub", "café.txt"), "deep\n");
    // setuid must not be read as an execute bit (§8.3 masking note, §6.3).
    await writeFile(join(root, "setuid.txt"), "su\n");
    await chmod(join(root, "setuid.txt"), 0o4644);
    // Pruned by the recipe and by §3.2 alike.
    await writeFile(join(root, ".git", "config"), "[core]\n");
    await writeFile(join(root, ".sigildex", "note"), "x\n");

    const darwin = process.platform === "darwin";
    const shaTool = darwin ? "shasum -a 256" : "sha256sum";
    const statMode = darwin ? `m=$(stat -f '%Lp' "$p")` : `m=$(stat -c '%a' "$p")`;
    const available = await sh(`command -v ${shaTool.split(" ")[0]!} >/dev/null && command -v stat >/dev/null`, root);
    if (available.code !== 0) return; // Tool unavailable on this host: nothing to compare against.

    // The §8.3 recipe verbatim, with the macOS substitutions the same section prescribes.
    const recipe = [
      `find . \\( -name .git -o -name .sigildex \\) -prune -o -type f -print \\`,
      `  | LC_ALL=C sort \\`,
      `  | while IFS= read -r p; do`,
      `      rel=\${p#./}`,
      `      h=$(${shaTool} < "$p" | cut -d' ' -f1)`,
      `      s=$(wc -c < "$p" | tr -d ' ')`,
      `      ${statMode}; m=$(printf '%03d' "$m" | tail -c 3)`,
      `      case $m in *[1357]*) x=x;; *) x=-;; esac`,
      `      printf '%s %s %s %s\\n' "$h" "$s" "$x" "$rel"`,
      `    done \\`,
      `  | { printf 'sigildex-root-digest-v1\\n'; cat; } | ${shaTool}`,
    ].join("\n");

    const reproduced = await sh(recipe, root);
    expect(reproduced.code).toBe(0);
    const digest = `sha256:${reproduced.stdout.trim().split(/\s+/)[0]!}`;
    const walked = await walkSkill(root);
    expect(walked.ok).toBe(true);
    if (walked.ok) {
      expect(digest).toBe(walked.rootDigest);
      expect(walked.manifest.map((file) => file.path)).not.toContain(".git/config");
    }
  });
});

describe("§9.2 lock serialization stability", () => {
  it("§9.2: locking one tree twice differs only in created_at", async () => {
    const { root, temp } = await fixture();
    await writeSkill(root);
    const first = await lock({ skillRoot: root, outputPath: join(temp, "one.json"), approvalId: "a", artifactPath: "skill", createdAt: "2026-08-14T00:00:00Z" });
    const second = await lock({ skillRoot: root, outputPath: join(temp, "two.json"), approvalId: "a", artifactPath: "skill", createdAt: "2026-08-15T23:59:59.999999999Z" });
    expect(first.kind).toBe("locked");
    expect(second.kind).toBe("locked");
    if (first.kind !== "locked" || second.kind !== "locked") return;
    const mask = (json: string) => json.replace(/"created_at": "[^"]*"/, '"created_at": "MASKED"');
    expect(mask(first.json)).toBe(mask(second.json));
    expect(first.json).not.toBe(second.json);
  });

  it("§9.1/§9.2: key order, 2-space indent, trailing LF, and no gratuitous \\u escapes for non-ASCII", async () => {
    const { root, temp } = await fixture();
    await writeFile(
      join(root, "SKILL.md"),
      '---\nname: "démo 😀 𝄞"\ndescription: "ünïcode ✓"\n---\nBody\n',
    );
    const result = await lock({ skillRoot: root, outputPath: join(temp, "u.json"), approvalId: "a", artifactPath: "skill", createdAt: "2026-08-14T00:00:00Z" });
    expect(result.kind).toBe("locked");
    if (result.kind !== "locked") return;
    const json = result.json;

    expect(Object.keys(JSON.parse(json) as Record<string, unknown>)).toEqual([
      "schema_version", "spec_version", "tool_version", "approval_id", "artifact_path",
      "root_digest", "files", "skill", "created_at", "limitations",
    ]);
    expect(json.endsWith("}\n")).toBe(true);
    expect(json.endsWith("\n\n")).toBe(false);
    expect(json.includes("\r")).toBe(false);
    for (const line of json.split("\n")) {
      const indent = /^ */.exec(line)![0].length;
      expect(indent % 2, `indent of ${JSON.stringify(line.slice(0, 40))}`).toBe(0);
      expect(line.includes("\t")).toBe(false);
    }
    // "no non-ASCII escapes beyond what JSON requires": these need none, so none appear.
    expect(/\\u[0-9a-fA-F]{4}/.test(json)).toBe(false);
    expect(json).toContain("😀");
    expect(json).toContain("𝄞");
    expect(json).toContain("ünïcode ✓");
    // Valid UTF-8 on the wire, and still valid after a byte round-trip.
    const bytes = Buffer.from(json, "utf8");
    expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toBe(json);
    expect(validateApprovalRecord(bytes).ok).toBe(true);
  });
});

describe("§8.4/§12 report determinism", () => {
  // Byte-identical *stdout* for the same trees is asserted against the built CLI in
  // adversarial-cli-exits.test.ts; here the same payloads are compared at the library
  // boundary the CLI serializes verbatim.
  it("§8.4: two consecutive diff and check runs on unchanged trees produce byte-identical JSON", async () => {
    const { temp, root } = await fixture("base");
    const candidate = join(temp, "candidate");
    await mkdir(candidate, { recursive: true });
    for (const tree of [root, candidate]) {
      await writeSkill(tree);
      await writeFile(join(tree, "notes.txt"), "one\n");
    }
    await writeFile(join(candidate, "notes.txt"), "two\n");
    await writeFile(join(candidate, "extra.py"), "print(1)\n");
    const diffOne = await diff({ basePath: root, candidatePath: candidate });
    const diffTwo = await diff({ basePath: root, candidatePath: candidate });
    expect(diffOne.kind).toBe("different");
    expect(`${JSON.stringify(diffOne.report, null, 2)}\n`).toBe(`${JSON.stringify(diffTwo.report, null, 2)}\n`);

    const { root: locked, lockPath } = await fixture("locked");
    await writeSkill(locked);
    await writeFile(join(locked, "notes.txt"), "one\n");
    expect((await lock({ skillRoot: locked, outputPath: lockPath, approvalId: "a", artifactPath: "skill" })).kind).toBe("locked");
    await writeFile(join(locked, "notes.txt"), "two\n");
    await writeFile(join(locked, "added.txt"), "new\n");
    const checkOne = await check({ skillRoot: locked, lockPath });
    const checkTwo = await check({ skillRoot: locked, lockPath });
    expect(checkOne.kind).toBe("drift");
    if (checkOne.kind !== "drift" || checkTwo.kind !== "drift") return;
    expect(`${JSON.stringify(checkOne.report, null, 2)}\n`).toBe(`${JSON.stringify(checkTwo.report, null, 2)}\n`);
  });
});

describe("§9.5 validation edge cases, with the exact failing step", () => {
  it("§9.5.3: size must be a non-negative integer, and exact beyond 2^53", () => {
    const bad = (size: unknown) => stepOf(record({}, [{ ...BASE_FILES[0]!, size } as unknown as ManifestEntry, BASE_FILES[1]!]));
    expect(bad(1.5), "float size").toBe("shape");
    expect(bad(-1), "negative size").toBe("shape");
    expect(bad("24"), "string size").toBe("shape");
    expect(bad(null), "null size").toBe("shape");
    // Above 2^53 the value must survive without float rounding: the digest is
    // computed over the exact digits, so a rounded reader would fail step 5.
    const exact = `{"schema_version":1,"spec_version":1,"tool_version":"0.1.0","approval_id":"demo",` +
      `"artifact_path":"a","root_digest":"${computeRootDigest([{ path: "a", sha256: "a".repeat(64), size: 9_007_199_254_740_993n, executable: false, class: "other" }])}",` +
      `"files":[{"path":"a","sha256":"${"a".repeat(64)}","size":9007199254740993,"executable":false,"class":"other"}],` +
      `"skill":{"frontmatter_status":"missing","frontmatter":null},"created_at":"2026-08-14T12:34:56Z",` +
      `"limitations":${JSON.stringify(LIMITATIONS)}}`;
    expect(stepOf(exact), "2^53+1 size").toBe("ok");
    expect(stepOf(exact.replace("9007199254740993,", "9007199254740992,")), "rounded 2^53 size").toBe("internal_consistency");
  });

  it("§9.5.3: executable is a boolean (never 0/1) and every hex field is lowercase", () => {
    for (const value of [0, 1, "true", null]) {
      expect(stepOf(record({}, [{ ...BASE_FILES[0]!, executable: value } as unknown as ManifestEntry, BASE_FILES[1]!])), `executable ${JSON.stringify(value)}`).toBe("shape");
    }
    expect(stepOf(record({}, [{ ...BASE_FILES[0]!, sha256: "A".repeat(64) }, BASE_FILES[1]!])), "uppercase sha256").toBe("shape");
    const upper = computeRootDigest(BASE_FILES).slice(7).toUpperCase();
    expect(stepOf(record({ root_digest: `sha256:${upper}` })), "uppercase root_digest").toBe("shape");
    expect(stepOf(record({ root_digest: computeRootDigest(BASE_FILES).toUpperCase() })), "uppercase prefix").toBe("shape");
    expect(stepOf(record({ root_digest: computeRootDigest(BASE_FILES).slice(7) })), "missing prefix").toBe("shape");
  });

  it("§9.1 rows 4 and 5: approval_id grammar, and artifact_path in §4.1 form or the literal \".\"", () => {
    for (const id of ["Demo", "-demo", "a".repeat(65), "", "de mo", "demo_1", "デモ"]) {
      expect(stepOf(record({ approval_id: id })), `approval_id ${JSON.stringify(id)}`).toBe("shape");
    }
    for (const id of ["demo-", "a", "0", "a".repeat(64)]) {
      expect(stepOf(record({ approval_id: id })), `approval_id ${JSON.stringify(id)}`).toBe("ok");
    }
    for (const path of ["./x", "/abs", "a/../b", "", "a//b", "a/", ".."]) {
      expect(stepOf(record({ artifact_path: path })), `artifact_path ${JSON.stringify(path)}`).toBe("shape");
    }
    expect(stepOf(record({ artifact_path: "." })), 'artifact_path "."').toBe("ok");
  });

  it("§9.1: created_at is validated by shape only, with no calendar semantics", () => {
    for (const value of [
      "2026-08-14T12:34:56",
      "2026-08-14T12:34:56+00:00",
      "2026-08-14T12:34:56.1234567890Z",
      "2026-08-14T12:34:56z",
      "2026-08-14 12:34:56Z",
      "2026-08-14T12:34:56.Z",
    ]) {
      expect(stepOf(record({ created_at: value })), `created_at ${value}`).toBe("shape");
    }
    expect(stepOf(record({ created_at: "2026-08-14T12:34:56.123456789Z" })), "9 fractional digits").toBe("ok");
    // Deliberate per §9.1: "No calendar, range, or leap-second semantics are validated."
    expect(stepOf(record({ created_at: "2026-13-45T99:99:99Z" })), "impossible instant").toBe("ok");
  });

  it("§9.1: tool_version grammar, and limitations byte-equal to the normative literal", () => {
    for (const value of ["1.0", "v1.0.0", "1.0.0.0", "1.0.0+build", "1.0.0-", ""]) {
      expect(stepOf(record({ tool_version: value })), `tool_version ${JSON.stringify(value)}`).toBe("shape");
    }
    for (const value of ["1.0.0-rc.1", "0.0.0", "01.0.0"]) {
      expect(stepOf(record({ tool_version: value })), `tool_version ${value}`).toBe("ok");
    }
    expect(stepOf(record({ limitations: `${LIMITATIONS} ` })), "trailing space").toBe("shape");
    expect(stepOf(record({ limitations: ` ${LIMITATIONS}` })), "leading space").toBe("shape");
    expect(stepOf(record({ limitations: LIMITATIONS.replace("attests", "attest") })), "one byte short").toBe("shape");
    expect(stepOf(record({ limitations: `${LIMITATIONS}\n` })), "trailing LF").toBe("shape");
  });

  it("§9.1/§9.4: declared_source is a closed shape with byte-measured length limits", () => {
    const source = (patch: Record<string, unknown>) => stepOf(record({ declared_source: { verification: "user_supplied", ...patch } }));
    expect(source({ surprise: 1 }), "unknown key").toBe("shape");
    expect(stepOf(record({ declared_source: { verification: "verified" } })), "wrong verification literal").toBe("shape");
    expect(stepOf(record({ declared_source: { repository: "x" } })), "missing verification").toBe("shape");
    // 512 is UTF-8 *bytes*: 200 two-byte characters fit, 260 do not.
    expect(source({ repository: "é".repeat(200) }), "400-byte repository").toBe("ok");
    expect(source({ repository: "é".repeat(260) }), "520-byte repository").toBe("shape");
    expect(source({ repository: "a".repeat(512) }), "512-byte repository").toBe("ok");
    expect(source({ repository: "a".repeat(513) }), "513-byte repository").toBe("shape");
    expect(source({ tracking_policy: "é".repeat(64) }), "128-byte tracking_policy").toBe("ok");
    expect(source({ tracking_policy: "é".repeat(65) }), "130-byte tracking_policy").toBe("shape");
    for (const commit of ["abcdef", "a".repeat(65), "ABCDEF1", "abcdefg"]) {
      expect(source({ approved_commit: commit }), `approved_commit ${commit.slice(0, 8)} (${commit.length})`).toBe("shape");
    }
    expect(source({ approved_commit: "abcdef1" }), "7 hex").toBe("ok");
    expect(source({ approved_commit: "0".repeat(64) }), "64 hex").toBe("ok");
    expect(source({ kind: "GitHub" }), "uppercase kind").toBe("shape");
    expect(source({ kind: "a".repeat(33) }), "33-character kind").toBe("shape");
  });

  it("§9.5.1: the top-level value must be a single JSON object, and a BOM is refused", () => {
    expect(stepOf("[]"), "array").toBe("syntax");
    expect(stepOf('"lock"'), "string").toBe("syntax");
    expect(stepOf("null"), "null").toBe("syntax");
    expect(stepOf("123"), "number").toBe("syntax");
    const single = JSON.stringify(record());
    expect(stepOf(`${single}\n${single}`), "two documents").toBe("syntax");
    expect(stepOf(`${single} trailing`), "trailing text").toBe("syntax");
    // JSON whitespace, including CRLF and a leading run, is accepted; a BOM is not.
    const pretty = JSON.stringify(record(), null, 2);
    expect(stepOf(pretty.replace(/\n/g, "\r\n")), "CRLF between tokens").toBe("ok");
    expect(stepOf(`  \n\t${pretty}\n`), "leading whitespace").toBe("ok");
    expect(validateApprovalRecord(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(pretty)])), "UTF-8 BOM")
      .toMatchObject({ ok: false, step: "syntax" });
    // §9.2 constrains the *writer* to LF; §9.5 gives the reader no line-ending rule,
    // so a CRLF lock is valid input even though this tool never emits one.
  });

  it("§9.5: an oversized lock has no declared bound and is accepted (observation, not a spec limit)", () => {
    const padded = record({ skill: { frontmatter_status: "ok", frontmatter: { blob: "x".repeat(20_000_000) } } });
    expect(stepOf(padded)).toBe("ok");
  });

  it("§9.5.3/§3.2: a §3.2-excluded name inside files[] is schema-valid (no exclusion rule in validation)", () => {
    for (const path of [".git/config", ".sigildex/approvals/x.lock.json"]) {
      const files: ManifestEntry[] = [{ path, sha256: "a".repeat(64), size: 1, executable: false, class: "config" }];
      expect(stepOf(record({}, files)), path).toBe("ok");
    }
    // §9.5 lists five steps and none of them re-applies §3.2; such a lock is valid
    // input whose entry can never be matched by a walk, so `check` reports it removed.
  });

  it("§9.5: steps are ordered versions -> shape -> manifest_integrity -> internal_consistency", () => {
    const unsorted = [BASE_FILES[1]!, BASE_FILES[0]!];
    expect(stepOf({ ...record({}, unsorted), root_digest: `sha256:${"0".repeat(64)}` }), "unsorted + bad digest")
      .toBe("manifest_integrity");
    expect(stepOf(record({}, [{ ...BASE_FILES[1]!, sha256: "Z".repeat(64) }, BASE_FILES[0]!])), "bad grammar + unsorted")
      .toBe("shape");
    expect(stepOf({ ...record({}, unsorted), schema_version: 2 }), "bad version + unsorted").toBe("versions");
    expect(stepOf(record({ schema_version: undefined })), "missing schema_version").toBe("versions");
    expect(stepOf(record({ root_digest: `sha256:${"0".repeat(64)}` })), "tampered digest only").toBe("internal_consistency");
  });

  it("§9.1: skill is a closed two-key object; only skill.frontmatter is open", () => {
    expect(stepOf(record({ skill: { frontmatter_status: "ok", frontmatter: null } })), "ok with null frontmatter").toBe("shape");
    expect(stepOf(record({ skill: { frontmatter_status: "missing", frontmatter: {} } })), "missing with an object").toBe("shape");
    expect(stepOf(record({ skill: { frontmatter_status: "unknown", frontmatter: null } })), "unknown status").toBe("shape");
    expect(stepOf(record({ skill: { frontmatter_status: "missing", frontmatter: null, extra: 1 } })), "extra key").toBe("shape");
    expect(stepOf(record({ skill: { frontmatter_status: "ok", frontmatter: { any: { nested: [1, 2, 3] }, "": null } } })), "open frontmatter").toBe("ok");
  });
});

describe("§10 SKILL.md frontmatter recording", () => {
  it("§10.3: an unterminated or empty block is invalid, never a crash", async () => {
    const { root } = await fixture();
    expect((await frontmatterStatus("---\nname: demo\nno close\n", root, "a.md")).frontmatter_status, "unterminated").toBe("invalid");
    expect((await frontmatterStatus("---\n", root, "b.md")).frontmatter_status, "opening only").toBe("invalid");
    expect((await frontmatterStatus("---", root, "c.md")).frontmatter_status, "bare delimiter").toBe("invalid");
    // An empty block parses to null, which is not a YAML map (§10.3).
    expect((await frontmatterStatus("---\n---\nBody\n", root, "d.md")).frontmatter_status, "empty mapping").toBe("invalid");
  });

  it("§10.2: the block must open at the first byte — a leading blank line or BOM makes it missing", async () => {
    const { root } = await fixture();
    expect((await frontmatterStatus("\n---\nname: demo\n---\n", root, "e.md")).frontmatter_status, "leading blank line").toBe("missing");
    expect((await frontmatterStatus("﻿---\nname: demo\n---\n", root, "f.md")).frontmatter_status, "leading BOM").toBe("missing");
    expect((await frontmatterStatus("--- \nname: demo\n---\n", root, "g.md")).frontmatter_status, "trailing space on the opener").toBe("missing");
    expect((await frontmatterStatus("---\nname: demo\n--- \n", root, "h.md")).frontmatter_status, "trailing space on the closer").toBe("invalid");
  });

  it("§10.2: CRLF-terminated delimiters still delimit the block", async () => {
    const { root } = await fixture();
    const result = await frontmatterStatus("---\r\nname: demo\r\n---\r\nBody\r\n", root, "i.md");
    expect(result).toEqual({ frontmatter_status: "ok", frontmatter: { name: "demo" } });
  });

  it("§10.4: duplicate keys, tab indentation, and custom-tag-like input are invalid", async () => {
    const { root } = await fixture();
    expect((await frontmatterStatus("---\nname: a\nname: b\n---\n", root, "j.md")).frontmatter_status, "duplicate keys").toBe("invalid");
    expect((await frontmatterStatus("---\nname: demo\nmap:\n\tkey: v\n---\n", root, "k.md")).frontmatter_status, "tab indentation").toBe("invalid");
  });

  it("§10.2/§9.1: recorded values are JSON-representable, and non-representable numbers are invalid", async () => {
    const { root } = await fixture();
    const ok = async (body: string, name: string) => {
      const result = await frontmatterStatus(body, root, name);
      expect(result.frontmatter_status, name).toBe("ok");
      return result.frontmatter!;
    };
    // The core schema keeps a YAML timestamp as a string: no Date leaks into the record.
    expect((await ok("---\nname: demo\nwhen: 2026-08-14T00:00:00Z\n---\n", "l.md")).when).toBe("2026-08-14T00:00:00Z");
    // `0755` is a core-schema decimal integer, not an octal literal.
    expect((await ok("---\nname: demo\ncode: 0755\n---\n", "m.md")).code).toBe(755);
    expect((await ok("---\nname: demo\nvalue: ~\n---\n", "n.md")).value).toBeNull();
    expect((await ok("---\nname: demo\nflag: yes\n---\n", "o.md")).flag).toBe("yes");
    // .inf / .nan have no JSON form, so the whole block is recorded invalid.
    expect((await frontmatterStatus("---\nname: demo\nvalue: .inf\n---\n", root, "p.md")).frontmatter_status, ".inf").toBe("invalid");
    expect((await frontmatterStatus("---\nname: demo\nvalue: .nan\n---\n", root, "q.md")).frontmatter_status, ".nan").toBe("invalid");
    // An integer beyond double precision is kept as the nearest JSON number.
    expect((await ok("---\nname: demo\nvalue: 123456789012345678901234567890\n---\n", "r.md")).value).toBe(1.2345678901234568e29);
  });

  it("§10.2: name and description accept every scalar, including null, and reject collections", async () => {
    const { root } = await fixture();
    expect(await frontmatterStatus("---\nname:\n---\n", root, "s.md"), "null name").toEqual({ frontmatter_status: "ok", frontmatter: { name: null } });
    expect((await frontmatterStatus("---\nname: |\n  line one\n  line two\n---\n", root, "t.md")).frontmatter, "block scalar name")
      .toEqual({ name: "line one\nline two\n" });
    expect((await frontmatterStatus("---\nname: demo\ndescription: {a: 1}\n---\n", root, "u.md")).frontmatter_status, "mapping description").toBe("invalid");
    expect((await frontmatterStatus("---\nname: demo\nother: [1, 2]\n---\n", root, "v.md")).frontmatter_status, "collection under another key").toBe("ok");
  });

  it("§10.4: a 5 MB block is bounded and recorded invalid rather than parsed", async () => {
    const { root } = await fixture();
    const body = `---\nname: demo\nblob: ${"x".repeat(5_000_000)}\n---\nBody\n`;
    const result = await frontmatterStatus(body, root, "w.md");
    expect(result).toEqual({ frontmatter_status: "invalid", frontmatter: null });
  });
});
