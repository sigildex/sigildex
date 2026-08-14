import { chmod, mkdir, open, symlink, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lock, validateRecordedPath, walkSkill } from "../src/index.js";
import { walkSkillWithTestLimits } from "../src/identity/walk.js";
import { fixture, writeSkill } from "./helpers.js";

async function expectRule(root: string, rule: string) {
  const result = await walkSkill(root);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.rule).toBe(rule);
}

describe("fail-closed walker", () => {
  it("rejects a missing root (matrix row 1)", async () => {
    const { temp } = await fixture();
    await expectRule(join(temp, "missing"), "root");
  });

  for (const [label, target] of [["file", "target"], ["directory", "dir"], ["dangling", "missing"]] as const) {
    it(`rejects a symlink to a ${label}`, async () => {
      const { root } = await fixture();
      await writeSkill(root);
      if (label === "file") await writeFile(join(root, "target"), "x");
      if (label === "directory") await mkdir(join(root, "dir"));
      await symlink(target, join(root, `link-${label}`));
      await expectRule(root, "entry_type");
    });
  }

  it("type-validates a .git symlink before exclusion", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    await symlink("missing", join(root, ".git"));
    const result = await walkSkill(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.path).toBe(".git");
  });

  it("rejects a special file", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    await promisify(execFile)("mkfifo", [join(root, "fifo")]);
    await expectRule(root, "entry_type");
  });

  it("rejects control-character names", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    await writeFile(join(root, "bad\nname"), "x");
    await expectRule(root, "name");
  });

  it("rejects names unassigned in Unicode 15.1", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    await writeFile(join(root, "\u{1C89}"), "x");
    await expectRule(root, "name");
  });

  it.skipIf(process.platform !== "linux")("rejects non-UTF-8 names", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    const rootBytes = Buffer.from(root);
    const bad = Buffer.concat([rootBytes, Buffer.from("/bad-"), Buffer.from([0xff])]);
    const handle = await open(bad, "w");
    await handle.close();
    await expectRule(root, "name");
  });

  it("rejects overlong components in defense-in-depth validation", async () => {
    expect(validateRecordedPath(`${"a".repeat(256)}/x`)).toContain("255");
    const { root } = await fixture();
    await writeFile(join(root, "four"), "x");
    const result = await walkSkillWithTestLimits(root, { limits: { maxNameBytes: 3 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.limit).toBe("maxNameBytes");
  });

  it.skipIf(process.platform === "darwin")("rejects same-directory simple-case collisions", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    await writeFile(join(root, "Ä.txt"), "x");
    await writeFile(join(root, "ä.txt"), "y");
    const result = await walkSkill(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rule).toBe("collision");
  });

  it.skipIf(process.platform === "darwin")("rejects NFC/NFD collisions", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    await writeFile(join(root, "é.txt"), "x");
    await writeFile(join(root, "e\u0301.txt"), "y");
    const result = await walkSkill(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rule).toBe("collision");
  });

  it.skipIf(process.platform === "darwin")("rejects colliding ancestor directories", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    await mkdir(join(root, "A"));
    await mkdir(join(root, "a"));
    await writeFile(join(root, "A", "x"), "x");
    await writeFile(join(root, "a", "y"), "y");
    const result = await walkSkill(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rule).toBe("collision");
  });

  it.skipIf(process.platform === "darwin")("includes excluded names in collision checks", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    await mkdir(join(root, ".git"));
    await mkdir(join(root, ".GIT"));
    await expectRule(root, "collision");
  });

  it("detects a file added between passes", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    const result = await walkSkill(root, { hooks: { afterPass1: () => writeFile(join(root, "late"), "x") } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rule).toBe("mutation");
  });

  it("detects a same-size in-place rewrite between passes", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    const target = join(root, "same");
    await writeFile(target, "aaa");
    const result = await walkSkill(root, { hooks: { afterPass1: () => writeFile(target, "bbb") } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rule).toBe("mutation");
  });

  it("detects a file deleted between passes", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    const target = join(root, "gone");
    await writeFile(target, "x");
    const result = await walkSkill(root, { hooks: { afterPass1: () => unlink(target) } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rule).toBe("mutation");
  });

  it("accepts the file-count limit and rejects limit+1", async () => {
    const at = await fixture("at");
    await writeSkill(at.root);
    for (let index = 1; index < 4096; index += 1) await writeFile(join(at.root, `f${String(index).padStart(4, "0")}`), "");
    expect((await walkSkill(at.root)).ok).toBe(true);
    await writeFile(join(at.root, "overflow"), "");
    const over = await walkSkill(at.root);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.limit).toBe("maxFiles");
  }, 60_000);

  it("accepts the directory-count limit and rejects limit+1", async () => {
    const at = await fixture("directories");
    for (let index = 1; index < 4096; index += 1) await mkdir(join(at.root, `d${String(index).padStart(4, "0")}`));
    expect((await walkSkill(at.root)).ok).toBe(true);
    await mkdir(join(at.root, "overflow"));
    const over = await walkSkill(at.root);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.limit).toBe("maxDirectories");
  }, 60_000);

  it("accepts the per-file byte limit and rejects limit+1 before reading", async () => {
    const at = await fixture("bytes");
    await writeSkill(at.root);
    const exact = await open(join(at.root, "exact.bin"), "w");
    await exact.truncate(67_108_864);
    await exact.close();
    expect((await walkSkill(at.root)).ok).toBe(true);
    const over = await open(join(at.root, "over.bin"), "w");
    await over.truncate(67_108_865);
    await over.close();
    const result = await walkSkill(at.root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.limit).toBe("maxFileBytes");
  }, 60_000);

  it("enforces the traversal-entry counter with empty directories", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    for (let index = 0; index < 4; index += 1) await mkdir(join(root, `d${index}`));
    const result = await walkSkillWithTestLimits(root, { limits: { maxEntries: 4, maxDirectories: 10 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.limit).toBe("maxEntries");
  });

  it("accepts depth 64 and rejects depth 65", async () => {
    const at = await fixture("depth");
    await writeSkill(at.root);
    let current = at.root;
    for (let index = 1; index <= 64; index += 1) { current = join(current, "d"); await mkdir(current); }
    expect((await walkSkill(at.root)).ok).toBe(true);
    await mkdir(join(current, "d"));
    const result = await walkSkill(at.root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.limit).toBe("maxDepth");
  });

  it.skipIf(process.platform === "darwin")("rejects a recorded file path over 1024 UTF-8 bytes", async () => {
    const { root } = await fixture();
    let current = root;
    for (let index = 0; index < 5; index += 1) {
      current = join(current, `${index}${"a".repeat(198)}`);
      await mkdir(current);
    }
    await writeFile(join(current, "z".repeat(30)), "x");
    const result = await walkSkill(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.limit).toBe("maxPathBytes");
  });

  it("refuses a lock output path inside the tree before walking", async () => {
    const { root } = await fixture();
    const result = await lock({ skillRoot: root, outputPath: join(root, "lock.json"), approvalId: "a", artifactPath: "skill" });
    expect(result.kind).toBe("tool_error");
  });

  it.skipIf(process.getuid?.() === 0)("maps unreadable files to a structured read failure", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    const target = join(root, "secret");
    await writeFile(target, "x");
    await chmod(target, 0);
    const result = await walkSkill(root);
    await chmod(target, 0o600);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rule).toBe("read");
  });
});
