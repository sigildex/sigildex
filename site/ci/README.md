# Enforcing approvals in CI

[`approval-check.yml`](approval-check.yml) is a copy-paste GitHub Actions
workflow for a repository that holds an agent skill and its approval record. It
fails a pull request when the skill and the record stop agreeing.

Copy it into `.github/workflows/`, set the three values under `env`
(`SKILL_DIR`, `APPROVAL`, `SIGILDEX_VERSION`), and require it in branch
protection. It watches one skill. For several, duplicate the file per skill or
loop the final step over a list. Put the workflow itself under CODEOWNERS;
[Governance](#governance) says why.

## What it proves

For the **one** skill/record pair named in `env`:

- **The base is sound.** The skill at the pull request's base commit matches
  the record at that commit. This is checked before any outcome is decided,
  including the passing ones. A removal, a record-only change, and a no-op are
  all statements about the base, so a broken base excuses nothing.
- **The candidate is consistent.** The skill in the pull request matches the
  record in the pull request.
- **The states move together.** Adding, updating, or removing a skill without
  the matching change to its record fails. So does a record without an
  artifact, or an artifact without a record.

When the skill existed at the base, the job summary also carries an approval
delta (files added, removed, changed), so a reviewer knows the size of the
change before opening the diff.

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
| Starts from a base whose skill and record already disagree | **fail**, whatever else the pull request does, removal included |
| Starts from a base whose approval record is not a valid record | **fail**, reported as an invalid record rather than as drift |

## What it cannot prove

- **That the change should be approved.** Consistency is mechanical; approval
  is a judgement. A pull request that rewrites a skill and regenerates its
  record in one commit passes. Only a human reading the change can approve it;
  see [Governance](#governance).
- **That a skill was added at all.** A pull request that adds a *new* skill
  directory with no record touches neither `SKILL_DIR` nor `APPROVAL`, so the
  workflow reaches its no-op outcome and passes, and no code-owner review
  triggers either. Cover the directory your agent loads, for example
  `.claude/skills/** @your-org/skill-approvers`.
- **That the skill is safe.** No scanning, scoring, or provenance
  verification; a record's `declared_source` is user-supplied and unverified.
- **Anything after the merge.** A record binds bytes at lock time. It says
  nothing about what a harness loads later, what a dependency resolves to, or
  what a remote instruction returns at runtime. Re-check at install time, and
  again before activation if your threat model needs it.
- **Approval-store hygiene.** Neither this workflow nor the tool audits
  `.sigildex/approvals/` for duplicate approval ids, duplicate artifact paths,
  or records left behind without their artifact. Put the directory under
  CODEOWNERS and review additions. The one layout rule `sigildex lock`
  enforces at write time is that a record's filename matches its
  `approval_id`.
- **The integrity of its own supply chain.** The workflow pins the tool's
  version and installs it outside the checkout, but the tool's one runtime
  dependency is resolved from the registry at install time. Review version
  bumps like any other dependency change; vendor the tool if your environment
  requires it.

## Governance

The workflow proves that a record was regenerated. Making regeneration require
a human is a repository-settings job.

Put approval records **and this workflow** behind code owners in
`.github/CODEOWNERS`:

```
/.sigildex/approvals/** @your-org/skill-approvers
/.github/workflows/**  @your-org/skill-approvers
```

The second line matters. On `pull_request`, GitHub Actions runs the workflow
file **as the pull request writes it**, including from a fork. A pull request
that replaces the run block with `exit 0`, or deletes the checks while keeping
the job name, produces a green required status check. Editing this workflow is
exactly as approval-affecting as editing an approval record, and any
contributor who can open a pull request can do it. Cover both paths with the
same code-owner review.

Then, in branch protection (or a ruleset) on the default branch:

- Require a pull request before merging.
- Require review from code owners.
- Dismiss stale approvals when new commits are pushed, so an approval cannot be
  granted before the record or workflow changes and reused afterwards.
- Require the **Skill approval check** status check to pass.
- Require branches to be up to date before merging, so the check runs against
  the base the merge will use.
- Block force pushes to, and deletion of, the protected branch.
- Apply the rules to administrators.

These are repository settings, not cryptography. Anyone who can change branch
protection, edit `CODEOWNERS`, join the owning team, use an allowed bypass, or
merge with administrator privileges can land a record no reviewer read. What
the setup buys is that unreviewed approval becomes a visible, auditable
administrative act rather than an ordinary commit.

## Hardening

The workflow is written to be safe against the content it inspects, which is
untrusted by definition. Each choice below is the reason behind a comment in
the workflow file.

- **`pull_request`, never `pull_request_target`.** `pull_request_target` runs
  with a writable token in the base repository's context while checking out
  untrusted content. The cost of `pull_request` is that the workflow file is
  pull-request-controlled. CODEOWNERS above covers that; the snippet does not.
- **The tool is installed outside the checkout and invoked by absolute path.**
  Package resolution that starts in the workspace is attacker-controlled.
  `npx sigildex@<version>` run in the pull request's tree prefers a
  `node_modules/sigildex` the pull request committed whenever its version
  satisfies the request, without contacting the registry, so the artifact
  under review would supply the program that judges it. Disabling lifecycle
  scripts does not help; the shadowed package *is* the command. The install
  runs in a runner temp directory with its own private `package.json`, so npm
  neither walks up into another project nor reads a committed `.npmrc`. Keep
  the install and the invocation out of the workspace if you adapt the snippet.
- **`contents: read` and nothing else.** No secrets; checkout with
  `persist-credentials: false`.
- **Actions pinned by full commit SHA**, with the version in a comment. Update
  the SHA and the comment together.
- **Nothing from the skill under review is run, sourced, or installed.** Its
  bytes are read and hashed. Dependency lifecycle scripts are disabled during
  the tool install.
- **The base commit comes from the event payload** and is fetched explicitly:
  the default checkout is shallow, and `origin/main` is not necessarily the
  base of the pull request. A trigger that supplies no base commit is refused,
  because an empty diff spec would fail in a way that reads as "changed", a
  pass built on nothing.
- **The job summary carries category counts only**, never paths, frontmatter,
  or script text, because summaries render Markdown. Counts are parsed from the
  JSON report rather than scanned from its text, since the report embeds the
  skill's own frontmatter verbatim. Counts are advisory; the gate is the exit
  status of the checks.
- **A schema pass.** The published JSON Schemas are structural subsets; this
  workflow gates on `sigildex check`, the authority on record validity.

## Seeing it end to end

[`examples/version-drift`](https://github.com/sigildex/sigildex/tree/main/examples/version-drift)
walks the same lifecycle locally (adoption, verification, drift, review,
re-approval, removal) with the exit code for each step.
