# The CI approval check

What to tell a human who wants to set up, explain, or debug the GitHub Actions
approval check. The workflow file and its full rationale live in the
repository at `docs/ci/README.md` and `docs/ci/approval-check.yml` (served as
<https://sigildex.ai/ci/README.md> and <https://sigildex.ai/ci/approval-check.yml>).
Point the human there; summarize as below.

## Setup

Copy `approval-check.yml` into `.github/workflows/` and set the three `env`
values: the skill directory, its approval record, and the version to install.
Then add `CODEOWNERS` entries and branch protection (below). One workflow
instance watches one skill/record pair.

## What it proves

- The base is sound: at the pull request's base commit, the skill directory
  matches its record. Checked before any outcome, so a broken base is never
  compared against or excused.
- The candidate is consistent: the pull request's skill matches the pull
  request's record.
- The states move together: adding, updating, or removing one without the
  other fails.

All three hold for the one pair named in `env`. When the skill existed at the
base, the job summary carries an approval delta — counts of files added,
removed, and changed — never paths, frontmatter, or script text.

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
| Starts from a base whose skill and record already disagree | **fail**, whatever else it does |
| Starts from a base whose record is not a valid record | **fail**, reported as an invalid record, not drift |

## What it cannot prove

- That the change *should* be approved. A pull request that rewrites a skill
  and regenerates its record in the same commit passes. Only a human reading
  the change can decide.
- That a skill was added at all. A new skill directory with no record touches
  nothing the workflow watches, so it passes — and draws no code-owner review
  unless the skills directory is in `CODEOWNERS` too.
- Anything about other entries in `.sigildex/approvals/`: duplicate ids,
  duplicate artifact paths, orphaned records. Nothing audits the directory.
- Edits to `declared_source` or other record metadata are not mechanically
  blocked; they sit outside the identity digest and are governed by
  `CODEOWNERS`. Do not tell a human otherwise.

## Governance

Making regeneration require a human is repository settings: `CODEOWNERS` over
`/.sigildex/approvals/**` and `.github/workflows/**`, required code-owner
review, dismiss stale approvals on new commits, and the workflow as a required
status check. These are settings, not cryptography — an administrator can
bypass them. What they buy is that unreviewed approval becomes a visible
administrative act rather than an ordinary commit.

## Hardening, in one line each

`pull_request`, never `pull_request_target`; the tool installed outside the
checkout and invoked by absolute path, so a committed `node_modules` cannot
supply the program that judges it; `contents: read` and no secrets; actions
pinned by full commit SHA; nothing from the skill under review is run, sourced,
or installed; the base commit taken from the event payload and fetched
explicitly; the summary carries counts only. The reasoning behind each is in
`docs/ci/README.md`.
