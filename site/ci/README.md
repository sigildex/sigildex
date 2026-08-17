# Enforcing approvals in CI

[`approval-check.yml`](approval-check.yml) is a copy-paste GitHub Actions
workflow for a repository that holds an agent skill and its approval record. It
fails a pull request when the skill and the record stop agreeing.

Copy it into `.github/workflows/`, set the three values under `env`
(`SKILL_DIR`, `APPROVAL`, `SIGILDEX_VERSION`), and require it in branch
protection. It watches one skill; for several, duplicate the file per skill or
loop the final step over a list. Put the workflow itself under CODEOWNERS as
well — see the governance section below for why that is load-bearing.

## What it proves

- The **baseline is sound**: the skill directory at the pull request's base
  commit matches the approval record at that same commit. This is checked before
  any outcome is decided, including the outcomes that end the job successfully —
  a removal, a lock-only change, and a no-op are all statements about the base
  revision, so none of them may be reached before the base has been proved. A
  pull request is never compared against, or excused by, a reference that was
  already broken.
- The **candidate is consistent**: the skill directory in the pull request
  matches the approval record in the pull request.
- The **states move together**: adding, updating, or removing a skill without
  the corresponding change to its approval record fails. So does an approval
  record with no artifact, and an artifact with no approval record.

All three hold for the **one** skill/record pair named in `env`. Nothing here
looks at any other entry in `.sigildex/approvals/` — see "What it cannot prove"
below.

When the skill existed at the base commit, it also attaches an approval delta to
the job summary — how many files were added, removed, and changed — so a
reviewer knows the size of what they are approving before opening the diff. A
first adoption and a removal have nothing to compare against, so they carry the
note alone.

Result table, for the states the workflow distinguishes:

| Pull request does this | Result |
|---|---|
| Adds a skill and a matching record | pass |
| Changes both consistently | pass |
| Changes the skill, leaves the record | **fail** |
| Changes the record, leaves the skill mismatched | **fail** |
| Changes only the record's metadata | pass, flagged in the summary for human approval |
| Removes both | pass |
| Removes only one of them | **fail** |
| Touches neither | pass |
| Starts from a base whose skill and record already disagree | **fail**, whatever else the pull request does — removal included |
| Starts from a base whose approval record is not a valid record | **fail**, reported as an invalid record rather than as drift |

## What it cannot prove

- **That the change should be approved.** Consistency is mechanical; approval is
  a judgement. A pull request that rewrites a skill and regenerates its record in
  the same commit passes this workflow. Only a human reading the change can
  decide it is acceptable — see the governance section below.
- **That a skill was added at all.** A pull request that adds a *new* skill
  directory with no approval record touches neither `SKILL_DIR` nor `APPROVAL`,
  so the workflow reaches its no-op outcome and passes — and it triggers no
  code-owner review either, unless the consumer also puts its skills directory
  under CODEOWNERS. Cover the directory your agent actually loads, for example
  `.claude/skills/** @your-org/skill-approvers`, so an unapproved skill cannot
  arrive unreviewed through a path nothing watches.
- **That the skill is safe.** Sigildex does no scanning, no scoring, and no
  provenance verification. A record's `declared_source`, if present, is
  user-supplied and unverified.
- **Anything after the merge.** A record binds bytes at lock time. It says
  nothing about what a harness loads later, what a dependency resolves to, or
  what a remote instruction returns at runtime. Re-check at install time, and
  again before activation if your threat model needs it.
- **Approval-layout rules across many skills.** Approval IDs and artifact paths
  must be unique across a project, and no lock may be left behind without its
  artifact. **v0.1 does not audit a directory of approvals for duplicate
  approval IDs, duplicate artifact paths, or orphaned locks** — not this
  workflow, and not the tool. Keeping the store clean is the project's
  responsibility: put `.sigildex/approvals/` under CODEOWNERS and review
  additions to it, as described below. The one layout rule that *is* enforced —
  a record's filename matching its `approval_id` — is enforced by `sigildex
  lock` at write time, which refuses to write a misnamed record at all.
- **The integrity of its own supply chain.** The workflow installs the tool at a
  pinned version into a directory outside the pull request's checkout, and then
  invokes it by absolute path. That is deliberate, and it is not a style
  preference: package resolution that starts in the workspace is
  attacker-controlled. `npx sigildex@<version>` run with the pull request as the
  working directory prefers a `node_modules/sigildex` the pull request itself
  committed whenever that copy's version satisfies the request, and it never
  contacts the registry — so a pull request could ship a `sigildex` whose only
  behavior is to exit 0, and every check below would pass. Disabling lifecycle
  scripts does not help, because the shadowed package *is* the command rather
  than a script hook. Keep the install and the invocation out of the workspace
  if you adapt the snippet. Beyond that: pin deliberately, review version bumps
  like any other dependency change, and vendor the tool instead if your
  environment requires it.
- **That the published JSON Schema is the record contract.** If you validate
  approval records against `schema/approval-record.schema.json` anywhere,
  understand that it is a *structural subset* of the specification. Its string
  limits count code points where the specification counts UTF-8 bytes, it
  cannot express the Unicode-assignment rule on recorded paths, and it cannot
  express manifest ordering, uniqueness, or the requirement that `root_digest`
  agree with the manifest it is derived from. Records exist that the schema
  accepts and `sigildex check` rejects. This workflow gates on `check`'s exit
  status, which is the authoritative answer; a schema pass is not.

## Governance: the workflow proves consistency, humans prove approval

The workflow can only tell you that an approval record was regenerated. Making
regeneration require a human is a repository-settings job.

Put approval records **and this workflow** behind code owners —
`.github/CODEOWNERS`:

```
/.sigildex/approvals/** @your-org/skill-approvers
/.github/workflows/**  @your-org/skill-approvers
```

The second line is not belt-and-braces. On `pull_request`, GitHub Actions runs
the workflow file **as the pull request writes it** — including from a fork. A
pull request that replaces the run block with `exit 0`, or deletes the checks
while keeping the job name, produces a green required status check. **A pull
request that edits this workflow is exactly as approval-affecting as one that
edits an approval record, and it is available to any contributor who can open a
pull request** — no administrator rights, no bypass, no team membership. Cover
both paths with the same code-owner review, and keep "dismiss stale approvals"
on, so a review of the workflow cannot be granted and then reused after the
workflow changes.

Then, in branch protection (or a ruleset) on the default branch:

- Require a pull request before merging.
- Require review from code owners.
- Dismiss stale approvals when new commits are pushed, so an approval cannot be
  granted before the record changes and reused afterwards.
- Require the **Skill approval check** status check to pass.
- Require branches to be up to date before merging, so the check runs against
  the base the merge will actually use.
- Block force pushes to, and deletion of, the protected branch.
- Apply the rules to administrators.

**The honest caveat:** these are repository settings, not cryptography. Anyone
who can change branch protection, edit `CODEOWNERS`, add themselves to the
owning team, use an allowed bypass, or merge with administrator privileges can
land an approval record no reviewer read. This setup makes unreviewed approval a
visible, auditable administrative act rather than an ordinary commit — that is
the guarantee, and it is worth stating plainly rather than overselling.

## Notes on the workflow's hardening

The snippet is written to be safe against the content it inspects, which is
untrusted by definition:

- It triggers on `pull_request`, never `pull_request_target`, so untrusted code
  is never checked out into a privileged context. The cost of that choice is
  that the workflow file itself is pull-request-controlled — covered by
  CODEOWNERS above, not by anything in the snippet.
- The tool is installed outside the checkout and invoked by absolute path, so
  no part of the resolution — the package, its version, or the `.npmrc` that
  points at a registry — comes from the tree under review. The install step
  also leaves the workspace before running `npm`, which is what keeps a
  committed `.npmrc` or `package.json` out of it.
- Its permissions are `contents: read` and nothing else. It uses no secrets.
- Third-party actions are pinned by full commit SHA with the version in a
  comment. Update the SHA and the comment together.
- It never runs, sources, or installs anything from the skill under review — the
  skill's bytes are only read and hashed. Dependency lifecycle scripts are
  disabled during the tool install.
- The job summary carries category counts only, never paths, frontmatter, or
  script text, because summaries render Markdown. Those counts are advisory; the
  gate is the exit status of the checks.
- The base commit comes from the pull request event payload and is fetched
  explicitly, because the default checkout is shallow and `origin/main` is not
  necessarily the base of the pull request being reviewed.

## Seeing it end to end

[`examples/version-drift`](https://github.com/sigildex/sigildex/tree/main/examples/version-drift)
walks the same lifecycle locally — adoption, verification, drift, review, re-approval, removal
— with the exit code for each step.
