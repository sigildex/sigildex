import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Builds `dist/` exactly once before any test file runs. Several files
 * exercise the CLI as a real executable; building per file raced on the
 * shared output directory.
 */
export function setup(): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile("npm", ["run", "build"], { cwd: repositoryRoot, timeout: 300_000 }, (error, _out, stderr) => {
      if (error !== null) rejectPromise(new Error(`build failed: ${stderr}`));
      else resolvePromise();
    });
  });
}
