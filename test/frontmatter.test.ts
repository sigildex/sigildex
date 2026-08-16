import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lock } from "../src/index.js";
import { fixture } from "./helpers.js";

async function lockSkill(contents: string) {
  const { root, lockPath } = await fixture();
  await writeFile(join(root, "SKILL.md"), contents);
  return lock({ skillRoot: root, outputPath: lockPath, approvalId: "approval", artifactPath: "skill" });
}

describe("bounded SKILL.md frontmatter", () => {
  it("records a missing block", async () => {
    const result = await lockSkill("plain instructions\n");
    expect(result.kind).toBe("locked");
    if (result.kind === "locked") expect(result.record.skill).toEqual({ frontmatter_status: "missing", frontmatter: null });
  });

  it("records a non-mapping document as invalid", async () => {
    const result = await lockSkill("---\n- one\n- two\n---\n");
    expect(result.kind).toBe("locked");
    if (result.kind === "locked") expect(result.record.skill.frontmatter_status).toBe("invalid");
  });

  it("records a non-scalar name as invalid", async () => {
    const result = await lockSkill("---\nname: [not, scalar]\n---\n");
    expect(result.kind).toBe("locked");
    if (result.kind === "locked") expect(result.record.skill.frontmatter_status).toBe("invalid");
  });

  it("does not resolve custom tags", async () => {
    const result = await lockSkill("---\nname: !execute nope\n---\n");
    expect(result.kind).toBe("locked");
    if (result.kind === "locked") expect(result.record.skill.frontmatter_status).toBe("invalid");
  });

  it("enforces the alias expansion budget", async () => {
    const aliases = Array.from({ length: 30 }, () => "*base").join(", ");
    const result = await lockSkill(`---\nbase: &base [x]\nrefs: [${aliases}]\n---\n`);
    expect(result.kind).toBe("locked");
    if (result.kind === "locked") expect(result.record.skill.frontmatter_status).toBe("invalid");
  });
});
