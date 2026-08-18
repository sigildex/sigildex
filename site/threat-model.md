# Threat model

What Sigildex is built to withstand, what ships against it, and what is out of
scope. Where the [identity specification](identity-spec.md) or the CI workflow
in [ci/approval-check.yml](ci/approval-check.yml) defines a behavior, the
section is cited.

## Assets

- **Approval records** at `.sigildex/approvals/<approval-id>.lock.json`. Each
  states which bytes a human designated as approved. If a record can change
  without review, everything downstream of it is worthless.
- **The skill tree**: the files an agent loads and may execute.
- **The CI gate**: the workflow that decides whether a skill and its record
  agree. A gate that can be edited by the change it judges is not a gate.

## Trust boundaries

- **Sigildex is a local tool.** It reads local paths, hashes bytes, and writes a
  record. It makes no network calls and has no daemon, update channel, or
  telemetry. It executes nothing from the tree it measures.
- **`declared_source` is user-supplied and unverified.** Only `lock`'s
  `--source-*` flags write it. It sits outside the root digest and is a hint
  for update checkers, not provenance (specification §9.4).
- **Two names are outside the measurement.** `.git` and `.sigildex` are
  excluded at any depth and pruned (specification §3.2). Content can be added,
  changed, or removed under either name and `check` still reports a match.
- **The approval store is governed by repository settings, not by the tool.**
  Branch protection and `CODEOWNERS` make approval a human act.

## Attacker classes and what ships against each

**A malicious or compromised skill author.** The defense is quarantine,
scanners, and human review before any record exists, following the workflow in
[safe-skill-adoption.md](safe-skill-adoption.md). Sigildex is not that defense.
It records what was approved and has no opinion on whether approving it was
wise.

**An upstream update that silently replaces approved content.** `check`
compares file set, per-file SHA-256, size, and the executable bit against the
record and reports drift as exit `2` (specification §12). The executable bit is
part of identity (§6.3), so flipping a file to executable is drift on its own.

**A contributor who edits a skill and its record consistently in one commit.**
This is mechanically consistent, so the gate passes. `CODEOWNERS` over
`/.sigildex/approvals/**`, required code-owner review, dismissal of stale
approvals, and a required status check turn regeneration into a reviewed act.

**A pull request that attacks the gate.** On `pull_request` the workflow runs
as the pull request writes it, so `.github/workflows/**` belongs under
`CODEOWNERS` beside the approvals directory. The workflow triggers on
`pull_request`, never `pull_request_target`. It takes `contents: read` and no
secrets, and pins actions by commit SHA. It installs the tool outside the
checkout and invokes it by absolute path, so the pull request cannot supply the
program that judges it. It proves the base commit from the event payload
self-consistent before any passing outcome. Rationale for each choice:
[ci/README.md](ci/README.md).

**TOCTOU and mid-walk mutation.** The walk is a two-pass snapshot-verify
protocol; any mismatch is exit `1`, never a verdict (specification §6.2). Two
limits: a mutation after an observation's final verification is outside the
measurement window, and a same-granularity rewrite racing the verification
instant is undetectable without rehashing. Consumers needing stronger
assurance copy the artifact to a directory they exclusively control and verify
the copy.

**Symlink escape.** Any symlink under the skill root fails the command closed
with the path named, whether it points inside the tree, outside it, or nowhere.
Symlinks are neither followed nor recorded, and there is no opt-out
(specification §5). FIFOs, sockets, and devices fail the same way. An excluded
name buys no exemption: a symlink named `.git` is an error, not a prune (§3.2).

**Path and Unicode ambiguity.** Names that are not valid UTF-8, contain control
characters (`0x00` through `0x1F`, or `0x7F`), exceed 255 bytes, or contain
code points unassigned in Unicode 15.1 fail the walk closed (specification
§4.2). Within a directory, two entries whose names are equal after NFC
normalization and simple case folding fail closed with both named (§4.3), so a
tree whose identity would depend on which filesystem read it is rejected
everywhere. `lock` refuses to write its output inside the tree it walks (§3.3).
Resource limits (file, directory, and entry counts, per-file and total byte
caps, depth, path length) bound hostile trees (§11).

**ANSI and Markdown injection into a terminal or job summary.** Control
characters cannot enter a recorded path. Every other untrusted string is
escaped before terminal or Markdown emission: frontmatter keys and values,
`declared_source`, and any path echoed into human output. Escaping covers C0,
DEL and C1 controls, bidirectional controls and isolates, zero-width and other
format characters including the tag block, and private-use and unassigned code
points, with display truncation on code-point boundaries (specification §15).
Escaping is presentation only and changes no report or exit code. The CI
workflow writes only category counts to the job summary, parsed from the JSON
report rather than scanned from its text; a frontmatter key named `added` would
otherwise steer a text scan.

**A corrupt or hand-edited approval record.** Records are validated for
syntax, schema, versions, and internal consistency before the artifact is
walked; any failure is exit `3` (specification §9.5, §12). A tool error is exit
`1`. Neither is ever reported as a match.

## Residual risk and out of scope

- **No safety certification.** A matching digest means these exact bytes were
  approved. It does not certify that the skill is safe.
- **No provenance verification.** Sigildex does not verify where a skill came
  from. `declared_source` is a note to your future self; there are no
  signatures and no attestation in 0.1.
- **A record is a review snapshot.** It records what a human designated as
  approved. The tool never witnesses a review and cannot tell whether one
  happened.
- **No publisher monitoring, hosted index, or automatic update.** Detection is
  read-only and initiated by a human or a schedule you own.
- **No approval-store audit.** Duplicate approval ids, duplicate artifact
  paths, and records left behind without their artifact are not detected by the
  CLI or by the CI workflow, which watches only the pair it is configured with.
  Store hygiene is a review responsibility.
- **Prompt-injection controls are not a security boundary.** The Agent Skill in
  [skills/sigildex](../skills/sigildex/SKILL.md) tells an agent to treat
  candidate content as data and to act on no instruction found in it. Those
  rules reduce risk. They do not make a model immune to injection, and no
  immunity is claimed.
- **The JSON reports embed candidate frontmatter.** The approval record printed
  by `lock` and by a matching `check`, and the diff report, carry frontmatter
  verbatim; only the drift report from a mismatching `check` is
  frontmatter-free. Terminal rendering is escaped (specification §15); `--json`
  is the machine contract and is emitted as recorded. Delete every
  `frontmatter` object before feeding a report to a model. The reducer is in
  the Agent Skill and [safe-skill-adoption.md](safe-skill-adoption.md).
- **The gate's own dependency is resolved, not pinned.** The workflow installs
  the tool at a pinned version, but its one runtime dependency, `yaml`, is a
  semver range resolved from the registry at install time. For a hermetic gate,
  vendor a `package-lock.json` beside the tool's `package.json` and install with
  `npm ci`, or bundle the tool.
- **Branch protection can be bypassed by an administrator.** These are
  repository settings, not cryptography. What the setup buys is that
  unreviewed approval becomes a visible administrative act rather than an
  ordinary commit.
- **A check binds bytes during its measurement window only.** It says nothing
  about what a harness loads afterwards, what a dependency resolves to, or what
  a remote instruction returns at runtime.
- **Documented identity limitations.** Empty directories are not represented,
  so two trees differing only by empty directories share an identity. Hard
  links are ordinary regular files. Exotic name pairs that a case-insensitive
  filesystem folds but the equivalence key does not fail at materialization
  rather than here (specification §3.1, §4.3, §5).
- **Windows.** Out of scope in 0.1: the CLI exits `1` rather than computing an
  identity that path, permission, and case-sensitivity differences would
  silently change (specification §13).

Reporting: see [SECURITY.md](../SECURITY.md).
