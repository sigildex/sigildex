import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, open, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateApprovalRecord } from "../src/index.js";
import { fixture, writeSkill } from "./helpers.js";

/**
 * Adversarial coverage for §12's exit-code contract at the CLI boundary: every
 * error path must produce 1 or 3 — never 0 (false success) and never 2 (a drift
 * verdict a failed run has no business emitting) — and `lock` must leave no lock
 * and no partial temp file behind (§12 preamble, §3.3 row 9).
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

/** A temp project holding `skill/` with a valid SKILL.md and one reference file. */
async function project(): Promise<{ temp: string; root: string }> {
  const { temp, root } = await fixture("skill");
  await writeSkill(root, "name: demo\ndescription: a demo skill");
  await writeFile(join(root, "notes.txt"), "reference\n");
  return { temp, root };
}

async function entries(directory: string): Promise<string[]> {
  return (await readdir(directory)).sort();
}

/** §12: a failed `lock` leaves neither the output nor a visible partial temp file. */
async function expectNothingWritten(directory: string, before: readonly string[]): Promise<void> {
  const after = await entries(directory);
  expect(after, `directory contents of ${directory}`).toEqual([...before]);
  expect(after.some((name) => name.includes(".tmp-")), "leftover temp file").toBe(false);
}

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("§3.3 / §12 row 9: lock --out refusals never write a lock", () => {
  it("row 9: refuses an --out inside the tree reached through `..` from outside", async () => {
    const { temp, root } = await project();
    await mkdir(join(temp, "other"), { recursive: true });
    const before = await entries(root);
    const result = await run(["lock", "skill", "--out", "other/../skill/skill.lock.json"], temp);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("beneath the skill root");
    expect(result.stdout).toBe("");
    await expectNothingWritten(root, before);
  });

  it("row 9: an --out that is a symlink into the tree writes through the link, never into the tree", async () => {
    const { temp, root } = await project();
    await writeFile(join(root, "inside.lock.json"), "{}\n");
    await symlink(join(root, "inside.lock.json"), join(temp, "skill.lock.json"));
    const before = await entries(root);
    const result = await run(["lock", "skill", "--out", "skill.lock.json"], temp);
    // §3.3 forbids a *resolved* output path inside the root, which reads two ways
    // for a final-component symlink: the implementation resolves the containing
    // directory but not the file about to be created. Either way the property
    // §3.3 exists to protect holds — rename(2) replaces the link itself, so no
    // lock and no modification lands inside the walked tree.
    expect([0, 1], `exit ${result.code}`).toContain(result.code);
    await expectNothingWritten(root, before);
    expect(await readFile(join(root, "inside.lock.json"), "utf8"), "link target untouched").toBe("{}\n");
    if (result.code === 0) {
      expect(validateApprovalRecord(await readFile(join(temp, "skill.lock.json"))).ok).toBe(true);
    }
  });

  it("row 9: refuses an --out whose parent directory is a symlink into the tree", async () => {
    const { temp, root } = await project();
    await mkdir(join(root, "sub"), { recursive: true });
    await symlink(join(root, "sub"), join(temp, "aliasdir"));
    const before = await entries(join(root, "sub"));
    const result = await run(["lock", "skill", "--out", "aliasdir/skill.lock.json"], temp);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    await expectNothingWritten(join(root, "sub"), before);
  });

  it("row 9: refuses an --out inside the tree when the skill root is reached through a symlinked ancestor", async () => {
    const { temp } = await fixture("real");
    const real = join(temp, "real", "skill");
    await mkdir(real, { recursive: true });
    await writeSkill(real);
    await symlink(join(temp, "real"), join(temp, "alias"));
    const before = await entries(real);
    // `alias/skill` and `real/skill` are the same directory: the guard must compare
    // resolved paths, not textual ones (this is the shape `/tmp` takes on macOS).
    const result = await run(
      ["lock", "alias/skill", "--out", "alias/skill/skill.lock.json", "--artifact-path", "skill"],
      temp,
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    await expectNothingWritten(real, before);
  });

  it("§12: --out pointing at an existing directory fails without a partial write", async () => {
    const { temp } = await project();
    // Named for the approval id, so the §9.3 filename rule passes and the write
    // itself is what fails.
    await mkdir(join(temp, "skill.lock.json"), { recursive: true });
    const before = await entries(temp);
    const result = await run(["lock", "skill", "--out", "skill.lock.json"], temp);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(await entries(join(temp, "skill.lock.json"))).toEqual([]);
    await expectNothingWritten(temp, before);
  });

  it("§12: --out in a nonexistent directory fails without creating anything", async () => {
    const { temp } = await project();
    const before = await entries(temp);
    const result = await run(["lock", "skill", "--out", "absent/skill.lock.json"], temp);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    await expectNothingWritten(temp, before);
  });

  it.skipIf(isRoot)("§12: --out in a read-only directory fails and leaves it empty", async () => {
    const { temp } = await project();
    const readOnly = join(temp, "readonly");
    await mkdir(readOnly, { recursive: true });
    await chmod(readOnly, 0o555);
    try {
      const result = await run(["lock", "skill", "--out", "readonly/skill.lock.json"], temp);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(await entries(readOnly)).toEqual([]);
    } finally {
      await chmod(readOnly, 0o755);
    }
  });
});

describe("§12 rows 1, 11a, 11b: check acquires, validates, then walks", () => {
  async function locked(): Promise<{ temp: string; root: string }> {
    const created = await project();
    expect((await run(["lock", "skill", "--out", "skill.lock.json"], created.temp)).code).toBe(0);
    return created;
  }

  it("row 11a: --against a directory is an I/O error, exit 1", async () => {
    const { temp } = await locked();
    await mkdir(join(temp, "dir.lock.json"), { recursive: true });
    const result = await run(["check", "skill", "--against", "dir.lock.json"], temp);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Cannot acquire lock");
    expect(result.stdout).toBe("");
  });

  it("row 11b: an empty lock file was acquired, so it fails validation with exit 3", async () => {
    const { temp } = await locked();
    await writeFile(join(temp, "empty.lock.json"), "");
    const result = await run(["check", "skill", "--against", "empty.lock.json"], temp);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("Invalid approval record (syntax)");
    expect(result.stdout).toBe("");
  });

  it("row 11b: /dev/null reads as zero acquired bytes, exit 3", async () => {
    const { temp } = await locked();
    const result = await run(["check", "skill", "--against", "/dev/null"], temp);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
  });

  it("row 11b: a FIFO that yields no bytes is acquired-then-invalid, exit 3", async () => {
    const { temp } = await locked();
    const fifo = join(temp, "fifo.lock.json");
    const made = await new Promise<boolean>((resolvePromise) => {
      execFile("mkfifo", [fifo], { timeout: 30_000 }, (error) => resolvePromise(error === null));
    });
    if (!made) return; // No mkfifo on this host.
    // Both ends block until paired; the writer closes immediately, giving the reader EOF.
    const writer = open(fifo, "w").then((handle) => handle.close());
    const result = await run(["check", "skill", "--against", "fifo.lock.json"], temp);
    await writer;
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
  });

  it("row 1: a skill root that is a regular file fails with exit 1", async () => {
    const { temp } = await locked();
    await writeFile(join(temp, "regular-file"), "not a skill directory\n");
    const result = await run(["check", "regular-file", "--against", "skill.lock.json"], temp);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not a directory");
    expect(result.stdout).toBe("");
  });

  it("§12 step 1: the lock is acquired before the artifact is touched", async () => {
    const { temp } = await locked();
    // Both inputs are broken: the reported failure must be the lock acquisition.
    const both = await run(["check", "absent-skill", "--against", "absent.lock.json"], temp);
    expect(both.code).toBe(1);
    expect(both.stderr).toContain("Cannot acquire lock");
    expect(both.stderr).not.toContain("skill root");
    // Valid lock, missing artifact: the walk error surfaces only after acquisition.
    const walkFailure = await run(["check", "absent-skill", "--against", "skill.lock.json"], temp);
    expect(walkFailure.code).toBe(1);
    expect(walkFailure.stderr).toContain("skill root");
  });

  it("§12 step 2: an invalid record exits 3 without walking, even with a broken artifact", async () => {
    const { temp } = await locked();
    await writeFile(join(temp, "garbage.lock.json"), "{ not json ]\n");
    const result = await run(["check", "absent-skill", "--against", "garbage.lock.json"], temp);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("Invalid approval record");
    expect(result.stderr).not.toContain("skill root");
  });

  it("§12: check without --against is an input error, exit 1", async () => {
    const { temp } = await locked();
    for (const args of [["check", "skill"], ["check", "skill", "--against", ""]]) {
      const result = await run(args, temp);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stderr).toContain("--against");
    }
  });
});

describe("§12.1: diff exit codes", () => {
  it("§12.1: the same directory twice is identical, exit 0", async () => {
    const { temp } = await project();
    const result = await run(["diff", "skill", "skill"], temp);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Identical");
  });

  it("§12.1: a missing path, a third path, or a file path all fail with exit 1 and no report", async () => {
    const { temp } = await project();
    for (const args of [
      ["diff", "skill", "absent"],
      ["diff", "absent", "skill"],
      ["diff", "skill", "skill", "skill"],
      ["diff", "skill", "skill/SKILL.md"],
      ["diff", "skill/SKILL.md", "skill"],
    ]) {
      const result = await run(args, temp);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stdout, args.join(" ")).toBe("");
      expect(result.stderr).toContain("Error:");
    }
  });
});

describe("§12/§15: error reporting is consistent across commands and flags", () => {
  it("§12: --json never turns an error path into stdout output or a different exit code", async () => {
    const { temp } = await project();
    const failures: readonly string[][] = [
      ["lock", "absent-skill", "--out", "absent-skill.lock.json"],
      ["lock", "skill", "--out", "skill/skill.lock.json"],
      ["check", "skill", "--against", "absent.lock.json"],
      ["diff", "skill", "absent"],
    ];
    for (const args of failures) {
      const plain = await run(args, temp);
      const json = await run([...args, "--json"], temp);
      expect(plain.code, args.join(" ")).toBe(1);
      expect(json.code, `${args.join(" ")} --json`).toBe(plain.code);
      // Every command reports errors the same way: nothing on stdout, a prefixed
      // line on stderr. No command emits a JSON error object.
      expect(json.stdout, `${args.join(" ")} --json`).toBe("");
      expect(json.stderr.startsWith("Error: "), `${args.join(" ")} --json`).toBe(true);
      expect(json.stderr.endsWith("\n")).toBe(true);
    }
    // The one non-`Error:` prefix is the §9.5 step report, and it too is stderr-only.
    await writeFile(join(temp, "garbage.lock.json"), "nope");
    const invalid = await run(["check", "skill", "--against", "garbage.lock.json", "--json"], temp);
    expect(invalid.code).toBe(3);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr.startsWith("Invalid approval record (")).toBe(true);
  });

  it("§12: unknown flags, empty values, and stray positionals are input errors, exit 1", async () => {
    const { temp } = await project();
    const rejected: readonly string[][] = [
      ["lock", "skill", "--out", "skill.lock.json", "--force"],
      ["lock", "skill", "--out"],
      ["lock", "skill", "--out="],
      ["lock", "skill"],
      ["lock", "--out", "skill.lock.json"],
      ["lock", "skill", "extra", "--out", "skill.lock.json"],
      ["lock", "-weird", "--out", "skill.lock.json"],
      ["lock", "--", "skill", "--out", "skill.lock.json"],
      ["check", "skill", "--against", "a.lock.json", "--verbose"],
      ["diff", "skill", "skill", "--depth", "2"],
      ["verify", "skill"],
    ];
    const before = await entries(temp);
    for (const args of rejected) {
      const result = await run(args, temp);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stdout, args.join(" ")).toBe("");
    }
    await expectNothingWritten(temp, before);
  });

  it("§12: a repeated flag takes its last value and still writes exactly one lock", async () => {
    const { temp } = await project();
    // §9.3 fixes the filename, so the two candidate destinations differ by directory.
    await mkdir(join(temp, "first"), { recursive: true });
    await mkdir(join(temp, "second"), { recursive: true });
    const result = await run(
      ["lock", "skill", "--out", "first/skill.lock.json", "--out", "second/skill.lock.json", "--json", "--json"],
      temp,
    );
    expect(result.code).toBe(0);
    // Observation, not a spec rule: node:util parseArgs keeps the last value of a
    // repeated string option, so only the second path is written.
    expect(await entries(join(temp, "second"))).toEqual(["skill.lock.json"]);
    expect(await entries(join(temp, "first"))).toEqual([]);
    expect(validateApprovalRecord(await readFile(join(temp, "second", "skill.lock.json"))).ok).toBe(true);
  });

  it("§8.4: two consecutive --json runs print byte-identical stdout", async () => {
    const { temp, root } = await project();
    expect((await run(["lock", "skill", "--out", "skill.lock.json"], temp)).code).toBe(0);
    await writeFile(join(root, "notes.txt"), "drifted\n");
    const checkOne = await run(["check", "skill", "--against", "skill.lock.json", "--json"], temp);
    const checkTwo = await run(["check", "skill", "--against", "skill.lock.json", "--json"], temp);
    expect(checkOne.code).toBe(2);
    expect(checkOne.stdout).toBe(checkTwo.stdout);
    const diffOne = await run(["diff", "skill", "skill", "--json"], temp);
    const diffTwo = await run(["diff", "skill", "skill", "--json"], temp);
    expect(diffOne.code).toBe(0);
    expect(diffOne.stdout).toBe(diffTwo.stdout);
  });
});

describe("§12: a stdout consumer that closes early cannot manufacture a false success", () => {
  it("§12: a closed stdout pipe never yields exit 0 with truncated output, and the lock stays complete", async () => {
    const { temp, root } = await project();
    // The record must exceed any pipe capacity by a wide margin (Linux pipes
    // hold 64 KiB, and the reader below drains one chunk before closing), so a
    // synchronous writer cannot finish the whole record before the read end
    // goes away. 3,000 files with 200-byte names is roughly 900 KiB of JSON.
    const longName = "n".repeat(190);
    await Promise.all(
      Array.from({ length: 3000 }, (_unused, index) =>
        writeFile(join(root, `${longName}-${String(index).padStart(4, "0")}.txt`), "x"),
      ),
    );
    const outcome = await new Promise<{ code: number | null; signal: string | null; received: number; stderr: string }>((resolvePromise) => {
      const child = spawn(process.execPath, [cliPath, "lock", "skill", "--out", "skill.lock.json", "--json"], { cwd: temp });
      let received = 0;
      child.stdout.once("data", (chunk: Buffer) => {
        received += chunk.length;
        child.stdout.destroy();
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("close", (code, signal) => resolvePromise({ code, signal, received, stderr }));
    });

    const bytes = await readFile(join(temp, "skill.lock.json"));
    const validation = validateApprovalRecord(bytes);
    expect(validation.ok, "the lock is written and fsynced before stdout is touched").toBe(true);
    if (validation.ok) expect(validation.record.files.length).toBe(3002);
    expect(bytes.length).toBeGreaterThan(512 * 1024);

    // The drift and invalid-record codes are reserved; a broken pipe is neither.
    expect(outcome.code).not.toBe(2);
    expect(outcome.code).not.toBe(3);
    // The reader took at most one chunk of a record far larger than the pipe,
    // so the child could not have delivered it all: the write rejects with
    // EPIPE, which the CLI reports as a tool error (exit 1) with a one-line
    // message and no stack trace.
    expect(outcome.received).toBeLessThan(bytes.length);
    expect(outcome.code, `signal ${outcome.signal ?? "none"}`).toBe(1);
    expect(outcome.stderr).toContain("stdout closed before the output was written");
    expect(outcome.stderr).not.toContain("node:internal");
  }, 120_000);
});
