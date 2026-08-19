# Safe skill adoption

How to evaluate an agent skill, approve it deliberately, and notice when what
you approved changes.

A skill is instructions, often with scripts, that you hand to a system holding
your tools, credentials, and filesystem. Adopting one is a trust decision. This
guide is the workflow around that decision, in ten stages. Sigildex does the work
in four of them (5, 6, 9, 10) and connects the rest.

1. [**Discover**](#discovering-candidate-skills) a candidate.
2. [**Stage**](#quarantine-staging) it in quarantine, outside anything an agent loads.
3. [**Scan**](#scanning-and-manual-review) it for evidence, not certification.
4. [**Review**](#the-manual-review-checklist) it. A person reads it and decides.
5. [**Record**](#recording-an-approval) the approved bytes: `sigildex lock`.
6. [**Install and verify**](#install-and-verify) the copy that will run: `sigildex check`.
7. [**Detect**](#checking-approved-skills-for-updates) upstream changes with read-only checks you run yourself.
8. [**Quarantine**](#quarantine-the-update) the update, leaving the active copy untouched.
9. [**Diff**](#staging-and-comparing-the-update) the two trees: `sigildex diff`.
10. [**Re-approve**](#re-approve): a human reads the diff, `lock` records the new approval, and the CI gate catches mismatched states.

**What a record is, and isn't.** An approval record is a snapshot of bytes:
these files, at these paths, with these digests and executable bits, at lock
time. It is not a certificate that the skill is safe, not proof that anyone
reviewed it, and not provenance. The optional `--source-*` fields are your own
unverified note of where you believe it came from, and they sit outside the
digest.

Sigildex makes no network calls, collects no telemetry, and produces no score.
It answers one question, deterministically: do the installed bytes still match
what was approved? Trust comes from where the records live and who can change
them: a protected branch, code-owner review, a required status check. The rest
of this guide is what makes the answer mean something.

**Prerequisites.** Node.js 20+; `npm install -g sigildex@0.1.1`; macOS or Linux
(Windows exits `1` unsupported; use WSL). Quickstart: [README](../README.md).

**Exit codes**, used throughout: `0` match or identical · `2` drift or differ ·
`1` tool, input, filesystem, or walk error · `3` unsupported or invalid record.
`1` and `3` mean no verdict was produced; an error is never reported as a match.

What this workflow defends against and what it does not:
[threat-model.md](threat-model.md).

## Discovering candidate skills

Where a skill comes from is part of what you are evaluating. Candidates come
from ecosystem CLIs and catalogs (the GitHub CLI's `gh skill`, preview, built in
from version 2.90.0; the Vercel Skills CLI and skills.sh), publisher
repositories, and your own organization.

Popularity is the weakest signal. Before spending review effort, capture:

- **Publisher identity.** A person or organization you can name, and whether
  you have reason to trust the account.
- **Provenance.** Repository, subdirectory, and exact commit or tag. You will
  need these three values again for update checks.
- **Maintenance.** Recent commits, responsiveness on issues, signs of
  abandonment.
- **Licensing.** Whether you may use it at all.
- **Fit.** Whether the stated purpose is something you need.

## Quarantine staging

Fetch the candidate into a directory **no agent or runtime is configured to
load**, so review happens before anything can execute.

```sh
mkdir -p ~/skill-review
git clone --depth 1 https://github.com/example-org/example-skills ~/skill-review/_src
cp -R ~/skill-review/_src/skills/log-summarizer ~/skill-review/log-summarizer
```

Rules for the staging directory:

- It sits outside every active skills directory and every path your harness
  scans.
- **Never run bundled scripts**, install commands, or setup steps from a staged
  candidate, even "to see what it does". That is the thing you are avoiding.
- Treat `SKILL.md` as untrusted content. Text written to be read by a model can
  be written to influence one. Read it yourself, in an ordinary editor or pager.
- Record where it came from (repository, subdirectory, commit) next to the
  staged copy.

## Scanning and manual review

Scanners produce **evidence**. A clean report is not an approval, and every
scanner below says so in its own documentation. Run more than one; the
disagreements are informative.

### Scanner examples

*Commands checked against each project's documentation as of 2026-08-16;
re-check before relying on exact syntax.*

**NVIDIA SkillSpector**: <https://github.com/NVIDIA/skillspector>

```sh
uv tool install git+https://github.com/NVIDIA/skillspector.git
skillspector scan ~/skill-review/log-summarizer --no-llm --format json --output ~/skill-review/skillspector.json
```

`--no-llm` restricts it to static analysis and needs no API key, but its
dependency check may still query OSV.dev for advisories. It exits non-zero on a
do-not-install verdict while still writing a valid report, so read the JSON
rather than branching on the exit code.

**Cisco AI Defense Skill Scanner**: <https://github.com/cisco-ai-defense/skill-scanner>

```sh
pip install cisco-ai-skill-scanner
skill-scanner scan ~/skill-review/log-summarizer --format json
```

The default run is offline; LLM and network analyzers are opt-in flags, some of
which need API keys. `uvx --from cisco-ai-skill-scanner skill-scanner scan …`
runs it without installing.

**Snyk Agent Scan**: <https://github.com/snyk/agent-scan>

```sh
SNYK_TOKEN=<your-token> uvx snyk-agent-scan@0.5.17 ~/skill-review/log-summarizer
```

Pin the version deliberately rather than tracking `@latest`, and always pass the
staged path. Run without one, Agent Scan switches to machine-wide mode and
**starts configured stdio MCP servers** (with consent) to enumerate what you
already run, which is exactly what quarantine exists to prevent.

For a single quarantined directory, SkillSpector and the Cisco scanner are the
more direct fit. Whatever the current syntax, the step's shape is fixed: *point a
scanner at the quarantined directory, capture machine-readable output, and read
it.*

### The manual review checklist

Scanners find patterns. A human decides whether the skill should exist in your
environment at all. Read the staged files (`SKILL.md`, then every script, then
every reference document) and answer:

- **What does it instruct the agent to do**, in its own words? Restate the
  skill's behavior in one or two sentences without using its vocabulary. If you
  cannot, you have not finished reading it.
- **Which tools and permissions does it request?** Shell access, file writes,
  network calls, credential reads.
- **What is in the bundled scripts?** Read every executable file. An executable
  bit on a file you did not expect to be executable is worth pausing on.
- **What dependencies and install commands does it carry?** Are versions
  pinned? What runs at install time?
- **What credential, network, and filesystem access does it need**, and where
  does anything it reads end up?
- **Does it fetch remote instructions or resources at runtime?** Anything
  retrieved after approval is outside the record entirely.
- **Is the requested capability proportionate to the stated purpose?** A log
  summarizer that wants your SSH keys fails this test regardless of what any
  scanner reported.

Record your conclusion, the scanner outputs, and the commit you reviewed. Those
notes, not the approval record, are the evidence that a review happened.

## Recording an approval

Once a human has decided, capture the exact reviewed state. `--artifact-path`
names where the artifact will live; the examples use
`.claude/skills/log-summarizer`, so substitute the directory your agent loads.

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
executable bit, and an informational class, plus one root digest over that
manifest.

Flags:

- `--out`: required. The parent directory must exist, the filename must be
  `<approval-id>.lock.json`, and the record may not sit inside the measured
  directory. A violation exits `1` and writes nothing.
- `--approval-id`: `[a-z0-9][a-z0-9-]{0,63}`. Defaults to a value derived from
  the directory name; pass it explicitly for a stable id.
- `--artifact-path`: the project-relative path the artifact will occupy.
  Required when the path you type lies outside the current directory, as above.
  The rule reads the path as written, so a symlink inside the project counts as
  inside. Records never contain absolute local paths.
- `--source-*`: optional. Records an unverified `declared_source` hint that sits
  outside the digest, so editing it is never drift. See
  [Checking approved skills for updates](#checking-approved-skills-for-updates).
- `--json`: print the record instead of the human summary.

Edge cases and grammars: [identity-spec.md](identity-spec.md).

**The approval store.** Keep one record per skill at
`.sigildex/approvals/<approval-id>.lock.json`. The tool enforces the filename,
and the record grammar binds each record to one artifact path. Nothing in 0.1
audits the directory for duplicate ids, duplicate artifact paths, or orphaned
records (the CI workflow checks only the pair it is configured with), so put
the directory under `CODEOWNERS` and read what lands there.

## Install and verify

Copy the approved artifact from quarantine into the place your agent loads,
then verify before anything runs:

```sh
cp -R ~/skill-review/log-summarizer .claude/skills/log-summarizer
sigildex check .claude/skills/log-summarizer --against .sigildex/approvals/log-summarizer.lock.json
```

Exit `0`: the installed copy is the reviewed copy. Exit `2`: it is not; stop
and find out why before an agent loads it. Any other code: the check did not
complete (see exit codes).

A match binds the bytes **during the measurement window only**. It says nothing
about what the harness loads five minutes later. If your threat model needs
execution-time integrity, re-run `check` immediately before activation, or run
from an immutable copy of the verified artifact.

**Two installation strategies.** How you install decides whether an update can
be detected later. Choose before you lock, and write down which one each skill
uses.

- **Trackable.** The installer knows where the skill came from and can report
  upstream changes; a skill placed by plain `cp`, as above, is invisible to
  `gh skill update`. Sigildex keeps the change from becoming trusted
  automatically.
- **Installer-pinned.** Stronger pinning, but `gh skill update` skips anything
  installed with `gh skill install --pin`, with a notice. Pair pinning with a
  release watcher so "pinned" never quietly becomes "unwatched".

## Checking approved skills for updates

Sigildex runs no crawler, daemon, or `watch` command, keeps no hosted inventory,
and never installs or approves anything. Detection is a read-only check that you
or your CI runs on purpose:

- **On demand**, for personal installs. With the GitHub CLI (2.90.0+;
  `gh skill` is still marked preview):

  ```sh
  gh skill update --dry-run
  ```

  `--dry-run` compares each installed skill's recorded tree SHA against the
  remote and writes nothing. Skills installed with `--pin` are skipped with a
  notice. Other installers offer equivalent read-only modes; confirm in their
  docs that the mode writes nothing.

- **Scheduled**, for repositories. A workflow in your own account runs a
  read-only source check and opens an issue or draft pull request when upstream
  has moved. It never merges, never replaces the trusted skill, and never records
  an approval; its only job is to tell a human there is something to look at.

**Telling your checker where to look.** A record can carry a `declared_source`
(repository, path, approved commit, tracking label) written from the
`--source-*` flags at lock time. It is a hint for your own checker or the Agent
Skill, not for `gh skill update`, which reads the installer's frontmatter.

`kind` and `tracking_policy` are free-form labels the tool records and never
interprets. Values are validated before anything is written; a bad one exits `1`
naming the flag (grammars: [identity-spec.md](identity-spec.md)).

A record without `declared_source` is reported as having no update source
configured. To add one, re-lock the already-verified artifact:

```sh
sigildex check .claude/skills/log-summarizer --against .sigildex/approvals/log-summarizer.lock.json   # exit 0 first
sigildex lock .claude/skills/log-summarizer \
  --approval-id log-summarizer \
  --out .sigildex/approvals/log-summarizer.lock.json \
  --source-kind git \
  --source-repository https://github.com/example-org/example-skills \
  --source-path skills/log-summarizer \
  --source-commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 \
  --source-tracking track-default-branch
```

Re-locking rewrites the record from the artifact's current bytes, so only do it
when `check` exits `0` immediately before.

### Quarantine the update

Fetch the candidate into a temporary directory, never over the active
installation, and prove the active copy is untouched by running the same check
before and after:

```sh
sigildex check .claude/skills/log-summarizer --against .sigildex/approvals/log-summarizer.lock.json
# … run detection, fetch the candidate to ~/skill-review/log-summarizer-next …
sigildex check .claude/skills/log-summarizer --against .sigildex/approvals/log-summarizer.lock.json
```

Both exit `0`. If the second exits `2`, something in your detection path wrote
to the active installation; stop and fix that first.

### Staging and comparing the update

```sh
sigildex diff .claude/skills/log-summarizer ~/skill-review/log-summarizer-next
```

Exit `0` identical, `2` different, `1` a walk failed. Every differing path is
`added`, `removed`, or `changed`; `changed` entries carry `content_changed` and
`mode_changed` separately. Frontmatter differences are shown for information
and are never part of identity.

`--json` gives the same facts in a stable structure (stable, not sanitized). It
includes both trees' frontmatter verbatim under `base.skill.frontmatter` and
`candidate.skill.frontmatter` (`lock` and a matching `check` embed it under
`skill.frontmatter`; only the drift report is frontmatter-free). If the output
goes into an agent's context, strip it first, and capture the exit code before
piping:

```sh
out=$(sigildex diff BASE CAND --json); code=$?
printf '%s' "$out" | jq 'walk(if type == "object" then del(.frontmatter) else . end)'
echo "exit $code"
```

This reduces exposure; it is not a security boundary.

### Re-approve

The update is a new candidate: return to
[Scanning and manual review](#scanning-and-manual-review), and only a human
re-approves. Re-approval replaces the record in place:

```sh
sigildex lock ~/skill-review/log-summarizer-next \
  --approval-id log-summarizer \
  --artifact-path .claude/skills/log-summarizer \
  --out .sigildex/approvals/log-summarizer.lock.json \
  --source-kind git \
  --source-repository https://github.com/example-org/example-skills \
  --source-path skills/log-summarizer \
  --source-commit <the-commit-you-reviewed> \
  --source-tracking track-default-branch
```

A re-lock writes a whole new record, so repeat the `--source-*` flags with the
newly approved commit, or the skill drops back to "no update source
configured". Install, then `check` again.

**Enforcing approvals in CI.** For skills that live in Git, make the check a
merge gate. A copy-paste GitHub Actions workflow and its full rationale are in
[ci/README.md](ci/README.md) and [ci/approval-check.yml](ci/approval-check.yml).

For the one skill/record pair it is configured with, the gate proves the base
revision's skill matched its own record and the pull request's skill matches the
pull request's record. It fails when the two disagree or when only one is
present; a record-only metadata change passes but is flagged in the job summary.

The gate cannot prove the change *should* be approved: a pull request that
rewrites a skill and regenerates its record in the same commit is mechanically
consistent. Making regeneration require a human is a repository-settings job:
put `/.sigildex/approvals/**` under `CODEOWNERS`, require code-owner review,
dismiss stale approvals on new commits, and require the check.

Those are settings, not cryptography. Anyone who can change branch protection
can bypass them. What they buy you is that unreviewed approval becomes a
visible administrative act rather than an ordinary commit.

## Adopting an already-installed skill

Bring skills that predate this workflow in without reinstalling:

1. **Inventory** the directories your harness loads.
2. **Copy to review staging**, so the active copy stays untouched while you
   work.
   ```sh
   cp -R .claude/skills/log-summarizer ~/skill-review/log-summarizer
   ```
3. **Scan and review** the staged copy exactly as you would a new candidate.
   Being installed is evidence of nothing except that someone installed it.
4. **Record the approval** from the staged copy, with `--artifact-path` pointing
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
   Exit `0`. Exit `2` here is informative: something modified the installed
   copy after installation. Find out what before you approve anything.

If review turns up something you will not accept, this is a removal, not an
adoption. See below.

## Removal, emergency revocation, and rollback

**Ordinary removal.** Delete the artifact and its approval record in the same
change. Half of that is a broken state: a record whose artifact is gone exits
`1` with no verdict, and an artifact with no record is what CI catches as
unapproved, for the skills it is configured to watch. Remove completely rather
than relying on being caught.

```sh
rm -rf .claude/skills/log-summarizer
rm .sigildex/approvals/log-summarizer.lock.json
```

**Emergency revocation.** A publisher is compromised, or a skill turns out to
do something it should not:

1. Remove the artifact from every active skills directory first. The approval
   record is bookkeeping; the artifact is what runs.
2. Remove the approval record in the same change, so nothing re-derives trust
   from it.
3. Restart the agent harness unless the harness documents otherwise. Many harnesses read
   skills at startup or cache them, so deleting files may leave what is
   resident loaded.
4. Check whether the same skill is installed anywhere else: other machines,
   other repositories, CI images.
5. Treat every credential the skill could reach as exposed and rotate it. The
   record lists which files were present (paths, sizes, digests, modes), not
   their contents and not what already ran. Recover contents from the reviewed
   commit.

**Rollback to a previously approved artifact.** Artifact and record both live in
Git, so a previous approved state is a previous commit. Restore both, then
verify:

```sh
git checkout <known-good-commit> -- .claude/skills/log-summarizer .sigildex/approvals/log-summarizer.lock.json
sigildex check .claude/skills/log-summarizer --against .sigildex/approvals/log-summarizer.lock.json
```

Exit `0`. Restoring one without the other produces exit `2` and a failing CI
gate, which is the point.

**Discarding a rejected candidate.** Delete the quarantined copy. The active
installation was never modified and its record still matches:

```sh
rm -rf ~/skill-review/log-summarizer-next
sigildex check .claude/skills/log-summarizer --against .sigildex/approvals/log-summarizer.lock.json
```

Exit `0`. The rejection cost you nothing.

## What an approval record cannot freeze

A record binds bytes at one moment. A byte-identical skill behaves differently
when any of the following changes, and none of them is visible to `check`:

- **Mutable remote instructions.** A skill that fetches a prompt or document at
  runtime carries a pointer, not content. The pointer is frozen; what it returns
  is not.
- **Unpinned dependencies.** `pip install requests`, `npm install some-tool`,
  an unpinned action: the instruction is frozen, the resolved artifact is not.
- **External APIs and services.** A skill that calls a remote endpoint is only
  as trustworthy as that endpoint is today.
- **Install-time behavior.** Whatever ran at install time already ran; a record
  made afterwards cannot describe it. This is why staging comes before
  installation.
- **Runtime environment changes.** New environment variables, a changed PATH, a
  different working directory, a different model: same bytes, different
  behavior.
- **Credentials granted by the agent harness.** The record describes the skill,
  not what the harness hands it. Broadening the agent's permissions broadens the
  skill's reach without changing a byte.
- **Whether the review was any good.** A record captures what you approved. It
  has no opinion about whether you should have.

Sigildex closes exactly one gap: *what you approved is no longer what is
installed, and nobody noticed.* Everything above is why the rest of this guide
exists.

Separately, a documented limitation of the identity itself: two trees that
differ only by empty directories have the same identity
([identity-spec.md](identity-spec.md)).

## See it end to end

[examples/version-drift](https://github.com/sigildex/sigildex/tree/main/examples/version-drift)
is a runnable walkthrough of the whole lifecycle (adoption, verification,
drift, review, re-approval, lock-only change, and removal) with the exit code
asserted at every step.

For the normative details of how identity is computed, what is in scope, and how
every failure is handled, see [identity-spec.md](identity-spec.md).
