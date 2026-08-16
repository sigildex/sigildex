import { execFile } from "node:child_process";
import { mkdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { walkSkill, type WalkResult } from "../src/index.js";
import { fixture, writeSkill } from "./helpers.js";

function expectFailure(result: WalkResult) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a walk failure");
  return result;
}

function expectSuccess(result: WalkResult) {
  if (!result.ok) throw new Error(`expected walk success, got ${result.rule}: ${result.message}`);
  return result;
}

/** Returns false when the host has no mkfifo, so the special-file cases skip instead of failing. */
async function makeFifo(path: string): Promise<boolean> {
  try {
    await promisify(execFile)("mkfifo", [path], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

describe("excluded entries are re-verified in pass 2 (§3.2, §5, §6.2)", () => {
  it("§3.2/§5: a .git directory replaced by a symlink between the passes fails closed", async () => {
    const { temp, root } = await fixture();
    await writeSkill(root);
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), "[core]\n");
    const decoy = join(temp, "decoy");
    await mkdir(decoy);
    const failed = expectFailure(await walkSkill(root, {
      hooks: { afterPass1: async () => {
        await rm(join(root, ".git"), { recursive: true });
        await symlink(decoy, join(root, ".git"));
      } },
    }));
    // The parent's entry-name list is identical either way: only a per-entry check sees this.
    expect(failed.rule).toBe("mutation");
    expect(failed.path).toBe(".git");
    expect(failed.message).toContain(".git");
  });

  it("§3.2/§5: a .sigildex file replaced by a symlink between the passes fails closed", async () => {
    const { temp, root } = await fixture();
    await writeSkill(root);
    await writeFile(join(root, ".sigildex"), "metadata\n");
    const decoy = join(temp, "decoy.txt");
    await writeFile(decoy, "metadata\n");
    const failed = expectFailure(await walkSkill(root, {
      hooks: { afterPass1: async () => {
        await unlink(join(root, ".sigildex"));
        await symlink(decoy, join(root, ".sigildex"));
      } },
    }));
    expect(failed.rule).toBe("mutation");
    expect(failed.path).toBe(".sigildex");
  });

  it("§6.2: an excluded directory swapped for a different directory of the same name fails closed", async () => {
    const { temp, root } = await fixture();
    await writeSkill(root);
    await mkdir(join(root, ".git"));
    const replacement = join(temp, "replacement");
    await mkdir(replacement);
    const failed = expectFailure(await walkSkill(root, {
      hooks: { afterPass1: async () => {
        await rename(join(root, ".git"), join(temp, "git-old"));
        await rename(replacement, join(root, ".git"));
      } },
    }));
    expect(failed.rule).toBe("mutation");
    expect(failed.path).toBe(".git");
  });

  it("§5.2: an excluded entry replaced by a special file between the passes fails closed", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    await writeFile(join(root, ".sigildex"), "metadata\n");
    let made = true;
    const result = await walkSkill(root, {
      hooks: { afterPass1: async () => {
        await unlink(join(root, ".sigildex"));
        made = await makeFifo(join(root, ".sigildex"));
      } },
    });
    if (!made) return; // No mkfifo on this host.
    const failed = expectFailure(result);
    expect(failed.rule).toBe("mutation");
    expect(failed.path).toBe(".sigildex");
  });

  it("§3.2: untouched excluded entries still walk to the unchanged digest", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), "[core]\n");
    await writeFile(join(root, ".sigildex"), "metadata\n");
    await writeFile(join(root, "notes.txt"), "notes\n");
    const baseline = expectSuccess(await walkSkill(root));
    const observed = expectSuccess(await walkSkill(root, { hooks: { afterPass1: () => undefined } }));
    expect(observed.manifest.map((file) => file.path)).toEqual(["SKILL.md", "notes.txt"]);
    expect(observed.rootDigest).toBe(baseline.rootDigest);
  });

  it("§3.2: content churn beneath an excluded directory is not a mutation", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), "[core]\n");
    const walked = expectSuccess(await walkSkill(root, {
      hooks: { afterPass1: () => writeFile(join(root, ".git", "config"), "[core]\n\trewritten = 1\n") },
    }));
    expect(walked.manifest.map((file) => file.path)).toEqual(["SKILL.md"]);
  });
});

describe("open discipline for in-scope files (§5, §6.2)", () => {
  it("§6.2: a file swapped for a FIFO between its lstat and its open fails fast", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    const target = join(root, "swap.txt");
    await writeFile(target, "bytes\n");
    let made = true;
    const result = await walkSkill(root, {
      hooks: { beforeFileOpen: async (recordedPath) => {
        if (recordedPath !== "swap.txt") return;
        await unlink(target);
        made = await makeFifo(target);
      } },
    });
    if (!made) return; // No mkfifo on this host.
    const failed = expectFailure(result);
    expect(failed.path).toBe("swap.txt");
    expect(failed.rule).toBe("mutation");
  }, 10_000);
});
