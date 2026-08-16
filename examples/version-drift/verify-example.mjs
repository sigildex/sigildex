#!/usr/bin/env node
// Verifies every claim this example's README makes, using the repository's own
// built library (never the CLI, so the example stays runnable on its own).
//
//   npm run build && node examples/version-drift/verify-example.mjs
//
// Prints one PASS/FAIL line per claim and exits non-zero if any claim fails.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, diff, lock } from "../../dist/index.js";
import { CREATED_AT, TARGETS, lockTarget } from "./generate-locks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const v1 = join(here, "skill-v1");
const v2 = join(here, "skill-v2");
const lockV1 = join(here, "approvals", "log-summarizer-v1.lock.json");
const lockV2 = join(here, "approvals", "log-summarizer-v2.lock.json");

let failures = 0;

function report(ok, claim, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${claim}${detail === undefined ? "" : ` — ${detail}`}`);
}

/** Maps a library result to the exit code the CLI reports for it (§12). */
function exitCode(result) {
  switch (result.kind) {
    case "match":
      return 0;
    case "drift":
      return 2;
    case "invalid_lock":
      return 3;
    default:
      return 1;
  }
}

async function expectCheck(claim, skillRoot, lockPath, expectedExit) {
  const result = await check({ skillRoot, lockPath });
  const actual = exitCode(result);
  report(actual === expectedExit, claim, `exit ${actual} (${result.kind}), expected ${expectedExit}`);
  return result;
}

function paths(entries) {
  return entries.map((entry) => entry.path).join(",");
}


async function main() {
  const scratch = await mkdtemp(join(tmpdir(), "sigildex-example-"));
  try {
    // 1. The committed locks are exactly what the generator produces today.
    for (const target of TARGETS) {
      const regenerated = await lockTarget(target, scratch);
      const committed = await readFile(join(here, "approvals", `${target.approvalId}.lock.json`), "utf8");
      report(
        regenerated.kind === "locked" && regenerated.json === committed,
        `committed lock is byte-identical to a regeneration at ${CREATED_AT}: ${target.approvalId}`,
      );
    }

    // 2. Install-verify: each tree matches its own approval record.
    await expectCheck("check skill-v1 against the v1 lock is a match", v1, lockV1, 0);
    await expectCheck("check skill-v2 against the v2 lock is a match", v2, lockV2, 0);

    // 3. Drift detection: the v1 approval does not cover the v2 tree.
    const drift = await expectCheck("check skill-v2 against the v1 lock reports drift", v2, lockV1, 2);
    if (drift.kind === "drift") {
      report(paths(drift.report.added) === "scripts/summarize.sh", "drift adds scripts/summarize.sh", paths(drift.report.added));
      report(paths(drift.report.modified) === "SKILL.md", "drift modifies SKILL.md", paths(drift.report.modified));
      report(drift.report.removed.length === 0, "drift removes nothing", `${drift.report.removed.length} removed`);
      report(drift.report.mode_changed.length === 0, "drift flips no executable bit", `${drift.report.mode_changed.length} mode-changed`);
    }

    // 4. Rollback direction: the v2 approval does not cover the v1 tree either.
    const rollback = await expectCheck("check skill-v1 against the v2 lock reports drift", v1, lockV2, 2);
    if (rollback.kind === "drift") {
      report(paths(rollback.report.removed) === "scripts/summarize.sh", "rollback drift removes scripts/summarize.sh", paths(rollback.report.removed));
    }

    // 5. Review: the diff categories the README quotes (§12.1 — a differing
    //    tree pair is exit 2, and every path lands in exactly one category).
    const delta = await diff({ basePath: v1, candidatePath: v2 });
    report(delta.kind === "different", "diff of skill-v1 against skill-v2 reports the trees differ", delta.kind);
    if (delta.kind === "different") {
      const { added, removed, changed } = delta.report;
      report(
        added.length === 1 && added[0].path === "scripts/summarize.sh" &&
          added[0].class === "script" && added[0].executable === true,
        "diff added: scripts/summarize.sh, class script, executable",
      );
      report(removed.length === 0, "diff removed: nothing", `${removed.length} removed`);
      report(
        changed.length === 1 && changed[0].path === "SKILL.md" &&
          changed[0].content_changed === true && changed[0].mode_changed === false,
        "diff changed: SKILL.md, content only",
      );
    }

    // 6. Lock-only metadata edit: still a technical match (§12 — created_at is
    //    metadata, not identity). This is the case CI cannot catch for you.
    const metadataEdited = join(scratch, "metadata-edited.lock.json");
    const v2Text = await readFile(lockV2, "utf8");
    await writeFile(metadataEdited, v2Text.replace('"created_at": "2026-08-14T00:00:00Z"', '"created_at": "2026-08-14T09:00:00Z"'));
    await expectCheck("a lock whose created_at was edited still matches its tree", v2, metadataEdited, 0);

    // 7. Hand-edited manifest: internally inconsistent, so the lock is refused
    //    rather than compared (§9.5 step 5).
    const tampered = join(scratch, "tampered.lock.json");
    await writeFile(tampered, v2Text.replace(/"sha256": "[0-9a-f]{64}"/, `"sha256": "${"0".repeat(64)}"`));
    await expectCheck("a hand-edited manifest is an invalid lock, not drift", v2, tampered, 3);

    // 8. Missing inputs are tool errors, never a verdict (§12 rows 1, 11a).
    await expectCheck("a missing lock file is a tool error", v2, join(scratch, "absent.lock.json"), 1);
    await expectCheck("a missing skill directory is a tool error", join(scratch, "absent-skill"), lockV2, 1);

    // 9. The lock output can never land inside the tree it measures (§3.3). The
    //    filename matches the approval id (§9.3), so self-inclusion is the only
    //    rule this case can be failing.
    const selfInclusion = await lock({
      skillRoot: v2,
      outputPath: join(v2, "log-summarizer-self.lock.json"),
      approvalId: "log-summarizer-self",
      artifactPath: "examples/version-drift/skill-v2",
      createdAt: CREATED_AT,
    });
    report(
      selfInclusion.kind === "tool_error" && selfInclusion.message.includes("beneath the skill root"),
      "writing a lock inside the skill tree is refused",
      selfInclusion.kind === "tool_error" ? selfInclusion.message : "unexpectedly locked",
    );

    // 10. §9.3: the output filename must be `<approval_id>.lock.json`.
    const misnamed = await lock({
      skillRoot: v2,
      outputPath: join(scratch, "approval.lock.json"),
      approvalId: "log-summarizer-v2",
      artifactPath: "examples/version-drift/skill-v2",
      createdAt: CREATED_AT,
    });
    report(
      misnamed.kind === "tool_error" && misnamed.message.includes("log-summarizer-v2.lock.json"),
      "a lock output filename that disagrees with the approval id is refused",
      misnamed.kind === "tool_error" ? misnamed.message : "unexpectedly locked",
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
