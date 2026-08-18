# Code map

Where each documented claim is implemented, and which tests hold it in place.
Pick a claim, open the file that implements it, then the tests that would fail
if it stopped being true.

Paths are relative to the repository root. Specification references are section
numbers in [identity-spec.md](identity-spec.md).

| Claim or subsystem | Specification or document | Implementation | Primary tests |
|---|---|---|---|
| Canonical manifest line and root digest | §8.1–§8.4 | `src/identity/canonical.ts` | `test/identity-core.test.ts`, `test/adversarial-serialization.test.ts` |
| Deterministic record bytes: integer sizes, key order | §9.1, §9.2, §12.1 | `src/lock.ts` (`serializeJsonDocument`, `serializeApprovalRecord`) | `test/adversarial-serialization.test.ts`, `test/fix-reports-and-output.test.ts` |
| File scope, the two excluded names, symlink and special-file refusal | §3.1, §3.2, §5 | `src/identity/walk.ts` | `test/adversarial-walker.test.ts`, `test/walker-failures.test.ts`, `test/fix-walker-excluded-entries.test.ts` |
| Mutation resistance: the two-pass stability protocol | §6.2, §12 | `src/identity/walk.ts` | `test/adversarial-walker.test.ts`, `test/fix-walker-excluded-entries.test.ts`, `test/approval-and-matrix.test.ts` |
| Recorded-path form, rejected names, the ambiguity collision rule | §4.1–§4.3 | `src/identity/walk.ts` (`validateRecordedPath`, name decoding), `src/identity/unicode-15-1.ts` | `test/adversarial-walker.test.ts`, `test/identity-core.test.ts` |
| Limits; fail closed when one is crossed | §11 | `src/identity/walk.ts` (`WALK_LIMITS`) | `test/walker-failures.test.ts`, `test/approval-and-matrix.test.ts`, `test/adversarial-walker.test.ts` |
| `SKILL.md` frontmatter reads, bounded | §10 | `src/identity/frontmatter.ts` | `test/frontmatter.test.ts`, `test/fix-frontmatter-reads.test.ts`, `test/adversarial-serialization.test.ts` |
| File classification, informational only | §7.3 | `src/identity/classify.ts` | `test/identity-core.test.ts` |
| Writing a record: preconditions, atomic write, self-validation | §9.1, §9.3, §3.3 | `src/lock.ts`, `src/cli/main.ts` | `test/approval-store-and-staging.test.ts`, `test/adversarial-cli-exits.test.ts`, `test/identity-core.test.ts` |
| `declared_source`: grammars; outside the digest | §9.4 | `src/schema/validate.ts` (`DECLARED_SOURCE_FIELDS`), `src/cli/main.ts` | `test/declared-source-cli.test.ts`, `test/adversarial-output.test.ts` |
| Record validation, five steps, exit 3 on any failure | §9.5 | `src/schema/validate.ts` (the steps), `src/cli/main.ts` (the exit mapping) | `test/approval-and-matrix.test.ts`, `test/adversarial-serialization.test.ts` (steps); `test/cli.test.ts`, `test/adversarial-cli-exits.test.ts` (exit 3 at the CLI boundary) |
| Published JSON Schemas (structural subsets) | [`schema/`](../schema) | `schema/approval-record.schema.json`, `schema/diff-report.schema.json` | `test/approval-record-schema.test.ts`, `test/diff-report-schema.test.ts` |
| `check`: match, drift, and the counts a drift report carries | §12 | `src/check.ts` | `test/approval-and-matrix.test.ts`, `test/cli.test.ts` |
| Exit codes; no error path reports a match | §12 | `src/cli/main.ts` | `test/adversarial-cli-exits.test.ts`, `test/cli.test.ts` |
| `diff`: the report contract and its ordering | §12.1 | `src/diff/diff.ts` | `test/diff.test.ts`, `test/fix-reports-and-output.test.ts` |
| Terminal-output escaping for untrusted strings | §15 | `src/cli/sanitize.ts`, `src/cli/render.ts` | `test/adversarial-output.test.ts`, `test/fix-reports-and-output.test.ts` |
| Platform contract: Windows exits 1 before any work; identical digests on macOS and Linux | §13 | `src/cli/main.ts`, `src/identity/walk.ts` | `test/cli.test.ts`, `test/adversarial-walker.test.ts` |
| CLI surface: commands, flags, usage text | [README](../README.md), [SKILL.md](../skills/sigildex/SKILL.md) | `src/cli/index.ts`, `src/cli/main.ts` | `test/cli.test.ts`, `test/declared-source-cli.test.ts` |
| CI lifecycle example | [`docs/ci/README.md`](ci/README.md) | `docs/ci/approval-check.yml` | `test/ci-lifecycle.test.ts` |
| Version-drift example trees and their exit codes | [`examples/version-drift/README.md`](../examples/version-drift/README.md) (not in the npm package) | `examples/version-drift/` | `examples/version-drift/verify-example.mjs` (run by `npm run verify:example`), `test/transcript.test.ts` |
| Website build, and the transcript it prints | [README](../README.md) | `scripts/build-site.mjs` | `test/site.test.ts`, `test/transcript.test.ts` |

## Notes

**One document is normative.** [identity-spec.md](identity-spec.md) defines
artifact identity, the approval-record contents, and the `diff` report
contract; where it and the implementation disagree, the implementation is
defective. Everything else explains: the README, the
[adoption guide](safe-skill-adoption.md), the [threat model](threat-model.md),
the [CI guide](ci/README.md), `llms.txt`, and the Agent Skill. The JSON Schemas
are structural subsets published so tools can read a document's shape;
`sigildex check` is the authority on whether a record is valid. The
[postmortem](postmortem.md) and [case study](case-study.md) are history and
carry no requirements.

**Version bumps.** Any change that would make an existing record compare
differently is a new spec version, per the specification's §14; the
compatibility policy is in [CONTRIBUTING.md](../CONTRIBUTING.md).

**Supported surfaces.** The CLI and the published JSON Schemas. The JavaScript
module entry point is published without a compatibility promise — see
[CONTRIBUTING.md](../CONTRIBUTING.md).

**The adversarial suites are security regression tests.** `test/adversarial-*`
and `test/walker-failures.test.ts` are not extra happy-path coverage. Each case
is a way the tool could report a match, or a clean exit, when it should not:
symlink escape, mid-walk mutation, path traversal, a lock written into the tree
it measures, an internally inconsistent record, a terminal escape sequence
smuggled through frontmatter, a closed stdout pipe. A change that makes one of
them pass a different way deserves the same scrutiny as a change to the
specification.
