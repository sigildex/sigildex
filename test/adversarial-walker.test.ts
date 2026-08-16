import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, readdir, realpath, rename, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { canonicalManifest, lock, validateRecordedPath, walkSkill, type WalkResult } from "../src/index.js";
import { walkSkillWithTestLimits } from "../src/identity/walk.js";
import { fixture, writeSkill } from "./helpers.js";

/** Code points are built numerically: several are invisible in source. */
const cp = (value: number) => String.fromCodePoint(value);

function expectFailure(result: WalkResult) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a walk failure");
  return result;
}

function expectSuccess(result: WalkResult) {
  if (!result.ok) throw new Error(`expected walk success, got ${result.rule}: ${result.message}`);
  return result;
}

/** §6.1 interoperability: the same digest a reviewer gets from the platform's standard tool. */
async function externalDigest(path: string): Promise<string> {
  const { stdout } = process.platform === "darwin"
    ? await promisify(execFile)("shasum", ["-a", "256", path])
    : await promisify(execFile)("sha256sum", [path]);
  return stdout.trim().split(/\s+/)[0]!;
}

/** Pass-2 comparison tuple (§6.2): the fields a mutation has to leave untouched to escape. */
async function identityOf(path: string) {
  const stats = await stat(path, { bigint: true });
  return { ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs };
}

describe("adversarial: recorded-path form and traversal (§4.1, §4.2)", () => {
  it("§4.1: validateRecordedPath rejects every non-relative-POSIX form", () => {
    for (const bad of ["", ".", "..", "../x", "a/../b", "/abs", "a//b", "./a", "a/", "a/./b", "/", "a/.."]) {
      expect(validateRecordedPath(bad), `expected rejection of ${JSON.stringify(bad)}`).not.toBeNull();
    }
    // allowDot is the §9.1 artifact_path carve-out for the literal "." only.
    expect(validateRecordedPath(".", true)).toBeNull();
    expect(validateRecordedPath("..", true)).not.toBeNull();
    expect(validateRecordedPath("./a", true)).not.toBeNull();
  });

  it("§4.2: validateRecordedPath rejects control characters and lone surrogates, not backslash", () => {
    expect(validateRecordedPath(`a${cp(0x0a)}b`)).toBe("path contains a control character");
    expect(validateRecordedPath(`a${cp(0x0d)}b`)).toBe("path contains a control character");
    expect(validateRecordedPath(`a${cp(0x7f)}b`)).toBe("path contains a control character");
    expect(validateRecordedPath(`a${"\uD800"}b`)).toBe("path is not valid UTF-8");
    // §4.2 has no rule for `\`, trailing `.`, or trailing space: POSIX names, accepted by design.
    expect(validateRecordedPath("back\\slash/x")).toBeNull();
    expect(validateRecordedPath("trail./trail ")).toBeNull();
  });

  it("§9.1 + §4.1: lock refuses a traversing or absolute artifact_path, accepts \".\"", async () => {
    const { root, temp, lockPath } = await fixture();
    await writeSkill(root);
    const attempt = (artifactPath: string) =>
      lock({ skillRoot: root, outputPath: lockPath, approvalId: "approval", artifactPath });
    for (const bad of ["../escape", "a/../../escape", "/etc/passwd", "a/", "./a", ""]) {
      expect((await attempt(bad)).kind, `expected rejection of ${JSON.stringify(bad)}`).toBe("tool_error");
    }
    expect((await lock({ skillRoot: root, outputPath: join(temp, "dot.lock.json"), approvalId: "dot", artifactPath: "." })).kind)
      .toBe("locked");
  });

  it("§3.3: an output path aliasing into the tree through a symlink is refused before walking", async () => {
    const { temp, root } = await fixture();
    await writeSkill(root);
    await symlink(root, join(temp, "alias"));
    const viaAlias = await lock({
      skillRoot: root, outputPath: join(temp, "alias", "sneaky.lock.json"), approvalId: "sneaky", artifactPath: "skill",
    });
    expect(viaAlias.kind).toBe("tool_error");
    expect(await readdir(root)).toEqual(["SKILL.md"]);
    // The lexical form of the same rule, and the non-aliasing sibling that must still succeed.
    expect((await lock({ skillRoot: root, outputPath: join(root, "in.lock.json"), approvalId: "in", artifactPath: "skill" })).kind)
      .toBe("tool_error");
    expect((await lock({ skillRoot: root, outputPath: join(temp, "ok.lock.json"), approvalId: "ok", artifactPath: "skill" })).kind)
      .toBe("locked");
  });

  it("§3.1/§3.2: dot-prefixed and dot-containing names are in scope; only .git and .sigildex are pruned", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    await mkdir(join(root, "..foo"));
    await mkdir(join(root, "a..b"));
    await mkdir(join(root, ".git"));
    await mkdir(join(root, ".sigildex"));
    await writeFile(join(root, ".hidden"), "h");
    await writeFile(join(root, ".DS_Store"), "junk");
    await writeFile(join(root, "..foo", "x"), "x");
    await writeFile(join(root, "a..b", "y"), "y");
    await writeFile(join(root, ".git", "config"), "secret");
    await writeFile(join(root, ".sigildex", "cache"), "secret");
    const walked = expectSuccess(await walkSkill(root));
    // §7.2 byte order: "..foo/x" precedes ".DS_Store" because 0x2e < 0x44 at the second byte.
    expect(walked.manifest.map((file) => file.path))
      .toEqual(["..foo/x", ".DS_Store", ".hidden", "SKILL.md", "a..b/y"]);
    for (const entry of walked.manifest) expect(validateRecordedPath(entry.path)).toBeNull();
  });
});

describe("adversarial: symlink escape and TOCTOU (§5, §6.2)", () => {
  it("§5.3: a skill root reached through a symlink is resolved and walked, not refused", async () => {
    const { temp, root } = await fixture("real");
    await writeSkill(root);
    const linkedRoot = join(temp, "linked");
    await symlink(root, linkedRoot);
    const viaLink = expectSuccess(await walkSkill(linkedRoot));
    const direct = expectSuccess(await walkSkill(root));
    expect(viaLink.root).toBe(await realpath(root));
    expect(viaLink.rootDigest).toBe(direct.rootDigest);
  });

  it("§5.1 / row 2: a symlink escaping the tree fails closed with its recorded path named", async () => {
    const { temp, root } = await fixture();
    await writeSkill(root);
    const outside = join(temp, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "loot"), "loot");
    await mkdir(join(root, "nested"));
    await symlink(join(outside, "loot"), join(root, "nested", "escape"));
    const failed = expectFailure(await walkSkill(root));
    expect(failed.rule).toBe("entry_type");
    expect(failed.path).toBe("nested/escape");
  });

  it("§5.4: a hard link to a file outside the tree is an ordinary regular file", async () => {
    const { temp, root } = await fixture();
    await writeSkill(root);
    const outside = join(temp, "outside.txt");
    await writeFile(outside, "shared bytes\n");
    await link(outside, join(root, "hard.txt"));
    const walked = expectSuccess(await walkSkill(root));
    const entry = walked.manifest.find((file) => file.path === "hard.txt");
    expect(entry?.sha256).toBe(createHash("sha256").update("shared bytes\n").digest("hex"));
    expect(entry?.size).toBe(13);
  });

  it("§6.2 pass 2: a directory replaced by a symlink to identical content fails closed", async () => {
    const { temp, root } = await fixture();
    await writeSkill(root);
    await mkdir(join(root, "a"));
    await writeFile(join(root, "a", "f.txt"), "same bytes\n");
    const decoy = join(temp, "decoy");
    await mkdir(decoy);
    await writeFile(join(decoy, "f.txt"), "same bytes\n");
    const failed = expectFailure(await walkSkill(root, {
      hooks: { afterPass1: async () => {
        await rm(join(root, "a"), { recursive: true });
        await symlink(decoy, join(root, "a"));
      } },
    }));
    expect(failed.rule).toBe("mutation");
    expect(failed.path).toBe("a");
  });

  it("§6.2 pass 2: a regular file replaced by a symlink to identical bytes fails closed", async () => {
    const { temp, root } = await fixture();
    await writeSkill(root);
    const target = join(root, "f.txt");
    await writeFile(target, "same bytes\n");
    const decoy = join(temp, "decoy.txt");
    await writeFile(decoy, "same bytes\n");
    const failed = expectFailure(await walkSkill(root, {
      hooks: { afterPass1: async () => { await unlink(target); await symlink(decoy, target); } },
    }));
    expect(failed.rule).toBe("mutation");
    expect(failed.path).toBe("f.txt");
  });
});

describe("adversarial: mid-walk mutation (§6.2, row 4)", () => {
  it("§6.2 pass 2: an ancestor-directory swap with an identical name list is caught by the directory lstat", async () => {
    const { temp, root } = await fixture();
    await writeSkill(root);
    await mkdir(join(root, "a"));
    await writeFile(join(root, "a", "f.txt"), "same bytes\n");
    const replacement = join(temp, "replacement");
    await mkdir(replacement);
    await writeFile(join(replacement, "f.txt"), "same bytes\n");
    const failed = expectFailure(await walkSkill(root, {
      hooks: { afterPass1: async () => {
        await rename(join(root, "a"), join(temp, "a-old"));
        await rename(replacement, join(root, "a"));
      } },
    }));
    expect(failed.rule).toBe("mutation");
    // The root's entry list is unchanged ("a" is still "a"): only the inode check can see this.
    expect(failed.path).toBe("a");
    expect(await readdir(root)).toEqual(expect.arrayContaining(["SKILL.md", "a"]));
  });

  it("§6.2 pass 2: a file replaced by a directory of the same name fails closed", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    const target = join(root, "swap");
    await writeFile(target, "x");
    const failed = expectFailure(await walkSkill(root, {
      hooks: { afterPass1: async () => { await unlink(target); await mkdir(target); } },
    }));
    expect(failed.rule).toBe("mutation");
    expect(failed.path).toBe("swap");
  });

  it("§6.2 pass 2 + §6.3: an executable-bit flip between passes is caught via ctime alone", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    const target = join(root, "run.sh");
    await writeFile(target, "#!/bin/sh\n");
    await chmod(target, 0o644);
    const before = await identityOf(target);
    const failed = expectFailure(await walkSkill(root, {
      hooks: { afterPass1: () => chmod(target, 0o755) },
    }));
    const after = await identityOf(target);
    // Non-vacuous: chmod moves neither size, inode, nor mtime — ctime is the only discriminator.
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.ctimeNs).not.toBe(before.ctimeNs);
    expect(failed.rule).toBe("mutation");
    expect(failed.path).toBe("run.sh");
  });

  it("§6.2 pass 2: a same-size, mtime-restored in-place rewrite is still caught via ctime", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    const target = join(root, "stealth.txt");
    await writeFile(target, "aaa");
    // Whole-second timestamps so the hook can restore mtime exactly through utimes().
    await utimes(target, 1_700_000_000, 1_700_000_000);
    const before = await identityOf(target);
    const failed = expectFailure(await walkSkill(root, {
      hooks: { afterPass1: async () => {
        await writeFile(target, "bbb");
        await utimes(target, 1_700_000_000, 1_700_000_000);
      } },
    }));
    const after = await identityOf(target);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(failed.rule).toBe("mutation");
    expect(failed.path).toBe("stealth.txt");
  });

  it("§6.2 pass 1 step 3d: a file appended to mid-read fails on the hashed-bytes vs fstat-size check", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    const target = join(root, "grow.txt");
    await writeFile(target, "abc");
    let appended = false;
    const failed = expectFailure(await walkSkill(root, {
      hooks: { afterFileChunk: async (path) => {
        if (path === "grow.txt" && !appended) { appended = true; await writeFile(target, "abcd"); }
      } },
    }));
    expect(failed.rule).toBe("mutation");
    expect(failed.path).toBe("grow.txt");
    expect(failed.message).toContain("Hashed byte count");
  });
});

describe("adversarial: binary, empty, and limit boundaries (§3.1, §10, §11)", () => {
  it("§6.1: a file of all 256 byte values matches Node and the platform sha256 tool", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    const target = join(root, "all-bytes.bin");
    await writeFile(target, bytes);
    const walked = expectSuccess(await walkSkill(root));
    const entry = walked.manifest.find((file) => file.path === "all-bytes.bin");
    expect(entry?.size).toBe(256);
    expect(entry?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(entry?.sha256).toBe(await externalDigest(target));
    // Known answer for SHA-256 over the octets 0x00..0xFF.
    expect(entry?.sha256).toBe("40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880");
  });

  it("§8.1: a zero-byte file is in scope and serializes with size 0 and the '-' flag", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    await writeFile(join(root, "empty.bin"), "");
    await chmod(join(root, "empty.bin"), 0o644);
    const walked = expectSuccess(await walkSkill(root));
    const entry = walked.manifest.find((file) => file.path === "empty.bin");
    expect(entry).toMatchObject({ size: 0, executable: false });
    expect(entry?.sha256).toBe(createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
  });

  it("§10.3 / row 10: a zero-byte SKILL.md locks with frontmatter_status \"missing\"", async () => {
    const { root, lockPath } = await fixture();
    await writeFile(join(root, "SKILL.md"), "");
    const result = await lock({ skillRoot: root, outputPath: lockPath, approvalId: "approval", artifactPath: "skill" });
    expect(result.kind).toBe("locked");
    if (result.kind !== "locked") return;
    expect(result.record.skill).toEqual({ frontmatter_status: "missing", frontmatter: null });
    expect(result.record.files[0]).toMatchObject({ path: "SKILL.md", size: 0 });
  });

  it("§11: excluded entries do not count toward maxFiles but do count toward maxEntries", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    await writeFile(join(root, "x.txt"), "x");
    await mkdir(join(root, ".git"));
    await mkdir(join(root, ".sigildex"));
    await writeFile(join(root, ".git", "a"), "a");
    await writeFile(join(root, ".git", "b"), "b");
    await writeFile(join(root, ".sigildex", "c"), "c");
    // Two in-scope files with five excluded ones present: maxFiles=2 must still pass.
    expect(expectSuccess(await walkSkillWithTestLimits(root, { limits: { maxFiles: 2 } })).manifest).toHaveLength(2);
    const overFiles = expectFailure(await walkSkillWithTestLimits(root, { limits: { maxFiles: 1 } }));
    expect(overFiles.limit).toBe("maxFiles");
    // Four root entries (.git, .sigildex, SKILL.md, x.txt): the excluded two consume budget.
    expect((await walkSkillWithTestLimits(root, { limits: { maxEntries: 4 } })).ok).toBe(true);
    const overEntries = expectFailure(await walkSkillWithTestLimits(root, { limits: { maxEntries: 3 } }));
    expect(overEntries.limit).toBe("maxEntries");
  });
});

describe("adversarial: Unicode and normalization (§4.1, §4.2, §4.3)", () => {
  it("§4.2: only U+0000-U+001F and U+007F are control-rejected; U+0085/2028/202E/200B/FEFF are recorded verbatim", async () => {
    const { root } = await fixture();
    await writeSkill(root);
    const names = [
      `c${cp(0x0085)}x`, `d${cp(0x2028)}x`, `e${cp(0x202e)}x`, `f${cp(0x200b)}x`, `g${cp(0xfeff)}x`,
    ];
    for (const name of names) await writeFile(join(root, name), "x");
    const walked = expectSuccess(await walkSkill(root));
    for (const name of names) expect(walked.manifest.some((file) => file.path === name)).toBe(true);
    // Rejected side of the same rule, proving the boundary is exactly the §4.2 set.
    await writeFile(join(root, `h${cp(0x1f)}x`), "x");
    expect(expectFailure(await walkSkill(root)).rule).toBe("name");
  });

  it("§4.1/§4.3: NFC and NFD spellings of the same name are distinct identities, never normalized", async () => {
    const nfc = await fixture("nfc");
    const nfd = await fixture("nfd");
    await writeSkill(nfc.root);
    await writeSkill(nfd.root);
    const nfcName = `${cp(0x00e9)}.txt`;
    const nfdName = `e${cp(0x0301)}.txt`;
    await writeFile(join(nfc.root, nfcName), "same\n");
    await writeFile(join(nfd.root, nfdName), "same\n");
    // Precondition: the filesystem preserved the bytes we wrote (APFS and ext4 both do).
    const onDisk = (entries: Buffer[]) => entries.map((entry) => entry.toString("hex")).sort();
    expect(onDisk(await readdir(nfc.root, { encoding: "buffer" })))
      .not.toEqual(onDisk(await readdir(nfd.root, { encoding: "buffer" })));
    const walkedNfc = expectSuccess(await walkSkill(nfc.root));
    const walkedNfd = expectSuccess(await walkSkill(nfd.root));
    expect(walkedNfc.manifest.map((file) => file.path)).toContain(nfcName);
    expect(walkedNfd.manifest.map((file) => file.path)).toContain(nfdName);
    expect(walkedNfc.rootDigest).not.toBe(walkedNfd.rootDigest);
  });
});

describe("adversarial: cross-platform determinism (§8.4, §13.4)", () => {
  it("§8.4/§13.4: the fixed fixture tree reproduces its known-answer root digest", async () => {
    const { root } = await fixture();
    await mkdir(join(root, "bin"));
    await mkdir(join(root, "docs"));
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "empty-dir"));
    const write = async (relative: string, contents: Buffer | string, mode: number) => {
      await writeFile(join(root, relative), contents);
      await chmod(join(root, relative), mode);
    };
    await write("SKILL.md", "---\nname: kat\ndescription: determinism\n---\nBody\n", 0o644);
    await write("bin/all-bytes.bin", Buffer.from(Array.from({ length: 256 }, (_, index) => index)), 0o644);
    await write(`docs/${cp(0x65e5)}${cp(0x672c)}.txt`, "cross-platform\n", 0o644);
    await write("empty.bin", "", 0o644);
    await write("scripts/run.sh", "#!/bin/sh\necho hi\n", 0o755);
    const walked = expectSuccess(await walkSkill(root));
    expect(walked.manifest.map((file) => file.path)).toEqual([
      "SKILL.md", "bin/all-bytes.bin", `docs/${cp(0x65e5)}${cp(0x672c)}.txt`, "empty.bin", "scripts/run.sh",
    ]);
    expect(walked.manifest.map((file) => file.executable)).toEqual([false, false, false, false, true]);
    // The canonical §8.1 lines and the §8.2 digest below were derived independently of this
    // implementation, by materialising this exact tree and running the §8.3 shell recipe
    // (shasum -a 256 / stat -f '%Lp') on macOS/APFS. CI re-runs this test on Linux, where the
    // same literals must hold — that equality is the §13.4 cross-platform identity assertion.
    const canonical =
      "sigildex-root-digest-v1\n" +
      "9dbcd82fa60c490c9d20c3ca8395a77a08de5f5beddabf523b39a6cf1aac0933 48 - SKILL.md\n" +
      "40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880 256 - bin/all-bytes.bin\n" +
      `5666b4b099755df93fcefb7781f5eed1e40fd391ab0c63bc3c74a53263c08551 15 - docs/${cp(0x65e5)}${cp(0x672c)}.txt\n` +
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 0 - empty.bin\n" +
      "299001868fb8c02fd431c336c6d058f5558c5dff5b5af5e6fe04b870a6a9cbba 18 x scripts/run.sh\n";
    expect(canonicalManifest(walked.manifest)).toBe(canonical.slice("sigildex-root-digest-v1\n".length));
    expect(createHash("sha256").update(canonical, "utf8").digest("hex"))
      .toBe("438e2eac21ef40bfac4113aa81e42b7cdf62963ef250579a04145ee55c52e3e7");
    expect(walked.rootDigest)
      .toBe("sha256:438e2eac21ef40bfac4113aa81e42b7cdf62963ef250579a04145ee55c52e3e7");
  });
});
