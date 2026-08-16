import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixture } from "./helpers.js";

/**
 * Two concerns that meet at the approval store.
 *
 * The first is §9.3: what the CLI itself enforces about a stored approval's
 * identity — the `approval_id` grammar, the single normalized artifact path,
 * and the refusal to store a record inside the tree it measures.
 *
 * The second is the property the adoption workflow depends on: detecting and
 * staging an update must not touch the installation that is already trusted.
 * `diff` and `check` are read paths, so the active tree's root digest, bytes,
 * modes, and mtimes must all survive an update review unchanged.
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

interface RecordShape {
  approval_id: string;
  artifact_path: string;
  root_digest: string;
}

async function readRecord(path: string): Promise<RecordShape> {
  return JSON.parse(await readFile(path, "utf8")) as RecordShape;
}

/** Writes the two-file skill used as the "installed" artifact throughout. */
async function writeInstalledSkill(root: string, instruction: string): Promise<void> {
  await mkdir(join(root, "reference"), { recursive: true });
  await writeFile(join(root, "SKILL.md"), `---\nname: demo\ndescription: a demo skill\n---\n${instruction}\n`);
  await writeFile(join(root, "reference", "notes.md"), "reference\n");
}

interface FileState {
  path: string;
  size: number;
  mode: number;
  mtimeMs: number;
  sha256: string;
}

/** Records bytes, mode, and mtime for every file under a tree, in path order. */
async function snapshotTree(root: string): Promise<FileState[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  const states: FileState[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath, entry.name);
    const stats = await stat(absolute);
    states.push({
      path: relative(root, absolute),
      size: stats.size,
      mode: stats.mode,
      mtimeMs: stats.mtimeMs,
      sha256: createHash("sha256").update(await readFile(absolute)).digest("hex"),
    });
  }
  return states.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

describe("approval identity rules the CLI enforces (§9.3)", () => {
  it("rejects an approval id outside the §9.1 grammar (§9.3)", async () => {
    const { temp, root } = await fixture("skill");
    await writeInstalledSkill(root, "Instructions");
    // A leading dash is passed with `=` so the argument parser cannot read it
    // as another option; the grammar check is what must reject it.
    const candidates = ["Bad Id", "UPPER", "under_score", "has.dot", "trailing!", "a".repeat(65)];
    for (const candidate of candidates) {
      const result = await run(["lock", "skill", `--approval-id=${candidate}`, "--out", "a.lock.json"], temp);
      expect([candidate, result.code]).toEqual([candidate, 1]);
      expect(result.stderr).toContain("grammar");
    }
    const leadingDash = await run(["lock", "skill", "--approval-id=-leading", "--out", "a.lock.json"], temp);
    expect(leadingDash.code).toBe(1);
    expect(leadingDash.stderr).toContain("grammar");
  });

  it("fails when no approval id can be derived from the directory name (§9.3)", async () => {
    const { temp } = await fixture("!!!");
    await writeInstalledSkill(join(temp, "!!!"), "Instructions");
    const result = await run(["lock", "!!!", "--out", "a.lock.json"], temp);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--approval-id");
  });

  it("derives an approval id that matches the recommended filename (§9.3)", async () => {
    const { temp } = await fixture("Log Summarizer");
    await writeInstalledSkill(join(temp, "Log Summarizer"), "Instructions");
    await mkdir(join(temp, ".sigildex", "approvals"), { recursive: true });
    const output = ".sigildex/approvals/log-summarizer.lock.json";
    const result = await run(["lock", "Log Summarizer", "--out", output], temp);
    expect(result.code).toBe(0);
    const record = await readRecord(join(temp, output));
    expect(`${record.approval_id}.lock.json`).toBe("log-summarizer.lock.json");
  });

  it("records exactly one normalized project-relative artifact path (§9.3, §4.1)", async () => {
    const { temp } = await fixture("project");
    const skillRoot = join(temp, "project", ".claude", "skills", "demo");
    await mkdir(skillRoot, { recursive: true });
    await writeInstalledSkill(skillRoot, "Instructions");
    const result = await run(
      ["lock", ".claude/skills/demo", "--approval-id", "demo", "--out", "demo.lock.json"],
      join(temp, "project"),
    );
    expect(result.code).toBe(0);
    const record = await readRecord(join(temp, "project", "demo.lock.json"));
    expect(record.artifact_path).toBe(".claude/skills/demo");
  });

  it("rejects an artifact path that is absolute or escapes the project (§9.3, §4.1)", async () => {
    const { temp, root } = await fixture("skill");
    await writeInstalledSkill(root, "Instructions");
    for (const candidate of ["../escape", "/etc/skills/demo", "./skill", "skill/", ""]) {
      const result = await run(
        ["lock", "skill", "--artifact-path", candidate, "--out", "skill.lock.json"],
        temp,
      );
      expect([candidate, result.code]).toEqual([candidate, 1]);
    }
  });

  it("refuses to store the approval record inside the artifact it measures (§9.3, §3.3)", async () => {
    const { temp, root } = await fixture("skill");
    await writeInstalledSkill(root, "Instructions");
    const result = await run(
      ["lock", "skill", "--out", "skill/.sigildex/approvals/skill.lock.json"],
      temp,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("beneath the skill root");
  });

  it("checks cleanly against a record stored in the recommended layout (§9.3, §9.5)", async () => {
    const { temp, root } = await fixture("skill");
    await writeInstalledSkill(root, "Instructions");
    await mkdir(join(temp, ".sigildex", "approvals"), { recursive: true });
    const output = ".sigildex/approvals/skill.lock.json";
    expect((await run(["lock", "skill", "--out", output], temp)).code).toBe(0);
    const result = await run(["check", "skill", "--against", output], temp);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Match:");
  });
});

describe("detecting an update never modifies the active installation (§12, §12.1)", () => {
  interface Staged {
    temp: string;
    active: string;
    quarantine: string;
    approval: string;
    rootDigest: string;
  }

  /**
   * Builds the adoption state the guide describes: an approved installation
   * the agent loads, plus a modified candidate staged in a quarantine
   * directory that sits outside the active tree.
   */
  async function stageUpdate(): Promise<Staged> {
    const { temp } = await fixture("active");
    const active = join(temp, "active");
    await writeInstalledSkill(active, "Summarize the log.");
    await mkdir(join(temp, ".sigildex", "approvals"), { recursive: true });
    const approval = ".sigildex/approvals/active.lock.json";
    const locked = await run(["lock", "active", "--approval-id", "active", "--out", approval], temp);
    expect(locked.code).toBe(0);
    const rootDigest = (await readRecord(join(temp, approval))).root_digest;

    const quarantine = join(temp, "quarantine", "active");
    await mkdir(dirname(quarantine), { recursive: true });
    await cp(active, quarantine, { recursive: true });
    await writeFile(join(quarantine, "SKILL.md"), "---\nname: demo\ndescription: a demo skill\n---\nRun the script.\n");
    await mkdir(join(quarantine, "scripts"), { recursive: true });
    await writeFile(join(quarantine, "scripts", "summarize.sh"), "#!/bin/sh\necho hi\n");
    await chmod(join(quarantine, "scripts", "summarize.sh"), 0o755);
    return { temp, active, quarantine, approval, rootDigest };
  }

  it("leaves the active root digest unchanged across detection, diff, and staging (§12, §12.1)", async () => {
    const { temp, approval, rootDigest } = await stageUpdate();

    const difference = await run(["diff", "active", "quarantine/active"], temp);
    expect(difference.code).toBe(2);
    expect(difference.stdout).toContain("scripts/summarize.sh");
    expect(difference.stdout).toContain("SKILL.md");

    const staged = await run(["check", "quarantine/active", "--against", approval], temp);
    expect(staged.code).toBe(2);

    const installed = await run(["check", "active", "--against", approval], temp);
    expect(installed.code).toBe(0);
    expect(installed.stdout).toContain("Match:");

    // The probe carries the same approval id as the stored record, so §9.3 fixes
    // its filename too; a scratch directory keeps the stored record untouched.
    await mkdir(join(temp, "probe"), { recursive: true });
    const recomputed = await run(
      ["lock", "active", "--approval-id", "active", "--out", "probe/active.lock.json", "--json"],
      temp,
    );
    expect(recomputed.code).toBe(0);
    expect((JSON.parse(recomputed.stdout) as RecordShape).root_digest).toBe(rootDigest);
  });

  it("opens the active tree read-only during diff and check (§6.2, §12.1)", async () => {
    const { temp, active, approval } = await stageUpdate();
    const before = await snapshotTree(active);
    expect(before.length).toBeGreaterThan(1);

    expect((await run(["diff", "active", "quarantine/active"], temp)).code).toBe(2);
    expect((await run(["diff", "quarantine/active", "active"], temp)).code).toBe(2);
    expect((await run(["check", "active", "--against", approval], temp)).code).toBe(0);
    expect((await run(["check", "quarantine/active", "--against", approval], temp)).code).toBe(2);

    expect(await snapshotTree(active)).toEqual(before);
  });

  it("binds the new bytes on re-approval and retires the previous record (§9.3, §12)", async () => {
    const { temp, active, quarantine, approval, rootDigest } = await stageUpdate();

    // A human approved the staged change; the new record is taken from the
    // quarantined tree but recorded at the artifact's installed location.
    const reapproved = ".sigildex/approvals/active-v2.lock.json";
    const locked = await run(
      [
        "lock",
        "quarantine/active",
        "--approval-id",
        "active-v2",
        "--artifact-path",
        "active",
        "--out",
        reapproved,
      ],
      temp,
    );
    expect(locked.code).toBe(0);
    const newRecord = await readRecord(join(temp, reapproved));
    expect(newRecord.artifact_path).toBe("active");
    expect(newRecord.root_digest).not.toBe(rootDigest);

    await rm(active, { recursive: true });
    await cp(quarantine, active, { recursive: true });

    expect((await run(["check", "active", "--against", reapproved], temp)).code).toBe(0);
    const stale = await run(["check", "active", "--against", approval], temp);
    expect(stale.code).toBe(2);
    expect(stale.stdout).toContain("scripts/summarize.sh");
  });
});
