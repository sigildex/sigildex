import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli/main.js";
import { fixture, writeSkill } from "./helpers.js";

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

async function lockedFixture(): Promise<{ temp: string; root: string; lockPath: string }> {
  const { temp, root } = await fixture("skill");
  await writeSkill(root, "name: demo\ndescription: a demo skill");
  await writeFile(join(root, "notes.txt"), "reference\n");
  // §9.3: the record's filename is `<approval_id>.lock.json`, and the id is
  // derived from the directory name when --approval-id is not given.
  const lockPath = join(temp, "skill.lock.json");
  const result = await run(["lock", "skill", "--out", "skill.lock.json"], temp);
  expect(result.code).toBe(0);
  return { temp, root, lockPath };
}

describe("cli lock", () => {
  it("locks a skill directory and writes a parseable record", async () => {
    const { temp, lockPath } = await lockedFixture();
    const record: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    expect(record).toMatchObject({
      schema_version: 1,
      spec_version: 1,
      approval_id: "skill",
      artifact_path: "skill",
    });
    const summary = await run(["lock", "skill", "--out", "skill.lock.json"], temp);
    expect(summary.code).toBe(0);
    expect(summary.stdout).toContain("root digest:");
  });

  it("prints the record itself with --json", async () => {
    const { temp } = await lockedFixture();
    const result = await run(["lock", "skill", "--out", "skill.lock.json", "--json"], temp);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { root_digest: string };
    expect(parsed.root_digest.startsWith("sha256:")).toBe(true);
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout).toContain('\n  "spec_version": 1,');
    expect(result.stdout).not.toContain(temp);
  });

  it("refuses to write the record inside the walked tree", async () => {
    const { temp } = await lockedFixture();
    const result = await run(["lock", "skill", "--out", "skill/skill.lock.json"], temp);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Error:");
  });

  it("requires --out", async () => {
    const { temp } = await lockedFixture();
    const result = await run(["lock", "skill"], temp);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--out");
  });

  it("rejects an unknown flag", async () => {
    const { temp } = await lockedFixture();
    const result = await run(["lock", "skill", "--out", "skill.lock.json", "--force"], temp);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Error:");
  });

  it("rejects an unknown command", async () => {
    const { temp } = await lockedFixture();
    const result = await run(["verify", "skill"], temp);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown command");
  });

  it("derives an approval id from an awkward directory name", async () => {
    const { temp } = await fixture("My Skill (v2)!");
    await writeSkill(join(temp, "My Skill (v2)!"));
    const result = await run(["lock", "My Skill (v2)!", "--out", "my-skill-v2.lock.json", "--json"], temp);
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as { approval_id: string }).approval_id).toBe("my-skill-v2");
  });

  it("escapes control characters from frontmatter in human output", async () => {
    const { temp, root } = await fixture("skill");
    const escape = String.fromCharCode(0x1b);
    const bell = String.fromCharCode(0x07);
    await writeFile(
      join(root, "SKILL.md"),
      `---\nname: demo\ndescription: "${escape}[31mred${escape}]0;evil${bell}"\n---\nBody\n`,
    );
    const result = await run(["lock", "skill", "--out", "skill.lock.json"], temp);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("description:");
    expect(result.stdout.includes(escape)).toBe(false);
    expect(result.stdout.includes(bell)).toBe(false);
    expect(result.stdout).toContain("\\x1B[31mred");
  });
});

describe("cli check", () => {
  it("exits 0 when the artifact matches", async () => {
    const { temp } = await lockedFixture();
    const result = await run(["check", "skill", "--against", "skill.lock.json"], temp);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Match");
  });

  it("exits 2 on a tampered artifact and prints the drift report as JSON", async () => {
    const { temp, root } = await lockedFixture();
    await writeFile(join(root, "notes.txt"), "tampered\n");
    const human = await run(["check", "skill", "--against", "skill.lock.json"], temp);
    expect(human.code).toBe(2);
    expect(human.stdout).toContain("notes.txt");
    const json = await run(["check", "skill", "--against", "skill.lock.json", "--json"], temp);
    expect(json.code).toBe(2);
    const report = JSON.parse(json.stdout) as { modified: { path: string }[] };
    expect(report.modified.map((file) => file.path)).toEqual(["notes.txt"]);
  });

  it("exits 2 when a file gains the executable bit", async () => {
    const { temp, root } = await lockedFixture();
    await chmod(join(root, "notes.txt"), 0o755);
    const result = await run(["check", "skill", "--against", "skill.lock.json", "--json"], temp);
    expect(result.code).toBe(2);
    const report = JSON.parse(result.stdout) as { mode_changed: { path: string }[] };
    expect(report.mode_changed.map((file) => file.path)).toEqual(["notes.txt"]);
  });

  it("exits 1 when the record is missing", async () => {
    const { temp } = await lockedFixture();
    const result = await run(["check", "skill", "--against", "absent.lock.json"], temp);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Error:");
  });

  it("exits 3 on a syntactically invalid record", async () => {
    const { temp } = await lockedFixture();
    await writeFile(join(temp, "garbage.lock.json"), "{ this is not json ]\n");
    const result = await run(["check", "skill", "--against", "garbage.lock.json"], temp);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("Invalid approval record (syntax)");
  });

  it("exits 3 on a record with an unsupported schema version", async () => {
    const { temp, lockPath } = await lockedFixture();
    const record = JSON.parse(await readFile(lockPath, "utf8")) as { schema_version: number };
    record.schema_version = 2;
    await writeFile(join(temp, "future.lock.json"), `${JSON.stringify(record, null, 2)}\n`);
    const result = await run(["check", "skill", "--against", "future.lock.json"], temp);
    expect(result.code).toBe(3);
  });

  it("exits 1 when the artifact contains a symlink", async () => {
    const { temp, root } = await lockedFixture();
    await symlink(join(root, "notes.txt"), join(root, "link.txt"));
    const result = await run(["check", "skill", "--against", "skill.lock.json"], temp);
    expect(result.code).toBe(1);
  });
});

describe("cli diff", () => {
  async function twoTrees(): Promise<{ temp: string; base: string; candidate: string }> {
    const { temp, root } = await fixture("base");
    const candidate = join(temp, "candidate");
    await mkdir(candidate, { recursive: true });
    for (const tree of [root, candidate]) {
      await writeSkill(tree);
      await writeFile(join(tree, "notes.txt"), "one\n");
    }
    return { temp, base: root, candidate };
  }

  it("exits 0 on identical trees", async () => {
    const { temp } = await twoTrees();
    const result = await run(["diff", "base", "candidate"], temp);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Identical");
  });

  it("exits 2 on differing trees and prints the report contract with --json", async () => {
    const { temp, candidate } = await twoTrees();
    await writeFile(join(candidate, "notes.txt"), "two\n");
    await writeFile(join(candidate, "extra.py"), "print(1)\n");
    const human = await run(["diff", "base", "candidate"], temp);
    expect(human.code).toBe(2);
    expect(human.stdout).toContain("added (1)");
    expect(human.stdout).toContain("changed (1)");
    const json = await run(["diff", "base", "candidate", "--json"], temp);
    expect(json.code).toBe(2);
    const report = JSON.parse(json.stdout) as Record<string, unknown>;
    expect(Object.keys(report)).toEqual([
      "schema_version",
      "base",
      "candidate",
      "added",
      "removed",
      "changed",
    ]);
    expect(json.stdout).not.toContain(temp);
  });

  it("exits 1 when the base tree contains a symlink", async () => {
    const { temp, base } = await twoTrees();
    await symlink(join(base, "notes.txt"), join(base, "link.txt"));
    const result = await run(["diff", "base", "candidate"], temp);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("base:");
    expect(result.stdout).toBe("");
  });

  it("requires exactly two paths", async () => {
    const { temp } = await twoTrees();
    const result = await run(["diff", "base"], temp);
    expect(result.code).toBe(1);
  });
});

describe("cli shell", () => {
  it("prints usage and a version", async () => {
    const { temp } = await fixture();
    const help = await run(["--help"], temp);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("sigildex lock <skill-path>");
    const version = await run(["--version"], temp);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^sigildex \d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    const bare = await run([], temp);
    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain("Usage:");
  });

  it("refuses to run on Windows before doing any work", async () => {
    const { temp, root } = await fixture("skill");
    await writeSkill(root);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    let code: number;
    try {
      code = await main(["lock", root, "--out", join(temp, "skill.lock.json")]);
    } finally {
      stderr.mockRestore();
      Object.defineProperty(process, "platform", platform);
    }
    expect(code).toBe(1);
    expect(written.join("")).toContain("does not support Windows");
    await expect(readFile(join(temp, "skill.lock.json"), "utf8")).rejects.toThrow();
  });
});
