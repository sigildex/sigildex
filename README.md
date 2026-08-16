# Sigildex

> Sigildex does not replace discovery, security scanning, or human review. It connects them into a durable workflow by recording exactly what was approved and detecting when that artifact changes.

Sigildex is a local, deterministic command-line tool for AI agent skills. `sigildex lock` records an approval baseline for a skill directory you have reviewed, `sigildex check` detects drift in the bytes it measured, and `sigildex diff` explains what changed between two versions. It operates on local paths only: no network calls, no telemetry, and no safety scoring.

## Status

v0.1 in preparation — not yet published. It will be published to npm as `sigildex@0.1.0`; until then, build it from this repository. It requires Node.js 20 or later. The identity specification ([docs/identity-spec.md](docs/identity-spec.md)) is the normative contract; implementation follows it.

## The workflow

Sigildex implements one stage of a longer workflow and documents the rest.

1. **Discover** a candidate skill with ecosystem tools — weighing publisher
   identity, provenance, maintenance, and licensing, not just popularity.
2. **Stage** it in a quarantine directory outside any active skills directory.
   Record where it came from. Never run bundled scripts. Treat `SKILL.md` as
   untrusted content.
3. **Scan and review** with complementary scanners — evidence, not
   certification — plus the manual review checklist.
4. **Lock** — `sigildex lock` records the exact reviewed artifact as an approval
   baseline.
5. **Install and verify** — `sigildex check` the copy that will actually run.
   A mismatch fails closed.
6. **Detect upstream changes** with read-only mechanisms, on demand or on a
   schedule.
7. **Stage the candidate update** in quarantine. Detection and staging never
   modify the active installation.
8. **Diff and re-approve** — `sigildex diff` explains what changed, a human
   approves a new baseline, and CI enforces it.

The full guide, including adopting already-installed skills, removal and
emergency revocation, and the explicit limits of what an approval record cannot
freeze, is in [docs/safe-skill-adoption.md](docs/safe-skill-adoption.md).

## Five minutes

Requires Node.js 20 or later, on macOS or Linux. Windows is out of scope in
v0.1; run under WSL or on a Linux or macOS host.

This path uses the repository's own example trees, so it runs from a clone:

```sh
git clone https://github.com/sigildex/sigildex
cd sigildex
npm ci && npm run build
cd examples/version-drift
```

Because v0.1 is not on npm yet, the commands below call `npx sigildex`, which
inside the clone runs the build you just made. Once the package is published,
`npm install -g sigildex` gives you a plain `sigildex` command and every command
below is the same without the `npx` prefix.

**Record what you reviewed.** `skill-v1` stands in for a candidate you have
staged in quarantine and read.

```sh
mkdir -p .sigildex/approvals
npx sigildex lock skill-v1 \
  --approval-id log-summarizer \
  --out .sigildex/approvals/log-summarizer.lock.json \
  --source-kind git \
  --source-repository https://github.com/example-org/example-skills \
  --source-path skills/log-summarizer \
  --source-commit 4f2a9c1 \
  --source-tracking track-default-branch
```

The `--out` filename is always `<approval-id>.lock.json` — the tool refuses any
other name, so a record and its id can never disagree. The `--source-*` flags
are optional; they record where you believe the artifact came from, so a later
update check knows where to look. They are never verified, and they sit outside
the identity digest.

```
Locked skill-v1
  approval id:            log-summarizer
  root digest:            sha256:d445576462862500bd9537c93fc2390802d97bf3df13879a9b83cc21e04890ad
  files:                  2
  frontmatter:            ok
    name:                 log-summarizer
    description:          Summarize a plain-text application log into a short incident report — error counts, the first and last timestamp seen, and the most frequent messages. Use when …
  written to:             .sigildex/approvals/log-summarizer.lock.json
This records byte identity only. It does not attest safety, provenance, or future content.
```

Exit `0`.

**Verify what is installed.** After moving the artifact to where your agent
loads it, check before anything runs:

```sh
npx sigildex check skill-v1 --against .sigildex/approvals/log-summarizer.lock.json
```

Exit `0` — `Match: the artifact matches approval record log-summarizer.`, with
the root digest and the file count under it.

**Notice when it changes.** `skill-v2` is what a later upstream release looks
like:

```sh
npx sigildex check skill-v2 --against .sigildex/approvals/log-summarizer.lock.json
```

```
Drift: the artifact no longer matches the approval record (1 added, 0 removed, 1 modified, 0 mode-changed).
  approved root digest:   sha256:d445576462862500bd9537c93fc2390802d97bf3df13879a9b83cc21e04890ad
  actual root digest:     sha256:0b0bec0d4e4435beed62b983c530f4f8249e7b1af01d31fbb8be1989d94cf1c6

  + scripts/summarize.sh (script)
  ~ SKILL.md (instructions)

Review the changes and re-lock only after approving them.
```

Exit `2`.

**Understand the change.**

```sh
npx sigildex diff skill-v1 skill-v2
```

Exit `2`. The update adds an executable script where the approved version had
none, and rewrites the instructions to call it; the report also notes the
frontmatter `version` moving from `1.0.0` to `1.1.0`, which is informational and
never part of identity. Add `--json` for the same facts in a stable structure.

**Re-approve deliberately** — only after a human has read the change. Locking to
the same approval id and output path replaces the baseline in place:

```sh
npx sigildex lock skill-v2 \
  --approval-id log-summarizer \
  --out .sigildex/approvals/log-summarizer.lock.json \
  --source-kind git \
  --source-repository https://github.com/example-org/example-skills \
  --source-path skills/log-summarizer \
  --source-commit 9d3e07b \
  --source-tracking track-default-branch

npx sigildex check skill-v2 --against .sigildex/approvals/log-summarizer.lock.json
```

A re-lock writes a fresh record, so repeat the `--source-*` flags with the newly
approved commit; omitting them leaves the new record with no declared source.

Exit `0`.

**Exit codes are the contract:** `0` success, match, or identical · `2` drift
detected, or the two directories differ · `1` tool, input, filesystem, or walk
error · `3` unsupported or invalid approval record. A tool error and an invalid
record are never reported as a match.

[examples/version-drift](https://github.com/sigildex/sigildex/tree/main/examples/version-drift) walks the rest of the
lifecycle — rollback, a change to the record alone, and removal — with every
exit code asserted by a runnable script.

## Trust boundary

> Sigildex records artifact identity and explains changes. It does not certify that a skill, script, dependency, remote service, installer, or runtime behavior is safe. Pair it with security scanning and human review appropriate to your environment.

**`check` proves** one thing: the current artifact byte-matches the supplied
approval record — same files, same paths, same contents, same executable bits.
The CLI never claims to know whether human review occurred. An approval record
is a **review snapshot**: it records what a human designated as approved. It is
not a certificate, and it does not attest safety, provenance, or future content.

A record can also carry a `declared_source` — where you believe the artifact came from, set with `lock`'s `--source-*` flags. It is user-supplied, never verified, and outside the identity digest: it is a note to your future self, not provenance.

**What a record measures.** Two names are excluded from the walk at any depth: `.git` and `.sigildex`. Nothing beneath them is hashed, so nothing beneath them is measured, compared, or reported — content can be added, changed, or removed under either name and a record will still report `Match`. The limiting case is worth stating outright: a valid record with an empty manifest matches *any* tree whose in-scope content is empty, so `Match` on its own is not evidence that a particular skill is present. Read the file count `check` prints alongside the verdict, and treat a count that surprises you as a finding.

**Trust comes from where the records live and who can change them** — an
approval record on a protected branch, under code owners, with a required status
check — not from Sigildex. The tool is the mechanism those controls act on. It
is not a substitute for them, and repository settings are settings, not
cryptography: an administrator can bypass them. What the setup buys is that
unreviewed approval becomes a visible administrative act rather than an ordinary
commit.

A successful check binds the artifact's bytes during the measurement window
only. It says nothing about what a harness loads afterwards, what a dependency
resolves to, or what a remote instruction returns at runtime.

The fuller account — assets, attacker classes, and what is explicitly out of
scope — is in [docs/threat-model.md](docs/threat-model.md).

## What the tooling does not check

`sigildex lock` refuses to write a record whose filename does not match its `approval_id`, and `sigildex check` compares one artifact against one record. Nothing in v0.1 audits a directory of approvals: duplicate approval IDs, duplicate artifact paths, and locks left behind without their artifact are not detected by the tool or by the CI example, which watches a single configured pair. Keeping an approval store clean stays a review responsibility — branch protection and code owners over the approvals directory.

## Who this is for

**Primary user: teams managing skills in Git repositories** through pull
requests and protected approval records. Approval records live at
`.sigildex/approvals/<approval-id>.lock.json`, move through review with the
skills they describe, and are checked against their artifacts by a CI workflow —
see [docs/ci/](docs/ci). That workflow watches the skill/record pairs you
configure it with; auditing the approvals directory itself stays a review
responsibility, as above. This is the flow the release is built around.

**Secondary: individual developers**, using the Agent Skill in
[skills/sigildex](skills/sigildex/SKILL.md) and read-only package-manager update
checks with explicit paths.

Sigildex does not claim to solve cross-machine personal skill inventory in this
release.

## How this relates to other tools

Sigildex is complementary to the rest of the ecosystem, and deliberately does
not compete with any of it. Discovery tools such as the GitHub CLI's `gh skill`
(preview) and the Vercel Skills CLI find skills and install them.
Scanners such as NVIDIA SkillSpector and the Cisco AI Defense Skill Scanner
analyze a candidate directory and produce evidence about it, and Snyk Agent Scan
audits the skills already installed on a machine. Package
managers and installers put skills on disk and can tell you when upstream has
moved. Several small projects hash skill directories. Sigildex is not the first
tool to compute a digest over a skill, and it does not replace any of the above:
use them, and use them together.

What it adds is the connective tissue between them — a durable, deterministic,
reviewable record of *what a human actually approved*, stored beside the code,
enforced in review, and checked again at install time. The gap it closes is the
one between the stages: what you approved is no longer what is installed, and
nobody noticed.

## Documentation

- [docs/identity-spec.md](docs/identity-spec.md) — the normative identity and approval-record specification.
- [docs/safe-skill-adoption.md](docs/safe-skill-adoption.md) — an end-to-end workflow for adopting agent skills safely.
- [docs/threat-model.md](docs/threat-model.md) — assets, trust boundaries, attacker classes, and residual risk.
- [docs/ci](docs/ci) — a copy-paste CI workflow that keeps one skill and its approval record consistent, with an explicit account of what it cannot prove.
- [skills/sigildex/SKILL.md](skills/sigildex/SKILL.md) — the Sigildex Agent Skill: drop it into your agent's active skills directory, for example `.claude/skills/`, to run this workflow with an agent.
- [llms.txt](llms.txt) — a compact, machine-readable summary of the tool, its limitations, and where to route.
- [schema/](schema) — JSON Schema for the approval record and the diff report. These are *structural subsets* of the specification, published so tools can read the shape of a document: their string limits count code points where the specification counts UTF-8 bytes, and they cannot express the Unicode-assignment rule on paths, manifest ordering, or the requirement that `root_digest` agree with its own manifest. Records exist that the schema accepts and `sigildex check` rejects. `sigildex check` is the authority on whether a record is valid; each schema says so in its own `description` and `$comment`.
