# Enforcing approvals in CI

[`approval-check.yml`](approval-check.yml) is a copy-paste GitHub Actions
workflow for a repository that holds an agent skill and its approval record. It
fails a pull request when the skill and the record stop agreeing.

Copy it into `.github/workflows/`, set the three values under `env`
(`SKILL_DIR`, `APPROVAL`, `SIGILDEX_VERSION`), and require it in branch
protection. It watches one skill; for several, duplicate the file per skill or
loop the final step over a list.

## What it proves

- The **baseline is sound**: the skill directory at the pull request's base
  commit matches the approval record at that same commit. A pull request is
  never compared against a reference that was already broken.
- The **candidate is consistent**: the skill directory in the pull request
  matches the approval record in the pull request.
- The **states move together**: adding, updating, or removing a skill without
  the corresponding change to its approval record fails. So does an approval
  record with no artifact, and an artifact with no approval record.

It also attaches an approval delta to the job summary — how many files were
added, removed, and changed — so a reviewer knows the size of what they are
approving before opening the diff.

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
| Starts from a base whose skill and record already disagree | **fail** |

## What it cannot prove

- **That the change should be approved.** Consistency is mechanical; approval is
  a judgement. A pull request that rewrites a skill and regenerates its record in
  the same commit passes this workflow. Only a human reading the change can
  decide it is acceptable — see the governance section below.
- **That the skill is safe.** Sigildex does no scanning, no scoring, and no
  provenance verification. A record's `declared_source`, if present, is
  user-supplied and unverified.
- **Anything after the merge.** A record binds bytes at lock time. It says
  nothing about what a harness loads later, what a dependency resolves to, or
  what a remote instruction returns at runtime. Re-check at install time, and
  again before activation if your threat model needs it.
- **Approval-layout rules across many skills.** Approval IDs and artifact paths
  must be unique across a project, and each record's filename must match its
  `approval_id`. The single-skill snippet does not audit the whole
  `.sigildex/approvals/` directory for that.
- **The integrity of its own supply chain.** The workflow installs the tool from
  the public registry at a pinned version. Pin deliberately, review version
  bumps like any other dependency change, and vendor the tool instead if your
  environment requires it.

## Governance: the workflow proves consistency, humans prove approval

The workflow can only tell you that an approval record was regenerated. Making
regeneration require a human is a repository-settings job.

Put approval records behind code owners — `.github/CODEOWNERS`:

```
/.sigildex/approvals/** @your-org/skill-approvers
```

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
land an approval record no reviewer read. The same holds for anyone who can push
a workflow change. This setup makes unreviewed approval a visible, auditable
administrative act rather than an ordinary commit — that is the guarantee, and
it is worth stating plainly rather than overselling.

## Notes on the workflow's hardening

The snippet is written to be safe against the content it inspects, which is
untrusted by definition:

- It triggers on `pull_request`, never `pull_request_target`, so untrusted code
  is never checked out into a privileged context.
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

[`examples/version-drift`](../../examples/version-drift) walks the same
lifecycle locally — adoption, verification, drift, review, re-approval, removal
— with the exit code for each step.
