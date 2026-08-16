# Safe skill adoption

A practical, end-to-end workflow for evaluating an AI agent skill, approving it
deliberately, and noticing when what you approved changes.

> Sigildex does not replace discovery, security scanning, or human review. It
> connects them into a durable workflow by recording exactly what was approved
> and detecting when that artifact changes.

## Overview and trust model

An agent skill is instructions — and often scripts — that you hand to a system
with your tools, your credentials, and your filesystem. Adopting one is a trust
decision. This guide is the workflow around that decision.

The workflow has eight stages. Sigildex implements one of them and connects the
rest:

1. **Discover** a candidate skill.
2. **Stage** it in quarantine, outside any directory an agent loads.
3. **Scan and review** it — automated scanners for evidence, a human for
   judgement.
4. **Record an approval baseline** — `sigildex lock`.
5. **Install and verify** — `sigildex check` the copy that will actually run.
6. **Detect upstream changes** with read-only mechanisms.
7. **Stage the update** in quarantine; the active installation is untouched.
8. **Compare and re-approve** — `sigildex diff`, then a human decision, then a
   new baseline.

**What Sigildex is responsible for.** Computing the byte identity of a local
skill directory, recording it as an approval baseline, and telling you — exactly
and deterministically — when the artifact stops matching that baseline. Nothing
else. It makes no network calls, collects no telemetry, and produces no score.

**What remains yours.** Deciding whether a skill should be adopted at all,
reading what it actually says, choosing and running scanners, granting the
approval, and enforcing that approvals are reviewed. An approval record is a
**review snapshot**: it records what you designated as approved. It is not a
certificate, and it carries no claim that any review happened. Sigildex never
witnesses your approval — it records the bytes you point it at.

Trust in this workflow comes from where you put the approval records and who can
change them: a protected branch, a required code-owner review, and a required
status check. Sigildex is the mechanism those controls act on, not a substitute
for them.

**Platforms.** macOS and Linux. Windows is out of scope in v0.1; on Windows the
CLI exits 1 with an unsupported-platform error rather than computing an identity
that platform differences would silently change. Run it under WSL or on a Linux
or macOS host.

**Exit codes**, used throughout this guide and by every example:

| Code | Meaning |
|---|---|
| `0` | success, match, or identical |
| `2` | drift detected, or the two directories differ |
| `1` | tool, input, filesystem, or walk error |
| `3` | unsupported or invalid approval record |

A tool error and an invalid record are never reported as a match.

For what this workflow defends against and what it explicitly does not, see
[threat-model.md](threat-model.md).

## Discovering candidate skills

Candidates come from several places, and where a skill comes from is part of
what you are evaluating:

- **Ecosystem CLIs and catalogs** — the GitHub CLI's `gh skill` (public
  preview), the Vercel Skills CLI and skills.sh, and similar catalogs.
- **Publisher repositories** — a vendor or framework author shipping skills
  alongside their product.
- **Internal repositories** — skills your own organization wrote.

Popularity is the weakest of the available signals. Before you spend review
effort, capture:

- **Publisher identity** — a person or organization you can name, and whether
  the account is one you have reason to trust.
- **Provenance** — the repository, the subdirectory, and the exact commit or
  tag you are looking at. You will want these again in step 6.
- **Maintenance** — recent commits, responsiveness on issues, whether it looks
  abandoned.
- **Licensing** — whether you may use it at all.
- **Fit** — whether the skill's stated purpose is something you actually need.

Write these down. The repository, subdirectory, and reference are the same three
values that later enable update checks.

## Quarantine staging

Fetch the candidate into a directory **no agent or runtime is configured to
load**. Review happens before anything can execute.

```sh
mkdir -p ~/skill-review
git clone --depth 1 https://github.com/example-org/example-skills ~/skill-review/_src
cp -R ~/skill-review/_src/skills/log-summarizer ~/skill-review/log-summarizer
```

Rules for the staging directory:

- It is outside every active skills directory and outside every path your agent
  harness scans.
- **Never run bundled scripts**, install commands, or setup steps from a staged
  candidate. Not to "see what it does" — that is the thing you are trying to
  avoid.
- Treat `SKILL.md` as untrusted content. It is written to be read by a model,
  and text written to be read by a model can be written to influence one. Read
  it yourself, in an ordinary editor or pager.
- Record where it came from — repository, subdirectory, commit — next to the
  staged copy.

Sigildex never modifies, executes, or fetches anything. It reads bytes and
hashes them. Staging is what keeps the candidate from running before you decide.

## Scanning and manual review

Automated scanners produce **evidence**. They do not produce certification, and
a clean report is not an approval. Every scanner listed here says so in its own
documentation: best-effort detection, and no findings does not mean no risk.

Run more than one — they disagree, and the disagreements are informative.

### Scanner examples

*Commands below were taken from each project's published documentation as of
2026-08-15. All three projects are young and moving; verify each command against
the tool's current documentation before relying on exact syntax.*

**NVIDIA SkillSpector** — <https://github.com/NVIDIA/SkillSpector>

<!-- external-command smoke: pending -->

```sh
uv tool install git+https://github.com/NVIDIA/skillspector.git
skillspector scan ~/skill-review/log-summarizer --no-llm --format json --output ~/skill-review/skillspector.json
```

`--no-llm` restricts it to static pattern and AST analysis; omit it to enable
semantic evaluation through a configured model provider.

**Cisco AI Defense Skill Scanner** — <https://github.com/cisco-ai-defense/skill-scanner>

<!-- external-command smoke: pending -->

```sh
pip install cisco-ai-skill-scanner
skill-scanner scan ~/skill-review/log-summarizer --format json
```

Additional analyzers are opt-in flags; consult the project's documentation for
the current set and for the API keys some of them require.

**Snyk Agent Scan** — <https://github.com/snyk/agent-scan>

<!-- external-command smoke: pending -->

```sh
uvx snyk-agent-scan@latest ~/skill-review/log-summarizer --json
```

Point it at the staged directory, not at your active skills directory, when the
goal is to evaluate a candidate.

If a scanner's syntax has changed since this guide was written, the shape of the
step has not: *point a scanner at the quarantined directory, capture
machine-readable output, and read it.*

### The manual review checklist

Scanners find patterns. A human decides whether the skill should exist in your
environment at all. Read the staged files — `SKILL.md` first, then every script,
then every reference document — and answer:

- **What does it instruct the agent to do**, in its own words? Restate the
  skill's behavior in one or two sentences without using its vocabulary. If you
  cannot, you have not finished reading it.
- **Which tools and permissions does it request?** Shell access, file writes,
  network calls, credential reads.
- **What is in the bundled scripts?** Read every executable file. An executable
  bit on a file you did not expect to be executable is worth pausing on.
- **What dependencies and install commands does it carry?** Are versions
  pinned? What runs at install time?
- **What credential, network, and filesystem access does it need** — and where
  does anything it reads end up?
- **Does it fetch remote instructions or resources at runtime?** Anything
  retrieved after approval is outside the baseline entirely.
- **Is the requested capability proportionate to the stated purpose?** A log
  summarizer that wants your SSH keys fails this test regardless of what any
  scanner reported.

Record your conclusion, the scanner outputs, and the commit you reviewed. That
record — not the approval baseline — is the evidence that a review happened.

## Recording an approval

Once a human has decided, capture the exact reviewed state. `--artifact-path`
names where the artifact will live: your agent's active skills directory, for
example `.claude/skills/`. The examples below use
`.claude/skills/log-summarizer`; substitute the directory your own agent loads.

```sh
mkdir -p .sigildex/approvals
sigildex lock ~/skill-review/log-summarizer \
  --approval-id log-summarizer \
  --artifact-path .claude/skills/log-summarizer \
  --out .sigildex/approvals/log-summarizer.lock.json \
  --source-kind git \
  --source-repository https://github.com/example-org/example-skills \
  --source-path skills/log-summarizer \
  --source-commit 4f2a9c1 \
  --source-tracking pinned-commit
```

Exit `0`. The record lists every in-scope file with its SHA-256, size,
executable bit, and an informational class, plus a single root digest over that
manifest.

Notes on the flags:

- `--out` is required, and its parent directory must already exist — the tool
  writes the record, it does not create directories. The record may **not** be
  written inside the directory being measured: an approval record can never
  appear in its own manifest, and attempting it exits `1` and writes nothing.
  Its filename must be exactly `<approval-id>.lock.json`; a mismatch exits `1`
  before anything is walked or written.
- The `--source-*` flags are optional and record the `declared_source` hint that
  update checks read later. Any subset is valid, and passing none omits the
  field entirely. They are recorded **unverified** — they say where you believe
  the artifact came from, and they sit outside the root digest, so editing them
  is never drift. See "Configuring an update source" below.
- `--approval-id` must match `[a-z0-9][a-z0-9-]{0,63}`. It defaults to a value
  derived from the directory name; pass it explicitly when you want a stable id
  that does not depend on where the directory happens to sit.
- `--artifact-path` records the **project-relative** location the artifact will
  occupy. It defaults to the skill path relative to the current directory, so
  when you lock a quarantined copy that lives outside the project you must pass
  it explicitly, as above — without it that lock exits `1` and tells you so.
  Records never contain absolute local paths.
- `--json` prints the record itself instead of the human summary, for tooling.

Store records at `.sigildex/approvals/<approval-id>.lock.json`. Four rules hold
for an approval store, but they are not all enforced the same way:

- The filename must match the `approval_id`. **The tool enforces this** — `lock`
  refuses to write a record under any other name, wherever you point `--out`.
- Each record maps to exactly one project-relative artifact path. The record
  grammar enforces this.
- Approval ids and artifact paths are unique across the project, and no record
  is left behind without its artifact. **Nothing in v0.1 checks this.** The CI
  workflow verifies the one skill/record pair it is configured with; it does not
  audit `.sigildex/approvals/` for duplicate ids, duplicate artifact paths, or
  orphaned records, and neither does the CLI. Keeping the store clean is a
  review responsibility — put the approvals directory under `CODEOWNERS` and
  read what lands in it.

**What the record asserts:** these exact bytes, at these exact paths, with these
exact executable bits, were the artifact at lock time. **What it does not
assert:** that the skill is safe, where it truly came from, that anyone reviewed
it, or what the bytes will be later.

## Install and verify

Move the approved artifact out of quarantine into the place your agent loads it,
then verify before anything runs:

```sh
cp -R ~/skill-review/log-summarizer .claude/skills/log-summarizer
sigildex check .claude/skills/log-summarizer --against .sigildex/approvals/log-summarizer.lock.json
```

Exit `0` and a match report. Exit `2` means the installed copy is not the
reviewed copy — stop and find out why before letting an agent load it. Exit `1`
means the check could not complete (missing directory, unreadable file, a
symlink where a regular file was expected); a run that cannot finish its walk
never emits a verdict. Exit `3` means the record itself is invalid or was
hand-edited into inconsistency.

A successful check binds the artifact's bytes **during the measurement window
only**. It says nothing about what the harness loads five minutes later. If your
threat model needs execution-time integrity, re-run `check` immediately before
activation, or run from an immutable copy of the verified artifact.

## Enforcing approvals in CI

For skills that live in a Git repository, make the check a merge gate. A
copy-paste GitHub Actions workflow and its full rationale are in
[ci/README.md](ci/README.md) and [ci/approval-check.yml](ci/approval-check.yml).

In short, for the **one** skill/record pair it is configured with, the gate
proves three things: the base revision's skill matches its own approval record
(so you never compare against an already-broken reference), the pull request's
skill matches the pull request's record, and the two move together — changing
one without the other fails. It looks at no other entry in the approvals
directory, and nothing Sigildex ships audits that directory for duplicate
approval ids, duplicate artifact paths, or orphaned records.

It cannot prove the change *should* be approved. A pull request that rewrites a
skill and regenerates its record in the same commit is mechanically consistent.
Making regeneration require a human is a repository-settings job: put
`/.sigildex/approvals/**` under `CODEOWNERS`, require code-owner review, dismiss
stale approvals on new commits, and require the check. Those are settings, not
cryptography — anyone who can change branch protection can bypass them. What the
setup buys you is that unreviewed approval becomes a visible administrative act
rather than an ordinary commit.

## Checking approved skills for updates

Sigildex **orchestrates** update detection. It operates no crawler, no daemon,
and no monitoring service. There is no `sigildex watch`, no hosted inventory, no
automatic installation, and no automatic approval. Detection is something you or
your CI runs, read-only, on purpose.

Two levels, both legitimate:

### On-demand checks

Right for personal installs. Ask your agent — or run it yourself — whenever you
want to know.

With the GitHub CLI (`gh skill` is **public preview** and subject to change
without notice; taken from the GitHub CLI manual, <https://cli.github.com/manual/>,
as of 2026-08-15 — verify against the tool's current documentation):

<!-- external-command smoke: pending -->

```sh
gh skill update --dry-run
```

`--dry-run` reports available updates without modifying any files. It compares
the local tree SHA recorded in a skill's frontmatter against the remote
repository. Skills installed with `--pin` are skipped with a notice; `--unpin`
clears the pin and includes them. Other installers offer equivalent read-only
modes — use those, and read their documentation to confirm the mode does not
write.

### Scheduled checks

Right for repositories. A workflow in **your own** account, on a schedule,
running a read-only source check and opening an issue or a draft pull request
when upstream has moved.

Such a workflow must never merge, never replace the trusted skill, never
generate an approved baseline, and never treat "upstream released something" as
approval. Its only job is to tell a human that there is something to look at.

### Configuring an update source

An approval record can carry an optional `declared_source` object — `kind`,
`repository`, `path`, `approved_commit`, `tracking_policy`, and the required
literal `verification: "user_supplied"` — that tells an update checker where to
look.

It is **user-supplied and never verified**. It sits outside the identity digest,
so adding or changing it does not affect whether an artifact matches. It is an
orchestration hint. It is not provenance, and must not be described as such.

You never hand-edit the JSON to set it. `lock` writes it from the `--source-*`
flags, so an update source is configured by re-recording the approval:

```sh
mkdir -p .sigildex/approvals
sigildex lock .claude/skills/log-summarizer \
  --approval-id log-summarizer \
  --out .sigildex/approvals/log-summarizer.lock.json \
  --source-kind github \
  --source-repository https://github.com/example-org/example-skills \
  --source-path skills/log-summarizer \
  --source-commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 \
  --source-tracking track-default-branch
```

The grammars are checked before anything is walked or written, so a typo exits
`1` naming the flag and the rule rather than producing a record that later fails
validation: `--source-kind` is 1 to 32 characters from `[a-z0-9-]`,
`--source-commit` is 7 to 64 lowercase hexadecimal characters, `--source-path`
is a relative POSIX path with no `.` or `..` component (or the literal `.`),
`--source-repository` is at most 512 UTF-8 bytes, and `--source-tracking` at
most 128 UTF-8 bytes. All five are optional and any subset is valid.

Re-locking rewrites the record from the artifact's **current** bytes, so do it
only when the artifact is already the approved one. Confirm before and after:

```sh
sigildex check .claude/skills/log-summarizer --against .sigildex/approvals/log-summarizer.lock.json
```

Exit `0` both times. A skill with no `declared_source` is simply reported as
having no update source configured; the fix is the one command above.

### Prove the active installation did not change

Detection and staging must not touch what is running. Make that an explicit
step, not an assumption. Before you start:

```sh
sigildex check .claude/skills/log-summarizer --against .sigildex/approvals/log-summarizer.lock.json
```

Run detection, acquire the candidate into a temporary directory, then run the
same command again. Both must exit `0`. If the second one exits `2`, something
in your detection path wrote to the active installation — stop and fix that
before going further. Never run a mutating update command against the approved
active directory.

### Staging and comparing the update

Acquire the candidate into quarantine — never over the top of the active
installation — and compare:

```sh
sigildex diff .claude/skills/log-summarizer ~/skill-review/log-summarizer-next
```

Exit `0` if both trees walked cleanly and are identical; exit `2` if they
differ; exit `1` if either walk failed. Every differing path lands in exactly one
category — `added`, `removed`, or `changed` — and `changed` entries carry two
independent booleans, `content_changed` and `mode_changed`. Frontmatter
differences are shown for information and are never part of identity.

`sigildex diff --json` gives the same facts in a stable structure if you want to
attach them to a review. Then return to the scan-and-review step above: the
update is a new candidate, reviewed on its own merits, and re-approved only by a
human. Re-approval replaces the record in place:

```sh
sigildex lock ~/skill-review/log-summarizer-next \
  --approval-id log-summarizer \
  --artifact-path .claude/skills/log-summarizer \
  --out .sigildex/approvals/log-summarizer.lock.json \
  --source-kind github \
  --source-repository https://github.com/example-org/example-skills \
  --source-path skills/log-summarizer \
  --source-commit <the-commit-you-reviewed> \
  --source-tracking track-default-branch
```

A re-lock writes a whole new record, so repeat the `--source-*` flags — with the
newly approved commit — or the new record will have no `declared_source` and the
skill will drop back to "no update source configured". Install, then verify
again.

### Two installation strategies

- **Trackable installation** — the installer knows where the skill came from and
  can detect upstream changes. You get notification; Sigildex prevents the change
  from becoming trusted automatically.
- **Installer-pinned installation** — stronger pinning, but update checks may
  skip pinned skills entirely (`gh skill update` does, with a notice). Pair
  pinning with a release or repository watcher so that "pinned" does not quietly
  become "unwatched".

Both are reasonable. Choose deliberately and write down which one a given skill
uses.

## Adopting an already-installed skill

Skills that predate this workflow are **not** presumed approved. Bring them in
without reinstalling:

1. **Inventory** what is installed — list the directories your harness loads.
2. **Copy to review staging.** Do not review in place; you want the active copy
   untouched while you work.
   ```sh
   cp -R .claude/skills/log-summarizer ~/skill-review/log-summarizer
   ```
3. **Scan and review** the staged copy exactly as you would a new candidate.
   Being already installed is not evidence of anything except that someone
   installed it.
4. **Record the baseline** from the staged copy, with `--artifact-path` pointing
   at the installed location:
   ```sh
   mkdir -p .sigildex/approvals
   sigildex lock ~/skill-review/log-summarizer \
     --approval-id log-summarizer \
     --artifact-path .claude/skills/log-summarizer \
     --out .sigildex/approvals/log-summarizer.lock.json
   ```
5. **Verify the installed copy** against the new record:
   ```sh
   sigildex check .claude/skills/log-summarizer --against .sigildex/approvals/log-summarizer.lock.json
   ```
   Exit `0`. Exit `2` here is informative: the installed copy differs from what
   you just reviewed, which means something modified it after installation. Find
   out what before you approve anything.

If review turns up something you are not willing to accept, this is a removal,
not an adoption — see below.

## Removal, emergency revocation, and rollback

**Ordinary removal.** Delete the artifact and its approval record in the same
change. Half of that is a broken state, and each half fails on its own: a record
whose artifact is gone exits `1` with no verdict, and an artifact with no record
is what CI catches as unapproved — for the skills it is configured to watch.
Nothing scans the approvals directory for records left behind, so removal is
something you do completely, not something you rely on being caught.

```sh
rm -rf .claude/skills/log-summarizer
rm .sigildex/approvals/log-summarizer.lock.json
```

**Emergency revocation** — a publisher is compromised, or a skill turns out to
do something it should not:

1. Remove the artifact from every active skills directory first. The approval
   record is bookkeeping; the artifact is what runs.
2. Remove the approval record in the same change, so nothing re-derives trust
   from it.
3. Restart the agent harness. Many harnesses read skills at startup or cache
   them; deleting files on disk does not necessarily unload what is already
   resident. Assume a restart is required unless your harness documents
   otherwise.
4. Check whether the same skill is installed anywhere else — other machines,
   other repositories, CI images.
5. Treat any credential the skill could reach as exposed, and rotate it. The
   approval baseline tells you exactly which files were present and what they
   contained; it tells you nothing about what already ran.

**Rollback to a previously approved artifact.** Because both the artifact and
its record live in Git, a previous approved state is a previous commit. Restore
both together, then verify:

```sh
git checkout <known-good-commit> -- .claude/skills/log-summarizer .sigildex/approvals/log-summarizer.lock.json
sigildex check .claude/skills/log-summarizer --against .sigildex/approvals/log-summarizer.lock.json
```

Exit `0`. Restoring one without the other produces exit `2` and a failing CI
gate — which is the point.

**Discarding a rejected candidate.** If review rejects an update, delete the
quarantined copy. Nothing else changes: the active installation was never
modified, and its record still matches.

```sh
rm -rf ~/skill-review/log-summarizer-next
sigildex check .claude/skills/log-summarizer --against .sigildex/approvals/log-summarizer.lock.json
```

Exit `0` — the rejection cost you nothing.

## What an approval record cannot freeze

A record binds bytes at one moment. A byte-identical skill can behave completely
differently when any of the following changes, and none of them are visible to
`check`:

- **Mutable remote instructions.** A skill that fetches a prompt, a
  configuration, or a document at runtime carries a pointer, not content. The
  pointer is frozen; what it returns is not.
- **Unpinned dependencies.** `pip install requests`, `npm install some-tool`,
  an unpinned action — the instruction is frozen, the resolved artifact is not.
- **External APIs and services.** A skill that calls a remote endpoint is only
  as trustworthy as that endpoint is today.
- **Install-time behavior.** Whatever ran when the skill was installed already
  ran. A record made afterwards cannot describe it. This is why staging comes
  before installation.
- **Runtime environment changes.** New environment variables, a changed PATH, a
  different working directory, a different model — same bytes, different
  behavior.
- **Credentials granted by the agent harness.** The record describes the skill,
  not what the harness hands it. Broadening the agent's permissions broadens the
  skill's reach without changing a single byte.
- **Empty directories.** Two trees that differ only by empty directories have the
  same identity. This is a documented limitation.
- **Whether the review was any good.** A record captures what you approved. It
  has no opinion about whether you should have.

Sigildex closes exactly one gap: *what you approved is no longer what is
installed, and nobody noticed.* Everything above is why the rest of the workflow
in this guide exists.

## See it end to end

[examples/version-drift](https://github.com/sigildex/sigildex/tree/main/examples/version-drift)
is a runnable walkthrough of the whole lifecycle — adoption, verification,
drift, review, re-approval, lock-only change, and removal — with the exit code
asserted at every step.

For the normative details of how identity is computed, what is in scope, and how
every failure is handled, see [identity-spec.md](identity-spec.md).
