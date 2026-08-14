import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diff, type DiffReport, type DiffResult } from "../src/index.js";
import { fixture, writeSkill } from "./helpers.js";

async function trees(): Promise<{ base: string; candidate: string }> {
  const base = await fixture("base");
  const candidate = await fixture("candidate");
  await writeSkill(base.root);
  await writeSkill(candidate.root);
  return { base: base.root, candidate: candidate.root };
}

function reportOf(result: DiffResult): DiffReport {
  if (result.kind === "tool_error") throw new Error(result.message);
  return result.report;
}

describe("diff report contract", () => {
  it("reports identical trees with equal digests and no entries", async () => {
    const { base, candidate } = await trees();
    await writeFile(join(base, "a.txt"), "same");
    await writeFile(join(candidate, "a.txt"), "same");
    const result = await diff({ basePath: base, candidatePath: candidate });
    expect(result.kind).toBe("identical");
    const report = reportOf(result);
    expect(report.base.root_digest).toBe(report.candidate.root_digest);
    expect([report.added, report.removed, report.changed]).toEqual([[], [], []]);
  });

  it("reports a content-only change with content_changed alone", async () => {
    const { base, candidate } = await trees();
    await writeFile(join(base, "a.txt"), "before");
    await writeFile(join(candidate, "a.txt"), "after");
    const result = await diff({ basePath: base, candidatePath: candidate });
    expect(result.kind).toBe("different");
    const report = reportOf(result);
    expect(report.added).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(report.changed).toHaveLength(1);
    expect(report.changed[0]).toMatchObject({
      path: "a.txt",
      class: "reference",
      content_changed: true,
      mode_changed: false,
    });
    expect(report.changed[0]!.base.sha256).not.toBe(report.changed[0]!.candidate.sha256);
  });

  it("reports an executable-bit-only flip with mode_changed alone", async () => {
    const { base, candidate } = await trees();
    await writeFile(join(base, "run.py"), "print(1)\n", { mode: 0o644 });
    await writeFile(join(candidate, "run.py"), "print(1)\n", { mode: 0o644 });
    await chmod(join(candidate, "run.py"), 0o755);
    const report = reportOf(await diff({ basePath: base, candidatePath: candidate }));
    expect(report.changed).toHaveLength(1);
    expect(report.changed[0]).toMatchObject({ path: "run.py", content_changed: false, mode_changed: true });
    expect(report.changed[0]!.base.executable).toBe(false);
    expect(report.changed[0]!.candidate.executable).toBe(true);
  });

  it("reports a combined content and mode change as one entry with both booleans", async () => {
    const { base, candidate } = await trees();
    await writeFile(join(base, "run.py"), "print(1)\n", { mode: 0o644 });
    await writeFile(join(candidate, "run.py"), "print(2)\n", { mode: 0o755 });
    await chmod(join(candidate, "run.py"), 0o755);
    const report = reportOf(await diff({ basePath: base, candidatePath: candidate }));
    expect(report.changed).toHaveLength(1);
    expect(report.changed[0]).toMatchObject({ path: "run.py", content_changed: true, mode_changed: true });
  });

  it("takes class from the candidate for added and changed, from the base for removed", async () => {
    const { base, candidate } = await trees();
    await writeFile(join(base, "gone.sh"), "echo gone\n");
    await writeFile(join(base, "tool.data"), "payload", { mode: 0o644 });
    await writeFile(join(candidate, "tool.data"), "payload", { mode: 0o644 });
    await chmod(join(candidate, "tool.data"), 0o755);
    await writeFile(join(candidate, "new.png"), "binary");
    const report = reportOf(await diff({ basePath: base, candidatePath: candidate }));
    expect(report.added).toMatchObject([{ path: "new.png", class: "asset" }]);
    expect(report.removed).toMatchObject([{ path: "gone.sh", class: "script" }]);
    // The base classifies tool.data as `other`; only the candidate's executable
    // bit makes it a script, and the entry must carry the candidate's class.
    expect(report.changed).toMatchObject([
      { path: "tool.data", class: "script", content_changed: false, mode_changed: true },
    ]);
  });

  it("orders categories and byte-wise orders paths within each category", async () => {
    const { base, candidate } = await trees();
    for (const name of ["Zulu.txt", "alpha.txt", "mike.txt"]) await writeFile(join(base, name), "base");
    for (const name of ["Kilo.txt", "alpha.txt", "mike.txt"]) await writeFile(join(candidate, name), "candidate");
    await writeFile(join(base, "alpha.txt"), "same");
    await writeFile(join(candidate, "alpha.txt"), "same");
    const report = reportOf(await diff({ basePath: base, candidatePath: candidate }));
    expect(Object.keys(report)).toEqual([
      "schema_version",
      "base",
      "candidate",
      "added",
      "removed",
      "changed",
    ]);
    expect(report.added.map((entry) => entry.path)).toEqual(["Kilo.txt"]);
    expect(report.removed.map((entry) => entry.path)).toEqual(["Zulu.txt"]);
    expect(report.changed.map((entry) => entry.path)).toEqual(["mike.txt"]);
  });

  it("orders many paths byte-wise, uppercase before lowercase", async () => {
    const { base, candidate } = await trees();
    for (const name of ["mike.txt", "Zulu.txt", "alpha2.txt", "Alpha.txt"]) {
      await writeFile(join(candidate, name), "new");
    }
    const report = reportOf(await diff({ basePath: base, candidatePath: candidate }));
    expect(report.added.map((entry) => entry.path)).toEqual([
      "Alpha.txt",
      "Zulu.txt",
      "alpha2.txt",
      "mike.txt",
    ]);
  });

  it("carries exactly the report contract keys and no computed frontmatter diff", async () => {
    const { base, candidate } = await trees();
    await writeFile(join(base, "gone.txt"), "gone");
    await writeFile(join(candidate, "new.txt"), "new");
    await writeFile(join(base, "same.txt"), "one");
    await writeFile(join(candidate, "same.txt"), "two");
    const report = reportOf(await diff({ basePath: base, candidatePath: candidate }));
    expect(Object.keys(report).sort()).toEqual(
      ["added", "base", "candidate", "changed", "removed", "schema_version"].sort(),
    );
    expect(report.schema_version).toBe(1);
    for (const side of [report.base, report.candidate]) {
      expect(Object.keys(side)).toEqual(["root_digest", "skill"]);
      // Byte-wise sorted key order inside the skill object.
      expect(Object.keys(side.skill)).toEqual(["frontmatter", "frontmatter_status"]);
    }
    for (const entry of [...report.added, ...report.removed]) {
      expect(Object.keys(entry)).toEqual(["path", "class", "sha256", "size", "executable"]);
    }
    for (const entry of report.changed) {
      expect(Object.keys(entry)).toEqual([
        "path",
        "class",
        "content_changed",
        "mode_changed",
        "base",
        "candidate",
      ]);
      expect(Object.keys(entry.base)).toEqual(["sha256", "size", "executable"]);
      expect(Object.keys(entry.candidate)).toEqual(["sha256", "size", "executable"]);
    }
    expect(JSON.stringify(report)).not.toContain("frontmatter_diff");
  });

  it("orders frontmatter keys byte-wise in both skill objects", async () => {
    const { base, candidate } = await trees();
    await writeSkill(base, "zeta: 1\nname: demo\nAlpha: 2");
    await writeSkill(candidate, "name: demo\nAlpha: 2\nzeta: 1");
    const report = reportOf(await diff({ basePath: base, candidatePath: candidate }));
    expect(report.base.skill.frontmatter_status).toBe("ok");
    expect(Object.keys(report.base.skill.frontmatter ?? {})).toEqual(["Alpha", "name", "zeta"]);
    expect(Object.keys(report.candidate.skill.frontmatter ?? {})).toEqual(["Alpha", "name", "zeta"]);
  });
});

describe("diff fail-closed behavior", () => {
  it("fails on a symlink in the base tree without emitting a report", async () => {
    const { base, candidate } = await trees();
    await symlink(join(base, "SKILL.md"), join(base, "link.md"));
    const result = await diff({ basePath: base, candidatePath: candidate });
    expect(result).toMatchObject({ kind: "tool_error", side: "base" });
    expect(result).not.toHaveProperty("report");
  });

  it("fails on a symlink in the candidate tree without emitting a report", async () => {
    const { base, candidate } = await trees();
    await symlink(join(candidate, "SKILL.md"), join(candidate, "link.md"));
    const result = await diff({ basePath: base, candidatePath: candidate });
    expect(result).toMatchObject({ kind: "tool_error", side: "candidate" });
    expect(result).not.toHaveProperty("report");
  });

  it("fails when the base tree has no SKILL.md", async () => {
    const { base, candidate } = await trees();
    await rm(join(base, "SKILL.md"));
    await writeFile(join(base, "other.md"), "no skill");
    const result = await diff({ basePath: base, candidatePath: candidate });
    expect(result).toMatchObject({ kind: "tool_error", side: "base" });
    if (result.kind === "tool_error") expect(result.message).toContain("SKILL.md");
  });

  it("fails when the candidate tree has no SKILL.md", async () => {
    const { base, candidate } = await trees();
    await rm(join(candidate, "SKILL.md"));
    await writeFile(join(candidate, "other.md"), "no skill");
    const result = await diff({ basePath: base, candidatePath: candidate });
    expect(result).toMatchObject({ kind: "tool_error", side: "candidate" });
  });

  it("fails when a directory is not a skill directory at all", async () => {
    const { base, candidate } = await trees();
    await mkdir(join(candidate, "nested"), { recursive: true });
    const result = await diff({ basePath: base, candidatePath: join(candidate, "missing") });
    expect(result).toMatchObject({ kind: "tool_error", side: "candidate" });
  });
});
