import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixture } from "./helpers.js";

/**
 * Adversarial coverage for §15's requirement that every untrusted string —
 * frontmatter values and keys, `declared_source`, and any path echoed back
 * from a lock — is escaped before it reaches a terminal. Human output must
 * never carry a live control sequence; `--json` must carry the exact bytes,
 * because a consumer needs the value the artifact actually contains.
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
const BEL = String.fromCodePoint(0x07);
const DEL = String.fromCodePoint(0x7f);
const C1_CSI = String.fromCodePoint(0x9b);
const CR = String.fromCodePoint(0x0d);

/**
 * Renders a value as a double-quoted YAML scalar with every control,
 * formatting, and non-ASCII code point written as an escape, so the fixture
 * file on disk stays plain ASCII and the payload survives the YAML parse.
 * Payloads here are BMP-only, which is all `\\uXXXX` can express.
 */
function yamlQuoted(value: string): string {
  let quoted = '"';
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (character === '"' || character === "\\") quoted += `\\${character}`;
    else if (codePoint < 0x20 || codePoint > 0x7e) quoted += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    else quoted += character;
  }
  return `${quoted}"`;
}

/** Writes a skill whose `description` carries the payload verbatim. */
async function skillWithDescription(root: string, payload: string): Promise<void> {
  await writeFile(
    join(root, "SKILL.md"),
    `---\nname: demo\ndescription: ${yamlQuoted(payload)}\n---\nBody\n`,
  );
}

/** Reads back the one `description:` line of a human lock summary. */
function descriptionValue(stdout: string): string {
  const line = stdout.split("\n").find((candidate) => candidate.trimStart().startsWith("description:"));
  expect(line).toBeDefined();
  return line!.slice(26);
}

/**
 * The renderers align with spaces and separate lines with LF, so LF is the one
 * control character human output may legitimately contain. Everything else in
 * the C0/C1/DEL range, and every invisible formatting character, is a finding.
 */
function forbiddenCharacter(text: string): string | null {
  for (const character of text) {
    if (character === "\n") continue;
    const codePoint = character.codePointAt(0)!;
    const control = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    const invisible =
      (codePoint >= 0x200b && codePoint <= 0x200f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069) ||
      codePoint === 0xfeff;
    if (control || invisible) return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return null;
}

async function lockedSkill(payload: string): Promise<{ temp: string; root: string; stdout: string }> {
  const { temp, root } = await fixture("skill");
  await skillWithDescription(root, payload);
  const result = await run(["lock", "skill", "--out", "a.lock.json"], temp);
  expect(result.code).toBe(0);
  return { temp, root, stdout: result.stdout };
}

describe("lock human output (§15)", () => {
  it("escapes ESC-introduced SGR, OSC hyperlink, and OSC title sequences in a value (§15)", async () => {
    const payload = `${ESC}[31mred${ESC}]8;;http://x${BEL}link${ESC}]0;evil${BEL}`;
    const { stdout } = await lockedSkill(payload);
    expect(descriptionValue(stdout)).toBe("\\x1B[31mred\\x1B]8;;http://x\\x07link\\x1B]0;evil\\x07");
    expect(forbiddenCharacter(stdout)).toBeNull();
  });

  it("escapes the single-byte C1 control introducer in a value (§15)", async () => {
    const { stdout } = await lockedSkill(`C1${C1_CSI}31mred`);
    expect(descriptionValue(stdout)).toBe("C1\\x9B31mred");
    expect(stdout.includes(C1_CSI)).toBe(false);
  });

  it("escapes DEL and carriage-return line overwrite in a value (§15)", async () => {
    const { stdout } = await lockedSkill(`safe${CR}EVIL${DEL}`);
    expect(descriptionValue(stdout)).toBe("safe\\x0DEVIL\\x7F");
    expect(forbiddenCharacter(stdout)).toBeNull();
  });

  it("escapes bidirectional overrides and isolates in a value (§15)", async () => {
    const override = String.fromCodePoint(0x202e);
    const isolates = [0x2066, 0x2067, 0x2068, 0x2069].map((point) => String.fromCodePoint(point)).join("");
    const { stdout } = await lockedSkill(`a${override}b${isolates}c`);
    expect(descriptionValue(stdout)).toBe("a\\u{202E}b\\u{2066}\\u{2067}\\u{2068}\\u{2069}c");
  });

  it("escapes zero-width characters, the BOM, and the separators in a value (§15)", async () => {
    const payload = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0xfeff, 0x2028, 0x2029]
      .map((point) => String.fromCodePoint(point))
      .join("x");
    const { stdout } = await lockedSkill(payload);
    expect(descriptionValue(stdout)).toBe(
      "\\u{200B}x\\u{200C}x\\u{200D}x\\u{200E}x\\u{200F}x\\u{FEFF}x\\u{2028}x\\u{2029}",
    );
    expect(forbiddenCharacter(stdout)).toBeNull();
  });

  it("bounds a 100 KB value to the display limit with an ellipsis (§15)", async () => {
    const { stdout } = await lockedSkill("A".repeat(100_000));
    const value = descriptionValue(stdout);
    expect(value).toBe(`${"A".repeat(160)}…`);
    expect(stdout.length).toBeLessThan(1_000);
  });

  it("emits Markdown-looking values intact, since a terminal renders no Markdown (§15)", async () => {
    const payload = "</details>[x](javascript:alert(1))| a | b |";
    const { stdout } = await lockedSkill(payload);
    expect(descriptionValue(stdout)).toBe(payload);
  });

  it("escapes a hostile value in the `name` field as well as `description` (§15)", async () => {
    const { temp, root } = await fixture("skill");
    await writeFile(
      join(root, "SKILL.md"),
      `---\nname: ${yamlQuoted(`${ESC}[2Jwiped`)}\n---\nBody\n`,
    );
    const result = await run(["lock", "skill", "--out", "a.lock.json"], temp);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("\\x1B[2Jwiped");
    expect(forbiddenCharacter(result.stdout)).toBeNull();
  });
});

describe("diff human output (§12.1, §15)", () => {
  /** Two trees whose only difference is the candidate's frontmatter block. */
  async function twoTrees(baseFrontmatter: string, candidateFrontmatter: string) {
    const { temp, root } = await fixture("base");
    const candidate = join(temp, "candidate");
    await mkdir(candidate, { recursive: true });
    await writeFile(join(root, "SKILL.md"), `---\n${baseFrontmatter}\n---\nBody\n`);
    await writeFile(join(candidate, "SKILL.md"), `---\n${candidateFrontmatter}\n---\nBody\n`);
    return { temp, base: root, candidate };
  }

  it("escapes a hostile frontmatter key in the informational comparison (§12.1, §15)", async () => {
    const key = `ho${ESC}[31mstile`;
    const { temp } = await twoTrees("name: demo", `name: demo\n${yamlQuoted(key)}: plain`);
    const result = await run(["diff", "base", "candidate"], temp);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("ho\\x1B[31mstile: (absent) -> plain");
    expect(forbiddenCharacter(result.stdout)).toBeNull();
  });

  it("bounds a hostile frontmatter key at the key display limit (§12.1)", async () => {
    const key = `k${"y".repeat(400)}`;
    const { temp } = await twoTrees("name: demo", `name: demo\n${yamlQuoted(key)}: plain`);
    const result = await run(["diff", "base", "candidate"], temp);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain(`  ${key.slice(0, 64)}…: (absent) -> plain`);
    expect(result.stdout).not.toContain(key);
  });

  it("escapes control characters inside nested keys and list items (§12.1, §15)", async () => {
    const { temp } = await twoTrees(
      "name: demo",
      `name: demo\nnested:\n  - ${yamlQuoted(`${ESC}[31mitem`)}\n  - ${yamlQuoted(`${ESC}[0mkey`)}: ${yamlQuoted(`${C1_CSI}31mvalue`)}`,
    );
    const result = await run(["diff", "base", "candidate"], temp);
    expect(result.code).toBe(2);
    // Nested values reach the renderer through JSON.stringify, which escapes
    // C0 itself; the C1 introducer is escaped by the sanitizer, not by JSON.
    expect(result.stdout).toContain("nested: (absent) -> [");
    expect(forbiddenCharacter(result.stdout)).toBeNull();
    expect(result.stdout.includes(ESC)).toBe(false);
    expect(result.stdout.includes(C1_CSI)).toBe(false);
  });
});

describe("check human output over a hostile lock (§9.4, §9.5, §15)", () => {
  /** Locks a plain skill and returns the parsed record for hand-editing. */
  async function lockedRecord(): Promise<{ temp: string; record: Record<string, unknown> }> {
    const { temp, root } = await fixture("skill");
    await skillWithDescription(root, "plain");
    const locked = await run(["lock", "skill", "--out", "a.lock.json"], temp);
    expect(locked.code).toBe(0);
    const record = JSON.parse(await readFile(join(temp, "a.lock.json"), "utf8")) as Record<string, unknown>;
    return { temp, record };
  }

  it("emits no control byte for a lock whose declared_source carries an escape sequence (§9.4, §15)", async () => {
    const { temp, record } = await lockedRecord();
    record.declared_source = {
      kind: "git",
      repository: `${ESC}]0;evil${BEL}https://example.invalid/repo`,
      verification: "user_supplied",
    };
    await writeFile(join(temp, "source.lock.json"), `${JSON.stringify(record, null, 2)}\n`);
    const result = await run(["check", "skill", "--against", "source.lock.json"], temp);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Match:");
    expect(forbiddenCharacter(result.stdout + result.stderr)).toBeNull();
  });

  it("rejects a recorded path carrying an escape sequence with exit 3 and a sanitized message (§4.2, §9.5)", async () => {
    const { temp, record } = await lockedRecord();
    const files = record.files as { path: string }[];
    files[0]!.path = `${ESC}[31mSKILL.md`;
    await writeFile(join(temp, "path.lock.json"), `${JSON.stringify(record, null, 2)}\n`);
    const result = await run(["check", "skill", "--against", "path.lock.json"], temp);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("Invalid approval record (shape)");
    expect(result.stdout).toBe("");
    expect(forbiddenCharacter(result.stderr)).toBeNull();
  });

  it("rejects a raw control byte inside the lock JSON at the syntax step (§9.5)", async () => {
    const { temp, record } = await lockedRecord();
    const serialized = JSON.stringify(record, null, 2).replace('"artifact_path": "skill"', `"artifact_path": "sk${ESC}ill"`);
    await writeFile(join(temp, "raw.lock.json"), `${serialized}\n`);
    const result = await run(["check", "skill", "--against", "raw.lock.json"], temp);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("Invalid approval record (syntax)");
    expect(forbiddenCharacter(result.stderr)).toBeNull();
  });
});

describe("--json output keeps exact bytes (§9.1, §12.1)", () => {
  it("round-trips an untrusted frontmatter value through lock --json unsanitized (§9.1)", async () => {
    const payload = `${ESC}[31m${C1_CSI}31m${String.fromCodePoint(0x202e)}${DEL}raw`;
    const { temp, root } = await fixture("skill");
    await skillWithDescription(root, payload);
    const result = await run(["lock", "skill", "--out", "a.lock.json", "--json"], temp);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { skill: { frontmatter: { description: string } } };
    expect(parsed.skill.frontmatter.description).toBe(payload);
    expect(result.stdout).not.toContain("\\x1B");
  });

  it("round-trips an untrusted frontmatter value through diff --json unsanitized (§12.1)", async () => {
    const payload = `${ESC}[31m${String.fromCodePoint(0x2066)}raw`;
    const { temp, root } = await fixture("base");
    const candidate = join(temp, "candidate");
    await mkdir(candidate, { recursive: true });
    await skillWithDescription(root, "plain");
    await skillWithDescription(candidate, payload);
    const result = await run(["diff", "base", "candidate", "--json"], temp);
    expect(result.code).toBe(2);
    const parsed = JSON.parse(result.stdout) as {
      candidate: { skill: { frontmatter: { description: string } } };
    };
    expect(parsed.candidate.skill.frontmatter.description).toBe(payload);
  });
});

describe("no raw control byte reaches a terminal in human mode (§15)", () => {
  const payloads: [string, string][] = [
    ["C0 SGR", `${ESC}[31mred${ESC}[0m`],
    ["OSC 8 hyperlink", `${ESC}]8;;http://x${BEL}text${ESC}]8;;${BEL}`],
    ["OSC title", `${ESC}]0;evil${BEL}`],
    ["C1 CSI", `${C1_CSI}31mred`],
    ["DEL", `del${DEL}here`],
    ["carriage return", `safe${CR}EVIL`],
    ["bidi override", `a${String.fromCodePoint(0x202e)}b`],
    ["bidi isolates", `a${String.fromCodePoint(0x2066)}b${String.fromCodePoint(0x2069)}c`],
    ["zero width", `a${String.fromCodePoint(0x200b)}b${String.fromCodePoint(0xfeff)}c`],
    ["separators", `a${String.fromCodePoint(0x2028)}b${String.fromCodePoint(0x2029)}c`],
    ["100 KB value", "A".repeat(100_000)],
    ["markdown", "</details>[x](javascript:alert(1))| a | b |"],
  ];

  it.each(payloads)("keeps lock, check, and diff output clean for %s (§15)", async (_label, payload) => {
    const { temp, root } = await fixture("base");
    const candidate = join(temp, "candidate");
    await mkdir(candidate, { recursive: true });
    await skillWithDescription(root, "plain");
    await skillWithDescription(candidate, payload);
    const locked = await run(["lock", "base", "--out", "base.lock.json"], temp);
    expect(locked.code).toBe(0);

    const outputs = [
      await run(["lock", "candidate", "--out", "candidate.lock.json"], temp),
      await run(["check", "candidate", "--against", "base.lock.json"], temp),
      await run(["diff", "base", "candidate"], temp),
    ];
    expect(outputs.map((output) => output.code)).toEqual([0, 2, 2]);
    for (const output of outputs) {
      expect(forbiddenCharacter(output.stdout)).toBeNull();
      expect(forbiddenCharacter(output.stderr)).toBeNull();
    }
  });
});
