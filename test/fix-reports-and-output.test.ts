import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeRootDigest, type ManifestEntry } from "../src/index.js";
import { serializeApprovalRecord, serializeJsonDocument } from "../src/lock.js";
import { sanitizeForTerminal, truncateForDisplay } from "../src/cli/sanitize.js";
import { fixture } from "./helpers.js";

/**
 * Three properties that the machine-readable and human-readable surfaces owe
 * their callers:
 *
 * 1. `--json` is a presentation choice, never a verdict change: a tree that
 *    exits 2 in human mode exits 2 in JSON mode, including when a record
 *    carries a file size beyond 2^53 (§9.1 allows any non-negative integer,
 *    and §8.2 hashes its exact digits).
 * 2. The `skill` objects in a `diff` report carry the artifact's shape
 *    verbatim, with object keys in byte-wise sorted order (§12.1) — including
 *    keys that JavaScript treats specially.
 * 3. No untrusted string reaches a terminal unescaped (§15), whichever
 *    argument it arrived through.
 */

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repositoryRoot, "dist", "cli", "index.js");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the built CLI without a shell, so no argument is ever re-parsed. */
function run(args: readonly string[], cwd: string): Promise<Run> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 60_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolvePromise({ code, stdout, stderr });
      },
    );
  });
}

const ESC = String.fromCodePoint(0x1b);
const C1_CSI = String.fromCodePoint(0x9b);

/** A size that survives only as exact digits: `Number` rounds it down to 2^53. */
const HUGE_SIZE = 9_007_199_254_740_993n;

/** Writes JSON with bigint members as bare digits, independently of the library. */
function stringifyExact(value: unknown): string {
  const marked = JSON.stringify(
    value,
    (_key, member: unknown) => (typeof member === "bigint" ? `@@exact@@${member}@@` : member),
    2,
  );
  const unmarked = marked.replace(/"@@exact@@(-?\d+)@@"/g, "$1");
  expect(unmarked).not.toContain("@@exact@@");
  return unmarked;
}

/**
 * Locks a one-file skill, then rewrites the recorded size to `HUGE_SIZE` and
 * re-derives the root digest per §8.2, so the record is valid and the tree on
 * disk is genuine drift against it.
 */
async function forgedOversizeRecord(): Promise<{ temp: string }> {
  const { temp, root } = await fixture("skill");
  await writeFile(join(root, "SKILL.md"), "---\nname: demo\n---\nBody\n");
  const locked = await run(["lock", "skill", "--out", "skill.lock.json"], temp);
  expect(locked.code).toBe(0);
  const record = JSON.parse(await readFile(join(temp, "skill.lock.json"), "utf8")) as {
    files: ManifestEntry[];
    root_digest: string;
  };
  record.files[0]!.size = HUGE_SIZE;
  record.root_digest = computeRootDigest(record.files);
  await writeFile(join(temp, "skill.lock.json"), `${stringifyExact(record)}\n`);
  return { temp };
}

describe("check --json never turns drift into a tool error (§9.1, §12)", () => {
  it("exits 2 in both output modes for a record whose size exceeds 2^53 (§12)", async () => {
    const { temp } = await forgedOversizeRecord();
    const human = await run(["check", "skill", "--against", "skill.lock.json"], temp);
    expect(human.code).toBe(2);
    expect(human.stdout).toContain("Drift:");

    const machine = await run(["check", "skill", "--against", "skill.lock.json", "--json"], temp);
    expect(machine.stderr).toBe("");
    expect(machine.code).toBe(2);
  });

  it("emits the oversize expected size as an exact unquoted JSON integer (§9.1)", async () => {
    const { temp } = await forgedOversizeRecord();
    const machine = await run(["check", "skill", "--against", "skill.lock.json", "--json"], temp);
    expect(machine.code).toBe(2);
    // Well-formed JSON, with the drift categories the human report showed.
    const parsed = JSON.parse(machine.stdout) as { modified: { path: string }[] };
    expect(parsed.modified.map((entry) => entry.path)).toEqual(["SKILL.md"]);
    // The digits themselves: exact, unquoted, no fraction, no exponent.
    expect(machine.stdout).toMatch(/"size": 9007199254740993(?![\d.eE])/);
    expect(machine.stdout).not.toContain('"9007199254740993"');
    expect(machine.stdout).not.toContain("9007199254740992");
  });

  it("writes a bigint as bare digits and otherwise matches the platform serializer", () => {
    expect(serializeJsonDocument({ size: HUGE_SIZE })).toBe('{\n  "size": 9007199254740993\n}');
    const sample = {
      schema_version: 1,
      nested: { list: [1, "two", null, true, { deep: [] }], empty: {} },
      text: `quote " backslash \\ ${ESC} ${String.fromCodePoint(0x202e)}`,
      negative: -0.5,
    };
    expect(serializeJsonDocument(sample)).toBe(JSON.stringify(sample, null, 2));
  });

  it("keeps approval-record bytes identical to the platform serializer", async () => {
    const { temp, root } = await fixture("skill");
    await writeFile(join(root, "SKILL.md"), "---\nname: demo\nlist: [1, 2]\n---\nBody\n");
    const locked = await run(["lock", "skill", "--out", "skill.lock.json"], temp);
    expect(locked.code).toBe(0);
    const onDisk = await readFile(join(temp, "skill.lock.json"), "utf8");
    const parsed: unknown = JSON.parse(onDisk);
    expect(onDisk).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
    expect(serializeApprovalRecord(parsed as never)).toBe(onDisk);
  });
});

describe("diff --json serializes frontmatter keys in byte-wise order (§12.1)", () => {
  /** Two trees whose only difference is the candidate's frontmatter block. */
  async function twoTrees(baseFrontmatter: string, candidateFrontmatter: string) {
    const { temp, root } = await fixture("base");
    const candidate = join(temp, "candidate");
    await mkdir(candidate, { recursive: true });
    await writeFile(join(root, "SKILL.md"), `---\n${baseFrontmatter}\n---\nBody\n`);
    await writeFile(join(candidate, "SKILL.md"), `---\n${candidateFrontmatter}\n---\nBody\n`);
    return { temp };
  }

  /** The candidate half of the report text, where the interesting keys live. */
  function candidateSection(stdout: string): string {
    const start = stdout.indexOf('"candidate"');
    expect(start).toBeGreaterThan(0);
    return stdout.slice(start, stdout.indexOf('"added"'));
  }

  it("orders integer-like keys by bytes, not by numeric value (§12.1)", async () => {
    const { temp } = await twoTrees(
      "name: demo",
      '"2": two\n"10": ten\napple: a\nname: demo',
    );
    const result = await run(["diff", "base", "candidate", "--json"], temp);
    expect(result.code).toBe(2);
    const section = candidateSection(result.stdout);
    const positions = ['"10"', '"2"', '"apple"', '"name"'].map((key) => section.indexOf(key));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it("carries a __proto__ key verbatim at the top level and nested (§12.1)", async () => {
    const { temp } = await twoTrees(
      "name: demo",
      'name: demo\n"__proto__": marker\nnested:\n  "__proto__": deep',
    );
    const result = await run(["diff", "base", "candidate", "--json"], temp);
    expect(result.code).toBe(2);
    const section = candidateSection(result.stdout);
    expect(section).toContain('"__proto__": "marker"');
    expect(section).toContain('"__proto__": "deep"');
    const parsed = JSON.parse(result.stdout) as {
      candidate: { skill: { frontmatter: Record<string, unknown> } };
    };
    const frontmatter = parsed.candidate.skill.frontmatter;
    expect(Object.keys(frontmatter)).toContain("__proto__");
    expect(Object.keys(frontmatter.nested as object)).toEqual(["__proto__"]);
  });

  it("carries a __proto__ key verbatim through lock --json as well (§9.1)", async () => {
    const { temp, root } = await fixture("skill");
    await writeFile(join(root, "SKILL.md"), '---\nname: demo\n"__proto__": marker\n---\nBody\n');
    const result = await run(["lock", "skill", "--out", "skill.lock.json", "--json"], temp);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"__proto__": "marker"');
    const onDisk = await readFile(join(temp, "skill.lock.json"), "utf8");
    expect(onDisk).toContain('"__proto__": "marker"');
  });

  it("keeps the human diff summary readable for the same frontmatter (§12.1)", async () => {
    const { temp } = await twoTrees("name: demo", 'name: demo\n"__proto__": marker');
    const result = await run(["diff", "base", "candidate"], temp);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("__proto__: (absent) -> marker");
  });
});

describe("output-path and invisible-character escaping (§15)", () => {
  /** Locks a plain skill into a directory whose name carries the payload. */
  async function lockIntoDirectory(directoryName: string): Promise<Run> {
    const { temp, root } = await fixture("skill");
    await writeFile(join(root, "SKILL.md"), "---\nname: demo\n---\nBody\n");
    await mkdir(join(temp, directoryName), { recursive: true });
    return run(
      ["lock", "skill", "--approval-id", "demo", "--out", `${directoryName}/demo.lock.json`],
      temp,
    );
  }

  it("escapes an escape sequence carried by the output directory name (§15)", async () => {
    const result = await lockIntoDirectory(`out${ESC}[31mdir`);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(ESC);
    expect(result.stdout).toContain("out\\x1B[31mdir/demo.lock.json");
  });

  it("escapes C1, bidi, and zero-width characters in the output path (§15)", async () => {
    const payload = `${C1_CSI}${String.fromCodePoint(0x202e)}${String.fromCodePoint(0x200b)}`;
    const result = await lockIntoDirectory(`out${payload}dir`);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("out\\x9B\\u{202E}\\u{200B}dir/demo.lock.json");
  });

  it("escapes a word joiner in the output path (§15)", async () => {
    const result = await lockIntoDirectory(`out${String.fromCodePoint(0x2060)}dir`);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("out\\u{2060}dir/demo.lock.json");
  });

  it("escapes tag characters smuggled into a frontmatter name (§15)", async () => {
    const { temp, root } = await fixture("skill");
    // "hi" encoded in the Unicode tag block, behind the tag-sequence introducer.
    const tagged = ["\\U000E0001", "\\U000E0068", "\\U000E0069"].join("");
    await writeFile(join(root, "SKILL.md"), `---\nname: "demo${tagged}"\n---\nBody\n`);
    const result = await run(["lock", "skill", "--out", "skill.lock.json"], temp);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("demo\\u{E0001}\\u{E0068}\\u{E0069}");
    expect(result.stdout).not.toContain(String.fromCodePoint(0xe0001));
  });

  it("leaves ordinary non-ASCII text alone (§15)", () => {
    expect(sanitizeForTerminal("é 日本 😀 ünïcode")).toBe("é 日本 😀 ünïcode");
  });

  it("escapes the newly covered invisible formats and private-use area (§15)", () => {
    for (const codePoint of [0x00ad, 0x061c, 0x180e, 0x2060, 0x2064, 0xfff9, 0xfffb, 0xe000, 0xe0041]) {
      const escaped = sanitizeForTerminal(String.fromCodePoint(codePoint));
      expect(escaped, `U+${codePoint.toString(16).toUpperCase()}`).toBe(
        `\\u{${codePoint.toString(16).toUpperCase().padStart(4, "0")}}`,
      );
    }
  });

  it("truncates on code-point boundaries, never splitting a surrogate pair (§15)", () => {
    const straddling = `${"A".repeat(159)}${String.fromCodePoint(0x1f600)}${"B".repeat(10)}`;
    const truncated = truncateForDisplay(straddling);
    expect(truncated).toBe(`${"A".repeat(159)}${String.fromCodePoint(0x1f600)}…`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(truncated)).toBe(false);
    // The all-ASCII bound is unchanged: 160 characters plus the ellipsis.
    expect(truncateForDisplay("A".repeat(1_000))).toBe(`${"A".repeat(160)}…`);
    expect(truncateForDisplay("A".repeat(160))).toBe("A".repeat(160));
  });
});
