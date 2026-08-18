import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error -- the site builder is plain ESM JavaScript with no declarations.
import { DEMO_TRANSCRIPT } from "../scripts/build-site.mjs";

/**
 * The transcript is the front page's central claim: this is what the tool
 * prints. So it is replayed here rather than trusted — the example trees are
 * copied to a temporary directory, every command in the transcript is run
 * against them, and both the stdout and the exit code must match the page.
 * A transcript that drifts from the tool fails the build.
 */

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repositoryRoot, "dist", "cli", "index.js");
const examples = join(repositoryRoot, "examples", "version-drift");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the built CLI without a shell, so no argument is ever re-parsed. */
function run(args: readonly string[], cwd: string): Promise<Run> {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [cliPath, ...args], { cwd, encoding: "utf8", timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolvePromise({ code, stdout, stderr });
    });
  });
}

interface Step {
  /** The transcript's own command line, for failure messages. */
  command: string;
  argv: string[];
  stdout: string;
  exitCode: number;
}

/**
 * Reads the transcript back into the commands that produced it. A `$ ` line
 * starts a block and everything up to the next one is that command's output;
 * blank lines inside a block are part of the output, and the blank line that
 * separates two blocks is not. Each command is followed by `echo $?`, whose
 * output is the exit code to expect.
 */
/** The `echo $?` block must show exactly one integer, so a missing line never reads as 0. */
function parseExitCode(command: string, output: readonly string[]): number {
  expect(output, `"echo $?" after "${command}" must print exactly one line`).toHaveLength(1);
  expect(output[0], `"echo $?" after "${command}" must print an integer`).toMatch(/^\d+$/);
  return Number(output[0]);
}

function parseTranscript(transcript: string): Step[] {
  const blocks: Array<{ command: string; output: string[] }> = [];
  for (const line of transcript.split("\n")) {
    if (line.startsWith("$ ")) blocks.push({ command: line.slice(2), output: [] });
    else blocks[blocks.length - 1]?.output.push(line);
  }
  for (const block of blocks) {
    while (block.output.length > 0 && block.output[block.output.length - 1] === "") block.output.pop();
  }

  const steps: Step[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.command === "echo $?") continue;
    const codeBlock = blocks[index + 1];
    expect(codeBlock?.command, `no "echo $?" follows: ${block.command}`).toBe("echo $?");
    const argv = block.command.split(/\s+/);
    expect(argv[0], `transcript runs something other than sigildex: ${block.command}`).toBe("sigildex");
    steps.push({
      command: block.command,
      argv: argv.slice(1),
      // Real stdout ends with a newline; the transcript drops the last one.
      stdout: block.output.length === 0 ? "" : `${block.output.join("\n")}\n`,
      exitCode: parseExitCode(block.command, codeBlock!.output),
    });
  }
  return steps;
}

describe("the transcript on the front page", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "sigildex-transcript-"));
    // `cp` preserves the executable bit, which is part of what the second
    // check is meant to notice.
    for (const tree of ["skill-v1", "skill-v2"]) {
      await cp(join(examples, tree), join(workspace, tree), { recursive: true });
    }
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("is the three commands it appears to be", () => {
    const steps = parseTranscript(DEMO_TRANSCRIPT as string);
    expect(steps.map((step) => step.argv[0])).toEqual(["lock", "check", "check"]);
    expect(steps.map((step) => step.exitCode)).toEqual([0, 0, 2]);
  });

  it("reproduces byte for byte against the example trees", async () => {
    for (const step of parseTranscript(DEMO_TRANSCRIPT as string)) {
      const result = await run(step.argv, workspace);
      expect(result.stdout, `stdout differs from the page for: ${step.command}`).toBe(step.stdout);
      // The page shows a terminal, which would show stderr too; nothing may be hidden.
      expect(result.stderr, `stderr is not empty for: ${step.command}`).toBe("");
      expect(result.code, `exit code differs from the page for: ${step.command}`).toBe(step.exitCode);
    }
  });
});
