#!/usr/bin/env node
// Regenerates the two committed approval records in ./approvals from the two
// skill trees in this directory, using the repository's own built library.
//
// Run `npm run build` at the repository root first, then:
//   node examples/version-drift/generate-locks.mjs
//
// `created_at` is pinned to a fixed synthetic instant so the committed locks
// are byte-stable: regenerating them on an unchanged tree produces identical
// bytes. `created_at` is metadata, never identity (identity-spec §9.1), so the
// pin has no effect on what the records attest. `tool_version` is left at the
// library default, so a version bump does change the committed bytes — also
// metadata, and also never drift (§12).

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lock } from "../../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));

export const CREATED_AT = "2026-08-14T00:00:00Z";

/** The two approval records this example ships, in generation order. */
export const TARGETS = [
  { approvalId: "log-summarizer-v1", directory: "skill-v1" },
  { approvalId: "log-summarizer-v2", directory: "skill-v2" },
];

/**
 * Locks one example tree.
 *
 * @param {{approvalId: string, directory: string}} target
 * @param {string} [outputDirectory] destination for the lock file; defaults to
 *   the committed ./approvals directory. Must never be inside the skill tree
 *   (identity-spec §3.3 refuses that outright).
 */
export async function lockTarget(target, outputDirectory = join(here, "approvals")) {
  await mkdir(outputDirectory, { recursive: true });
  return lock({
    skillRoot: join(here, target.directory),
    outputPath: join(outputDirectory, `${target.approvalId}.lock.json`),
    approvalId: target.approvalId,
    // Project-relative POSIX path of the artifact, per §9.1 / §4.1 — never an
    // absolute local path, so the record is portable across checkouts.
    artifactPath: `examples/version-drift/${target.directory}`,
    createdAt: CREATED_AT,
  });
}

async function main() {
  let failed = false;
  for (const target of TARGETS) {
    const result = await lockTarget(target);
    if (result.kind === "locked") {
      console.log(`wrote ${result.outputPath}`);
      console.log(`  root_digest ${result.record.root_digest}`);
      console.log(`  files       ${result.record.files.length}`);
    } else {
      failed = true;
      console.error(`FAILED ${target.approvalId}: ${result.message}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}

// Only run when invoked directly; verify-example.mjs imports the helpers above.
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
