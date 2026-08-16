import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  check,
  computeRootDigest,
  LIMITATIONS,
  lock,
  serializeApprovalRecord,
  validateApprovalRecord,
  walkSkill,
  type ApprovalRecord,
} from "../src/index.js";
import { fixture, writeSkill } from "./helpers.js";
import { walkSkillWithTestLimits } from "../src/identity/walk.js";

async function validLock(): Promise<{ root: string; lockPath: string; record: ApprovalRecord }> {
  const { root, lockPath } = await fixture();
  await writeSkill(root);
  await writeFile(join(root, "x.txt"), "x");
  const result = await lock({
    skillRoot: root, outputPath: lockPath, approvalId: "approval", artifactPath: "skills/demo",
    createdAt: "2026-08-14T12:34:56.123456789Z",
  });
  if (result.kind !== "locked") throw new Error(result.message);
  return { root, lockPath, record: result.record };
}

function validateObject(value: unknown) {
  return validateApprovalRecord(`${JSON.stringify(value)}\n`);
}

describe("approval-record five-step validation", () => {
  it("rejects duplicate JSON keys anywhere", async () => {
    const { record } = await validLock();
    const duplicateTop = `{"schema_version":1,${JSON.stringify(record).slice(1)}`;
    expect(validateApprovalRecord(duplicateTop)).toMatchObject({ ok: false, step: "syntax" });
    const json = JSON.stringify(record).replace('"frontmatter_status":"ok"', '"frontmatter_status":"ok","frontmatter_status":"ok"');
    expect(validateApprovalRecord(json)).toMatchObject({ ok: false, step: "syntax" });
  });

  it("rejects a UTF-8 BOM", async () => {
    const { record } = await validLock();
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(record))]);
    expect(validateApprovalRecord(bytes)).toMatchObject({ ok: false, step: "syntax" });
  });

  it("rejects unsorted files[]", async () => {
    const { record } = await validLock();
    const changed = structuredClone(record);
    changed.files.reverse();
    expect(validateObject(changed)).toMatchObject({ ok: false, step: "manifest_integrity" });
  });

  it("rejects duplicate manifest paths", async () => {
    const { record } = await validLock();
    const changed = structuredClone(record);
    changed.files.splice(1, 1, { ...changed.files[0]! });
    expect(validateObject(changed)).toMatchObject({ ok: false, step: "manifest_integrity" });
  });

  it("rejects a tampered root_digest", async () => {
    const { record } = await validLock();
    expect(validateObject({ ...record, root_digest: `sha256:${"0".repeat(64)}` }))
      .toMatchObject({ ok: false, step: "internal_consistency" });
  });

  it("rejects unknown top-level and files[] keys", async () => {
    const { record } = await validLock();
    expect(validateObject({ ...record, surprise: true })).toMatchObject({ ok: false, step: "shape" });
    const nested = structuredClone(record) as ApprovalRecord & { files: Array<ApprovalRecord["files"][number] & { surprise?: boolean }> };
    nested.files[0]!.surprise = true;
    expect(validateObject(nested)).toMatchObject({ ok: false, step: "shape" });
  });

  it("rejects unsupported versions before shape", async () => {
    const { record } = await validLock();
    const changed = { ...record, schema_version: 2, surprise: true };
    expect(validateObject(changed)).toMatchObject({ ok: false, step: "versions" });
  });

  it("rejects manifest component collisions", async () => {
    const { record } = await validLock();
    const changed = structuredClone(record);
    changed.files = [
      { path: "A/x", sha256: "0".repeat(64), size: 0, executable: false, class: "other" },
      { path: "a/y", sha256: "0".repeat(64), size: 0, executable: false, class: "other" },
    ];
    changed.root_digest = computeRootDigest(changed.files);
    expect(validateObject(changed)).toMatchObject({ ok: false, step: "manifest_integrity" });
  });

  it("accepts the exact closed schema and limitations literal", async () => {
    const { record } = await validLock();
    expect(record.limitations).toBe(LIMITATIONS);
    expect(validateApprovalRecord(serializeApprovalRecord(record)).ok).toBe(true);
  });
});

describe("fixed fail-closed matrix and check evaluation order", () => {
  it("row 8: lock rejects a tree missing root SKILL.md", async () => {
    const { root, lockPath } = await fixture();
    await writeFile(join(root, "other"), "x");
    expect((await lock({ skillRoot: root, outputPath: lockPath, approvalId: "approval", artifactPath: "skill" })).kind)
      .toBe("tool_error");
  });

  it("row 10: malformed frontmatter proceeds and is recorded invalid", async () => {
    const { root, lockPath } = await fixture();
    await writeFile(join(root, "SKILL.md"), "---\na: [broken\n---\n");
    const result = await lock({ skillRoot: root, outputPath: lockPath, approvalId: "approval", artifactPath: "skill" });
    expect(result.kind).toBe("locked");
    if (result.kind === "locked") expect(result.record.skill).toEqual({ frontmatter_status: "invalid", frontmatter: null });
  });

  it("row 11a: missing lock is a tool_error and does not walk", async () => {
    const { temp } = await fixture();
    const result = await check({ skillRoot: join(temp, "also-missing"), lockPath: join(temp, "missing.lock") });
    expect(result.kind).toBe("tool_error");
  });

  it("row 11b: acquired invalid lock is invalid_lock and does not walk", async () => {
    const { temp, lockPath } = await fixture();
    await writeFile(lockPath, "not json");
    const result = await check({ skillRoot: join(temp, "missing"), lockPath });
    expect(result.kind).toBe("invalid_lock");
  });

  it("rows 12 and 13: reports drift only after a complete walk, then matches restored bytes", async () => {
    const { root, lockPath } = await validLock();
    await writeFile(join(root, "x.txt"), "changed");
    const drift = await check({ skillRoot: root, lockPath });
    expect(drift.kind).toBe("drift");
    if (drift.kind === "drift") expect(drift.report.modified.map((entry) => entry.path)).toEqual(["x.txt"]);
    await writeFile(join(root, "x.txt"), "x");
    expect((await check({ skillRoot: root, lockPath })).kind).toBe("match");
  });

  it("walk failure during check is tool_error, never drift", async () => {
    const { root, lockPath } = await validLock();
    await (await import("node:fs/promises")).symlink("missing", join(root, "bad-link"));
    expect((await check({ skillRoot: root, lockPath })).kind).toBe("tool_error");
  });

  it("ignores class, skill, created_at, tool_version, and declared_source differences", async () => {
    const { root, lockPath, record } = await validLock();
    const changed = structuredClone(record);
    changed.files[0]!.class = changed.files[0]!.class === "other" ? "asset" : "other";
    changed.skill = { frontmatter_status: "missing", frontmatter: null };
    changed.created_at = "2000-00-00T00:00:00Z";
    changed.tool_version = "99.0.0";
    changed.declared_source = { verification: "user_supplied", repository: "unverified" };
    await writeFile(lockPath, serializeApprovalRecord(changed));
    expect((await check({ skillRoot: root, lockPath })).kind).toBe("match");
  });
});

describe("streaming and aggregate limits", () => {
  it("aborts when a concurrently growing file crosses the streaming cap", async () => {
    const { root } = await fixture();
    const target = join(root, "grow");
    await writeFile(target, "abc");
    let grown = false;
    const result = await walkSkillWithTestLimits(root, {
      limits: { maxFileBytes: 3 },
      hooks: { afterFileChunk: async (path) => {
        if (path === "grow" && !grown) { grown = true; await appendFile(target, "d"); }
      } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.limit).toBe("maxFileBytes");
  });

  it("enforces total actual bytes hashed", async () => {
    const { root } = await fixture();
    await writeFile(join(root, "a"), "abc");
    await writeFile(join(root, "b"), "def");
    const exact = await walkSkillWithTestLimits(root, { limits: { maxTotalBytes: 6 } });
    expect(exact.ok).toBe(true);
    const over = await walkSkillWithTestLimits(root, { limits: { maxTotalBytes: 5 } });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.limit).toBe("maxTotalBytes");
  });
});
