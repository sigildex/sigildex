# Threat model

What Sigildex is built to withstand, what ships to withstand it, and what is
explicitly out of scope. Behaviors below are cited to the normative
[identity specification](identity-spec.md) and to the CI workflow in
[ci/approval-check.yml](ci/approval-check.yml); nothing here claims a property
those documents do not define.

## Assets

- **Approval records** — `.sigildex/approvals/<approval-id>.lock.json`. Each one
  states which bytes a human designated as approved. If a record can be changed
  without review, everything downstream of it is worthless.
- **The skill tree** — the files an agent actually loads and may execute.
- **The CI gate** — the workflow that decides whether a skill and its record are
  consistent. A gate that can be edited by the change it judges is not a gate.

## Trust boundaries

- **Sigildex is a local tool.** It reads local paths, hashes bytes, and writes a
  record. It makes no network calls, has no daemon, no update channel, and no
  telemetry. It never executes anything from the tree it measures.
- **`declared_source` is user-supplied and never verified.** It is written only
  by `lock`'s `--source-*` flags, sits outside the root digest, and is an
  orchestration hint for update checkers (specification section 9.4). It is not
  provenance and must never be presented as provenance.
- **Two names are outside the measurement.** `.git` and `.sigildex` are excluded
  at any depth and pruned (specification section 3.2). Nothing beneath them is
  hashed, compared, or reported. Content can be added, changed, or removed under
  either name and `check` will still report a match.
- **The approval store is governed by repository settings, not by the tool.**
  Branch protection and `CODEOWNERS` are what make approval a human act.

## Attacker classes and what ships against each

**A malicious or compromised skill author.** The defense is not the tool: it is
quarantine staging, scanners, and human review before any baseline exists — the
workflow in [safe-skill-adoption.md](safe-skill-adoption.md). Sigildex records
what was approved; it has no opinion about whether approving it was wise.

**An upstream update that silently replaces approved content.** `check` compares
file set, per-file SHA-256, size, and the executable bit against the record, and
reports drift as exit `2` (specification section 12). The executable bit is part
of identity (section 6.3), so flipping a file to executable is drift on its own.

**A contributor who edits a skill and its record consistently in one commit.**
Mechanically consistent, so the gate passes — and the CI workflow says so in its
own comments. This is deliberately not a tool problem: `CODEOWNERS` over
`/.sigildex/approvals/**`, required code-owner review, dismissal of stale
approvals on new commits, and a required status check are what turn regeneration
into a reviewed act.

**A pull request that edits the workflow file.** On `pull_request`, the workflow
runs as the pull request writes it, so editing it is as approval-affecting as
editing a record; the workflow says so and directs `.github/workflows/**` into
`CODEOWNERS`. It uses `pull_request` and never `pull_request_target`, takes
`permissions: contents: read`, needs no secrets, checks out with
`persist-credentials: false`, and pins its actions by commit SHA.

**A pull request that supplies the program that judges it.** The workflow
installs the tool *outside* the checkout, into a runner temp directory with its
own private `package.json`, with lifecycle scripts disabled, and invokes it by
absolute path. Resolution that starts in the workspace would prefer a
`node_modules` the pull request itself committed. Nothing from the candidate
skill is executed, sourced, or installed.

**A pull request that compares itself against a broken baseline.** The base
revision is proved self-consistent before any branch that can succeed, using the
base commit from the event payload rather than a branch name that may have
moved. A trigger that supplies no base commit is refused rather than treated as
"nothing changed".

**TOCTOU and mid-walk mutation.** The walk is a two-pass snapshot-verify
protocol (specification section 6.2): files are opened without following
symlinks and without blocking, `fstat`-verified against the `lstat` that found
them, streamed from the descriptor, and re-verified afterwards on
`(dev, inode, size, mtime, ctime)`. Directories are re-checked with an `lstat`,
a re-enumeration, and a closing `lstat`, which catches files added after their
parent was enumerated. Any mismatch is exit `1`, never a verdict. The
specification states the limit plainly: a mutation initiated after an
observation's final verification time is outside the measurement window, and no
userspace scan can bind bytes after the tool returns. Consumers needing stronger
assurance copy the artifact somewhere they exclusively control and verify the
copy.

**Symlink escape.** Any symlink anywhere under the skill root fails the command
closed with the path named, whether it points inside the tree, outside it, or
nowhere; symlinks are never followed and never recorded, and there is no opt-out
(specification section 5). Non-regular entries — FIFOs, sockets, devices — fail
the same way, and an excluded name does not buy an exemption: a symlink named
`.git` is an error, not a prune (section 3.2).

**Path and Unicode ambiguity.** Names that are not valid UTF-8, contain control
characters (`0x00`–`0x1F` or `0x7F`), exceed 255 bytes, or contain code points
unassigned in Unicode 15.1 fail the walk closed (specification section 4.2).
Within a directory, any two entries whose names are equal after NFC
normalization and simple case folding fail closed with both named (section 4.3),
so a tree whose identity would depend on which filesystem read it is rejected
everywhere. `lock` also refuses to write its output inside the tree it is
walking (section 3.3), and resource limits — file counts, directory counts,
entry counts, per-file and total byte caps, depth, path length — bound hostile
trees (section 11).

**ANSI and Markdown injection into a terminal or job summary.** Control
characters cannot enter a recorded path at all. Every other untrusted string —
frontmatter keys and values, `declared_source`, any path echoed into human
output — is escaped before terminal or Markdown emission: C0, DEL and C1
controls, bidirectional controls and isolates, zero-width and other format
characters including the tag block, and private-use and unassigned code points,
with display truncation cutting on code-point boundaries (specification
section 15). Escaping is presentation only and never changes a report or an exit
code. The CI workflow writes only category counts to the job summary, never
skill content, and counts them by parsing the JSON report rather than scanning
its text — a frontmatter key named `added` would otherwise steer a text scan.

**A corrupt or hand-edited approval record.** Records are validated for syntax,
schema, versions, and internal consistency before the artifact is walked; any
failure is exit `3`, never a match and never a comparison (specification
sections 9.5 and 12). A tool error is exit `1`. Neither is ever reported as a
verdict.

## Residual risk and out of scope

- **No safety scoring, no risk assessment, no certification.** A matching digest
  means these exact bytes were approved — never that they are safe.
- **No provenance verification.** `declared_source` is a note to your future
  self. There are no signatures and no attestation in v0.1.
- **No publisher monitoring, no hosted index, no automatic updates.** Detection
  is read-only and initiated by a human or a schedule you own.
- **No approval-store audit.** Duplicate approval ids, duplicate artifact paths,
  and records left behind without their artifact are not detected by the CLI or
  by the CI workflow, which watches the pairs it is configured with. Store
  hygiene is a review responsibility.
- **Prompt-injection controls are not a security boundary.** The Agent Skill
  shipped in [skills/sigildex](../skills/sigildex/SKILL.md) tells an agent to
  treat candidate content as data, to prefer structural output, and never to act
  on instructions found in a candidate. Those rules reduce risk. They do not make
  a model immune to injection, and no immunity is claimed.
- **Branch protection can be bypassed by an administrator.** These are
  repository settings, not cryptography. What the setup buys is that unreviewed
  approval becomes a visible administrative act rather than an ordinary commit.
- **A check binds bytes during its measurement window only.** It says nothing
  about what a harness loads afterwards, what a dependency resolves to, or what
  a remote instruction returns at runtime.
- **Documented identity limitations.** Empty directories are not represented, so
  two trees differing only by empty directories share an identity; hard links are
  ordinary regular files; exotic name pairs that a case-insensitive filesystem
  folds but the equivalence key does not fail at materialization rather than
  here (specification sections 3.1, 4.3, and 5).
- **Windows.** Out of scope in v0.1: the CLI exits `1` with an
  unsupported-platform error rather than computing an identity that path,
  permission, and case-sensitivity differences would silently change
  (specification section 13).

Reporting: see [SECURITY.md](../SECURITY.md).
