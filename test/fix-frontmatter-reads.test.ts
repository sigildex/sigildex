import { execFile } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { readSkillFrontmatter } from "../src/index.js";
import { fixture } from "./helpers.js";

/** The reader's buffered read window: the boundary the extraction must not depend on. */
const READ_WINDOW = 16_384;
const HEADER = "---\nname: demo\npadding: ";

/**
 * A body whose `----` line starts at a chosen offset. `----` is not a closing
 * delimiter (§10.2 requires a line of exactly `---`), so the whole block runs to
 * the real terminator and the parse outcome must not depend on where reads split.
 */
function bodyWithFalseDelimiter(paddingLength: number): string {
  return `${HEADER}${"x".repeat(paddingLength)}\n----\nvalue: ok\n---\nBody\n`;
}

async function statusOf(root: string, name: string, body: string) {
  const path = join(root, name);
  await writeFile(path, body);
  return readSkillFrontmatter(path);
}

/** Returns false when the host has no mkfifo, so those cases skip instead of failing. */
async function makeFifo(path: string): Promise<boolean> {
  try {
    await promisify(execFile)("mkfifo", [path], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

describe("frontmatter extraction is independent of read-chunk alignment (§8.4, §10.2)", () => {
  it("§10.2: a `----` line straddling the read boundary yields the same status as one that does not", async () => {
    const { root } = await fixture();
    // Padding chosen so the first read window ends exactly on the "\n---" prefix of "----".
    const aligned = READ_WINDOW - "\n---".length - HEADER.length;
    const onBoundary = await statusOf(root, "aligned.md", bodyWithFalseDelimiter(aligned));
    const offBoundary = await statusOf(root, "shifted.md", bodyWithFalseDelimiter(aligned + 1));
    // The real block contains the `----` line, which is not valid YAML in a block mapping.
    expect(onBoundary.frontmatter_status, "on the boundary").toBe("invalid");
    expect(offBoundary.frontmatter_status, "one byte off the boundary").toBe("invalid");
    expect(onBoundary).toEqual(offBoundary);
  });

  it("§10.2: a real closing delimiter ending exactly on the read boundary still parses", async () => {
    const { root } = await fixture();
    const padding = READ_WINDOW - "\n---".length - HEADER.length;
    const result = await statusOf(root, "boundary.md", `${HEADER}${"x".repeat(padding)}\n---\nBody\n`);
    expect(result.frontmatter_status).toBe("ok");
    expect(result.frontmatter).toEqual({ name: "demo", padding: "x".repeat(padding) });
  });

  it("§10.2: a block closed at end of file without a trailing newline still parses", async () => {
    const { root } = await fixture();
    const result = await statusOf(root, "eof.md", "---\nname: demo\n---");
    expect(result).toEqual({ frontmatter_status: "ok", frontmatter: { name: "demo" } });
  });
});

describe("the frontmatter reader fails closed on unreadable paths (§5, §10)", () => {
  it("§5.2: a FIFO at the SKILL.md path fails fast rather than blocking", async () => {
    const { root } = await fixture();
    const path = join(root, "SKILL.md");
    if (!(await makeFifo(path))) return; // No mkfifo on this host.
    await expect(readSkillFrontmatter(path)).rejects.toThrow(/regular file/);
  }, 10_000);

  it("§5.1: a symlink at the SKILL.md path is never followed", async () => {
    const { root } = await fixture();
    await writeFile(join(root, "real.md"), "---\nname: demo\n---\n");
    await symlink(join(root, "real.md"), join(root, "SKILL.md"));
    await expect(readSkillFrontmatter(join(root, "SKILL.md"))).rejects.toThrow();
  });

  it("§10: a directory or a missing path is a read failure, not `invalid` frontmatter", async () => {
    const { root } = await fixture();
    await mkdir(join(root, "SKILL.md"));
    await expect(readSkillFrontmatter(join(root, "SKILL.md"))).rejects.toThrow();
    await expect(readSkillFrontmatter(join(root, "absent.md"))).rejects.toThrow();
  });

  it("§10.3: content-level problems still record a status and never throw", async () => {
    const { root } = await fixture();
    expect(await statusOf(root, "ok.md", "---\nname: demo\n---\nBody\n"))
      .toEqual({ frontmatter_status: "ok", frontmatter: { name: "demo" } });
    expect((await statusOf(root, "missing.md", "no block here\n")).frontmatter_status).toBe("missing");
    expect((await statusOf(root, "invalid.md", "---\nname: a\nname: b\n---\n")).frontmatter_status).toBe("invalid");
    expect((await statusOf(root, "unterminated.md", "---\nname: demo\n")).frontmatter_status).toBe("invalid");
  });
});
