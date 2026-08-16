import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  check,
  classifyFile,
  computeRootDigest,
  equivalenceKey,
  lock,
  walkSkill,
  type ManifestEntry,
} from "../src/index.js";
import { fixture, writeSkill } from "./helpers.js";

describe("raw content identity and deterministic locks", () => {
  it("locks, checks, and re-locks identically except for created_at", async () => {
    const { temp, root, lockPath } = await fixture();
    await writeSkill(root);
    await mkdir(join(root, "references"));
    await writeFile(join(root, "references", "guide.txt"), "hello\n");
    const first = await lock({
      skillRoot: root, outputPath: lockPath, approvalId: "approval", artifactPath: "skills/demo",
      createdAt: "2026-08-14T10:00:00Z",
    });
    expect(first.kind).toBe("locked");
    expect((await check({ skillRoot: root, lockPath })).kind).toBe("match");
    // The re-lock carries the same approval id, so §9.3 puts it under the same
    // filename — a sibling directory keeps the first record intact.
    await mkdir(join(temp, "second"));
    const second = await lock({
      skillRoot: root, outputPath: join(temp, "second", "approval.lock.json"), approvalId: "approval", artifactPath: "skills/demo",
      createdAt: "2026-08-14T10:00:01Z",
    });
    expect(second.kind).toBe("locked");
    if (first.kind !== "locked" || second.kind !== "locked") return;
    expect(second.record.files).toEqual(first.record.files);
    expect(second.record.root_digest).toBe(first.record.root_digest);
    expect(second.json.replace(second.record.created_at, "TIME")).toBe(first.json.replace(first.record.created_at, "TIME"));
  });

  it("hashes CRLF and BOM files as raw bytes (sha256sum interoperability)", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    const crlf = Buffer.from("one\r\ntwo\r\n", "utf8");
    const bom = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x00]);
    await writeFile(join(root, "crlf.txt"), crlf);
    await writeFile(join(root, "bom.bin"), bom);
    const walked = await walkSkill(root);
    expect(walked.ok).toBe(true);
    if (!walked.ok) return;
    expect(walked.manifest.find((file) => file.path === "crlf.txt")?.sha256)
      .toBe(createHash("sha256").update(crlf).digest("hex"));
    expect(walked.manifest.find((file) => file.path === "bom.bin")?.sha256)
      .toBe(createHash("sha256").update(bom).digest("hex"));
    const digestCommand = process.platform === "darwin"
      ? (path: string) => promisify(execFile)("shasum", ["-a", "256", path])
      : (path: string) => promisify(execFile)("sha256sum", [path]);
    for (const filename of ["crlf.txt", "bom.bin"]) {
      const { stdout } = await digestCommand(join(root, filename));
      expect(walked.manifest.find((file) => file.path === filename)?.sha256).toBe(stdout.trim().split(/\s+/)[0]);
    }
  });

  it("matches the independently constructed root-digest known answer", async () => {
    const { root } = await fixture();
    const skill = Buffer.from("---\nname: kat\n---\n");
    const a = Buffer.from("A\r\n");
    const bom = Buffer.from([0xef, 0xbb, 0xbf, 0]);
    await writeFile(join(root, "SKILL.md"), skill);
    await writeFile(join(root, "a.txt"), a);
    await writeFile(join(root, "bom.bin"), bom);
    const walked = await walkSkill(root);
    expect(walked.ok).toBe(true);
    if (!walked.ok) return;
    const manualCanonical =
      "sigildex-root-digest-v1\n" +
      "08b8bd4ed9c8a425a31a8d08b80f936574edc1ded183095bd7eb3e63cb17f00c 18 - SKILL.md\n" +
      "26ffd5886253906a36a7ea0f6e26056fc36472626cb4894bcb100a34dc69d1db 3 - a.txt\n" +
      "d90004879d3206361b4d16d8dcc8005882aecd94cd65670c07c466f64ecc055b 4 - bom.bin\n";
    expect(createHash("sha256").update(manualCanonical).digest("hex"))
      .toBe("76ff5c293627b6357ce8b1dbc8b1b3c4f70cf3410261927aed74f3d5ea0e3889");
    expect(walked.rootDigest).toBe("sha256:76ff5c293627b6357ce8b1dbc8b1b3c4f70cf3410261927aed74f3d5ea0e3889");
  });

  it("detects executable-bit drift", async () => {
    const { root, lockPath } = await fixture();
    await writeSkill(root);
    const script = join(root, "run.sh");
    await writeFile(script, "#!/bin/sh\n");
    const locked = await lock({ skillRoot: root, outputPath: lockPath, approvalId: "approval", artifactPath: "skill" });
    expect(locked.kind).toBe("locked");
    await chmod(script, 0o755);
    const checked = await check({ skillRoot: root, lockPath });
    expect(checked.kind).toBe("drift");
    if (checked.kind === "drift") expect(checked.report.mode_changed.map((entry) => entry.path)).toEqual(["run.sh"]);
  });

  it("root digest excludes classification", () => {
    const base: ManifestEntry[] = [{ path: "x", sha256: "0".repeat(64), size: 0, executable: false, class: "other" }];
    expect(computeRootDigest([{ ...base[0]!, class: "script" }])).toBe(computeRootDigest(base));
  });

  it("applies classification in fixed first-match order", () => {
    expect(classifyFile("SKILL.md", true)).toBe("instructions");
    expect(classifyFile("notes.MDX", true)).toBe("reference");
    expect(classifyFile("run.PY", false)).toBe("script");
    expect(classifyFile("unknown", true)).toBe("script");
    expect(classifyFile("Dockerfile", false)).toBe("config");
    expect(classifyFile("image.SVG", false)).toBe("asset");
    expect(classifyFile("blob", false)).toBe("other");
  });

  it("pins Unicode 15.1 NFC plus simple-case-fold equivalence", () => {
    expect(equivalenceKey("Ä.txt")).toBe(equivalenceKey("ä.txt"));
    expect(equivalenceKey("é.txt")).toBe(equivalenceKey("e\u0301.txt"));
    expect(equivalenceKey(".git")).toBe(equivalenceKey(".GIT"));
  });
});
