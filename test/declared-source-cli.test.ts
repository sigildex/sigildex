import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixture, writeSkill } from "./helpers.js";

/**
 * Two `lock` contracts that meet at the command line.
 *
 * The first is §9.4: `declared_source` is optional, user-supplied, and never
 * verified — so it must be settable without hand-editing a record, and every
 * value must be checked against the same grammar the record validator applies.
 *
 * The second is §9.3: a stored approval's filename derives from and must match
 * its `approval_id`. The tool enforces that at write time, before it walks.
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
      { cwd, encoding: "utf8", timeout: 60_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolvePromise({ code, stdout, stderr });
      },
    );
  });
}

/** A temp project holding `skill/` with a valid SKILL.md and one reference file. */
async function project(): Promise<{ temp: string; root: string }> {
  const { temp, root } = await fixture("skill");
  await writeSkill(root, "name: demo\ndescription: a demo skill");
  await writeFile(join(root, "notes.txt"), "reference\n");
  return { temp, root };
}

interface RecordShape {
  approval_id: string;
  root_digest: string;
  declared_source?: Record<string, string>;
}

const ALL_SOURCE_FLAGS = [
  "--source-kind", "git",
  "--source-repository", "https://example.invalid/org/skills",
  "--source-path", "skills/log-summarizer",
  "--source-commit", "0a1b2c3d4e5f6071",
  "--source-tracking", "pinned-commit",
];

describe("lock --source-* flags write declared_source (§9.4)", () => {
  it("records every member, fixes verification, and leaves the root digest alone", async () => {
    const { temp } = await project();
    const withSource = await run(["lock", "skill", "--out", "skill.lock.json", "--json", ...ALL_SOURCE_FLAGS], temp);
    expect(withSource.code).toBe(0);
    const sourced = JSON.parse(withSource.stdout) as RecordShape;
    expect(sourced.declared_source).toEqual({
      kind: "git",
      repository: "https://example.invalid/org/skills",
      path: "skills/log-summarizer",
      approved_commit: "0a1b2c3d4e5f6071",
      tracking_policy: "pinned-commit",
      verification: "user_supplied",
    });
    // §9.1: declared_source sits outside the root-digest input, so declaring a
    // source can never change what the record identifies.
    await mkdir(join(temp, "plain"), { recursive: true });
    const plain = await run(["lock", "skill", "--out", "plain/skill.lock.json", "--json"], temp);
    expect(plain.code).toBe(0);
    expect((JSON.parse(plain.stdout) as RecordShape).root_digest).toBe(sourced.root_digest);
  });

  it("accepts any subset of the members", async () => {
    const { temp } = await project();
    const result = await run(
      [
        "lock", "skill", "--out", "skill.lock.json", "--json",
        "--source-repository", "https://example.invalid/org/skills",
        "--source-commit", "abcdef0",
      ],
      temp,
    );
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as RecordShape).declared_source).toEqual({
      repository: "https://example.invalid/org/skills",
      approved_commit: "abcdef0",
      verification: "user_supplied",
    });
  });

  it("omits the key entirely when no source flag is given", async () => {
    const { temp } = await project();
    const result = await run(["lock", "skill", "--out", "skill.lock.json", "--json"], temp);
    expect(result.code).toBe(0);
    const record = JSON.parse(result.stdout) as Record<string, unknown>;
    expect("declared_source" in record).toBe(false);
  });

  it("rejects an out-of-grammar value before walking or writing anything", async () => {
    const { temp } = await project();
    const rejected: readonly [string, readonly string[]][] = [
      ["--source-kind", ["--source-kind", "Git"]],
      ["--source-commit", ["--source-commit", "zzzzzzz"]],
      ["--source-path", ["--source-path", "../outside"]],
      ["--source-repository", ["--source-repository", "h".repeat(513)]],
    ];
    for (const [flag, args] of rejected) {
      const before = (await readdir(temp)).sort();
      const result = await run(["lock", "skill", "--out", "skill.lock.json", ...args], temp);
      expect([flag, result.code]).toEqual([flag, 1]);
      expect(result.stdout, flag).toBe("");
      expect(result.stderr, flag).toContain(flag);
      // No lock, and no partial temp file, from a rejected source value.
      expect((await readdir(temp)).sort(), flag).toEqual(before);
    }
  });

  it("escapes a control sequence in a rejected value before printing it", async () => {
    const { temp } = await project();
    const escape = String.fromCharCode(0x1b);
    const result = await run(
      ["lock", "skill", "--out", "skill.lock.json", "--source-kind", `${escape}[31mred`],
      temp,
    );
    expect(result.code).toBe(1);
    expect(result.stderr.includes(escape)).toBe(false);
    expect(result.stderr).toContain("\\x1B[31mred");
  });

  it("produces a record that check accepts", async () => {
    const { temp } = await project();
    expect((await run(["lock", "skill", "--out", "skill.lock.json", ...ALL_SOURCE_FLAGS], temp)).code).toBe(0);
    const checked = await run(["check", "skill", "--against", "skill.lock.json"], temp);
    expect(checked.code).toBe(0);
    expect(checked.stdout).toContain("Match");
  });

  it("documents the flags in the usage text", async () => {
    const { temp } = await project();
    const help = await run(["lock", "--help"], temp);
    expect(help.code).toBe(0);
    for (const flag of ["--source-kind", "--source-repository", "--source-path", "--source-commit", "--source-tracking"]) {
      expect(help.stdout).toContain(flag);
    }
  });
});

describe("lock output filename must match the approval id (§9.3)", () => {
  it("accepts an explicit id whose filename agrees with it", async () => {
    const { temp } = await project();
    const result = await run(["lock", "skill", "--approval-id", "demo", "--out", "demo.lock.json"], temp);
    expect(result.code).toBe(0);
    expect((JSON.parse(await readFile(join(temp, "demo.lock.json"), "utf8")) as RecordShape).approval_id).toBe("demo");
  });

  it("refuses an explicit id whose filename disagrees, writing nothing", async () => {
    const { temp } = await project();
    const before = (await readdir(temp)).sort();
    const result = await run(["lock", "skill", "--approval-id", "alpha", "--out", "beta.lock.json"], temp);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("alpha.lock.json");
    expect((await readdir(temp)).sort()).toEqual(before);
  });

  it("applies the rule to a derived id too", async () => {
    const { temp } = await fixture("demo");
    await writeSkill(join(temp, "demo"), "name: demo\ndescription: a demo skill");
    expect((await run(["lock", "demo", "--out", "demo.lock.json"], temp)).code).toBe(0);
    const mismatch = await run(["lock", "demo", "--out", "approval.lock.json"], temp);
    expect(mismatch.code).toBe(1);
    expect(mismatch.stdout).toBe("");
    expect(mismatch.stderr).toContain('expected "demo.lock.json"');
  });

  it("leaves a pre-existing file at a mismatching --out byte-identical", async () => {
    const { temp } = await project();
    const occupied = join(temp, "beta.lock.json");
    await writeFile(occupied, "{ \"kept\": true }\n");
    const result = await run(["lock", "skill", "--approval-id", "alpha", "--out", "beta.lock.json"], temp);
    expect(result.code).toBe(1);
    expect(await readFile(occupied, "utf8")).toBe("{ \"kept\": true }\n");
    expect((await readdir(temp)).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("applies outside the recommended approvals layout as well as inside it", async () => {
    const { temp } = await project();
    await mkdir(join(temp, ".sigildex", "approvals"), { recursive: true });
    const inside = await run(
      ["lock", "skill", "--approval-id", "demo", "--out", ".sigildex/approvals/other.lock.json"],
      temp,
    );
    expect(inside.code).toBe(1);
    expect(inside.stderr).toContain('expected "demo.lock.json"');
    expect(await readdir(join(temp, ".sigildex", "approvals"))).toEqual([]);
  });
});
