# Code map

Where each documented claim is implemented, and which tests hold it in place.
The table is for reading the release rather than using it: pick a claim, open
the file that implements it, then open the tests that would fail if it stopped
being true.

Paths are relative to the repository root. Specification references are section
numbers in [identity-spec.md](identity-spec.md).

| Claim or subsystem | Specification or document | Implementation | Primary tests |
|---|---|---|---|
| Canonical manifest line and root digest | §8.1–§8.4 | `src/identity/canonical.ts` | `test/identity-core.test.ts`, `test/adversarial-serialization.test.ts` |
| Deterministic record bytes: exact integer sizes, key order, no trailing surprises | §9.1, §9.2, §12.1 | `src/lock.ts` (`serializeJsonDocument`, `serializeApprovalRecord`) | `test/adversarial-serialization.test.ts`, `test/fix-reports-and-output.test.ts` |
| File scope, the two excluded names, symlink and special-file refusal | §3.1, §3.2, §5 | `src/identity/walk.ts` | `test/adversarial-walker.test.ts`, `test/walker-failures.test.ts`, `test/fix-walker-excluded-entries.test.ts` |
| Mutation resistance: the two-pass stability protocol | §6.2, §12 | `src/identity/walk.ts` | `test/adversarial-walker.test.ts`, `test/fix-walker-excluded-entries.test.ts`, `test/approval-and-matrix.test.ts` |
| Recorded-path form, rejected names, the ambiguity collision rule | §4.1–§4.3 | `src/identity/walk.ts` (`validateRecordedPath`, name decoding), `src/identity/unicode-15-1.ts` | `test/adversarial-walker.test.ts`, `test/identity-core.test.ts` |
| Limits, and failing closed when one is crossed | §11 | `src/identity/walk.ts` (`WALK_LIMITS`) | `test/walker-failures.test.ts`, `test/approval-and-matrix.test.ts`, `test/adversarial-walker.test.ts` |
| `SKILL.md` frontmatter reads, bounded and total | §10 | `src/identity/frontmatter.ts` | `test/frontmatter.test.ts`, `test/fix-frontmatter-reads.test.ts`, `test/adversarial-serialization.test.ts` |
| File classification, informational only | §7.3 | `src/identity/classify.ts` | `test/identity-core.test.ts` |
| Writing a record: preconditions, atomic write, self-validation | §9.1, §9.3, §3.3 | `src/lock.ts`, `src/cli/main.ts` | `test/approval-store-and-staging.test.ts`, `test/adversarial-cli-exits.test.ts`, `test/identity-core.test.ts` |
| `declared_source`: grammars, and that it stays outside the digest | §9.4 | `src/schema/validate.ts` (`DECLARED_SOURCE_FIELDS`), `src/cli/main.ts` | `test/declared-source-cli.test.ts`, `test/adversarial-output.test.ts` |
| Record validation, five steps, exit 3 on any failure | §9.5 | `src/schema/validate.ts` (the steps), `src/cli/main.ts` (the exit mapping) | `test/approval-and-matrix.test.ts`, `test/adversarial-serialization.test.ts` (steps); `test/cli.test.ts`, `test/adversarial-cli-exits.test.ts` (exit 3 at the CLI boundary) |
| Published JSON Schemas, and the gaps they cannot express | [`schema/`](../schema) | `schema/approval-record.schema.json`, `schema/diff-report.schema.json` | `test/approval-record-schema.test.ts`, `test/diff-report-schema.test.ts` |
| `check`: match, drift, and the counts a drift report carries | §12 | `src/check.ts` | `test/approval-and-matrix.test.ts`, `test/cli.test.ts` |
| Exit codes, including that no error path can report a match | §12 | `src/cli/main.ts` | `test/adversarial-cli-exits.test.ts`, `test/cli.test.ts` |
| `diff`: the report contract and its ordering | §12.1 | `src/diff/diff.ts` | `test/diff.test.ts`, `test/fix-reports-and-output.test.ts` |
| Terminal-output escaping for untrusted strings | §15 | `src/cli/sanitize.ts`, `src/cli/render.ts` | `test/adversarial-output.test.ts`, `test/fix-reports-and-output.test.ts` |
| Platform contract: Windows refused before any work; identical digests on macOS and Linux | §13 | `src/cli/main.ts`, `src/identity/walk.ts` | `test/cli.test.ts`, `test/adversarial-walker.test.ts` |
| CLI surface: commands, flags, usage text | [README](../README.md), [SKILL.md](../skills/sigildex/SKILL.md) | `src/cli/index.ts`, `src/cli/main.ts` | `test/cli.test.ts`, `test/declared-source-cli.test.ts` |
| CI lifecycle example, and what it does not watch | [`docs/ci/README.md`](ci/README.md) | `docs/ci/approval-check.yml` | `test/ci-lifecycle.test.ts` |
| Version-drift example trees and their exit codes | [`examples/version-drift/README.md`](https://github.com/sigildex/sigildex/blob/main/examples/version-drift/README.md) | `examples/version-drift/` | `examples/version-drift/verify-example.mjs` (run by `npm run verify:example`), `test/transcript.test.ts` |
| Website build, and the transcript it prints | [README](../README.md) | `scripts/build-site.mjs` | `test/site.test.ts`, `test/transcript.test.ts` |

## Four things the table does not say

**The supported integration surfaces for 0.1.x are the CLI and the published
JSON Schemas.** Automate against `sigildex lock`, `sigildex check`, and
`sigildex diff` — their flags, their output, and their exit codes — or against
the record and report documents themselves. The package also publishes a
JavaScript entry point (`main: dist/index.js`, with type declarations beside
it), and importing it works. It is published without a compatibility promise:
0.1.x guarantees the CLI and the schemas, and what the module surface exports,
or how, may change in any 0.1.x release. If you build on the module surface,
pin an exact version.

**One document is normative.** [identity-spec.md](identity-spec.md) defines
artifact identity, the approval-record contents, and the `diff` report contract;
where it and the implementation disagree, the specification wins and the
implementation is defective. Everything else explains: the README, the
[adoption guide](safe-skill-adoption.md), the [threat model](threat-model.md),
the [CI guide](ci/README.md), `llms.txt`, and the Agent Skill. The JSON Schemas
are a structural subset published so tools can read a document's shape;
`sigildex check` is the authority on whether a record is valid. The
[postmortem](postmortem.md) and the [case study](case-study.md) are history and
carry no requirements at all.

**What forces a version bump.** The specification answers this in its own §14:
any change to scope, exclusions, path rules, hashing, canonical serialization,
limits, or the fail-closed matrix increments the spec version, and the hash
algorithm is fixed at SHA-256 for spec version 1 — algorithm agility, if it were
ever needed, would arrive as a new spec version rather than a runtime option.
Records carry `spec_version` and `schema_version`, and a `check` that reads an
unsupported value for either exits 3 rather than comparing anything. So a change
that would make an existing record compare differently is a version bump by
definition. A patch is what is left: wording, packaging, messages, tests, and
fixes that bring the implementation back to what the specification already says.

**The adversarial suites are security regression tests.** `test/adversarial-*`
and `test/walker-failures.test.ts` are not extra coverage of the happy path.
Each case is a way the tool could report a match, or a clean exit, when it should
not have: symlink escape, mid-walk mutation, path traversal, a lock written into
the tree it measures, an internally inconsistent record, a terminal escape
sequence smuggled through frontmatter, a closed stdout pipe. They exist so those
failures cannot come back quietly, and a change that makes one of them pass a
different way deserves the same scrutiny as a change to the specification.
