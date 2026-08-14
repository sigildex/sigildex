import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function fixture(skill = "skill") {
  const temp = await mkdtemp(join(tmpdir(), "sigildex-test-"));
  const root = join(temp, skill);
  await mkdir(root, { recursive: true });
  return { temp, root, lockPath: join(temp, "approval.lock.json") };
}

export async function writeSkill(root: string, frontmatter = "name: demo") {
  await writeFile(join(root, "SKILL.md"), `---\n${frontmatter}\n---\nInstructions\n`);
}
