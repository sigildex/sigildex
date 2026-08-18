# Update checks

How to detect that an approved skill's upstream has moved, without touching the
installed copy. Sigildex runs no crawler, daemon, or `watch` command and keeps
no hosted inventory; detection is a read-only check that a human or a scheduled
workflow runs on purpose. Read this before running `gh skill update` or any
other installer's checker.

*Checked against the GitHub CLI manual,
<https://cli.github.com/manual/gh_skill_update>, on 2026-08-16. `gh skill` is
young and labelled preview in its own help; verify against the tool's current
documentation and report a failure rather than guessing at syntax.*

## GitHub CLI

For skills installed with `gh skill install`:

```sh
gh skill update --dry-run
```

- Needs `gh` 2.90.0 or newer — a separate tool the human installs; `gh skill`
  is built in from that version.
- `--dry-run` reports available updates and modifies no files. It compares the
  tree SHA recorded in each installed skill's own frontmatter against the
  remote repository.
- It reads installer metadata, not the approval record. Re-locking with the
  `--source-*` flags does not configure it; `declared_source` is for your own
  checker or this skill's workflow.
- The flags it accepts are `--all`, `--dir`, `--dry-run`, `--force`, and
  `--unpin`. Anything installed with `gh skill install --pin` is skipped with
  a notice; `--pin` is an install-time flag, and `--unpin` clears the pin.
- A skill placed by plain `cp` carries no installer frontmatter, so `gh` has no
  update source for it and may prompt for one interactively. To keep GitHub CLI
  tracking, stage with `gh skill install <owner/repo> <skill> --dir ~/skill-review`
  (`--dir` is the destination root; it writes source metadata into the
  frontmatter), verify the resulting directory, review and lock it, then copy
  that into place. `gh skill update --dry-run` scans the known agent skills
  directories; `--dir <path>` scans a custom one.

Use only documented read-only modes. If you are not certain a command is
read-only, do not run it — ask the human.

## Other installers

Other installers offer equivalent read-only modes. Read their documentation to
confirm the mode writes nothing before running it, and never run a mutating
update command against an approved active directory.

## `declared_source`

A record may carry `kind`, `repository`, `path`, `approved_commit`,
`tracking_policy`, and the literal `verification: "user_supplied"`. It is
user-supplied and unverified: an orchestration hint for your own checker,
never provenance, never evidence of origin. `kind` and `tracking_policy` are
free-form labels the tool records and does not interpret. To add or change it,
re-lock with the `--source-*` flags (`references/cli-reference.md` has the
grammars); the human supplies the values, and the re-lock runs only when
`check` already exits `0`.

## Checking a `declared_source` yourself

For `kind: git` records with `repository`, `path`, and `approved_commit` set,
compare the skill's path at the approved commit with the same path upstream. A
blobless, checkout-less clone is read-only and touches nothing installed:

```sh
git clone --filter=blob:none --no-checkout <repository> ~/skill-review/_upstream &&
cd ~/skill-review/_upstream &&
rev=$(git rev-parse --verify --quiet "<approved_commit>^{commit}") &&
tip=$(git rev-parse --verify --quiet "origin/HEAD^{commit}") &&
git cat-file -e "$rev:<path>" &&
{ git diff --quiet "$rev" "$tip" -- "<path>"; rc=$?; [ "$rc" -le 1 ] && echo "diff $rc"; }
```

Every step is chained with `&&`, so the diff runs only if the clone, both
revisions, and the path at the approved commit all resolved; the last line
prints `diff 0` or `diff 1` and nothing otherwise. Compare against the default
branch unless the human names a branch or tag. Then:

- `diff 0` (the path is identical at both revisions) → **CURRENT**;
- `diff 1` (the path differs) → **UPDATE AVAILABLE**, naming both revisions;
- `repository`, `path`, or `approved_commit` missing from the record → **NO
  UPDATE SOURCE CONFIGURED**;
- no `diff` line printed — the clone failed, a revision did not resolve, the
  path is absent at the approved commit, or the diff itself errored → the check
  did not run. Say so; it is neither state. (`declared_source` is unverified,
  so a stale path must fail, not read as CURRENT.)

Comparing bare commit ids is not enough: an upstream commit that never touched
`path` is not an update. `rev-parse` accepts the abbreviated ids the record
grammar allows and expands them; fetch refspecs do not.

## Reporting

Per skill, exactly one of:

- **CURRENT** — approved revision matches upstream.
- **UPDATE AVAILABLE** — name the approved revision and the upstream revision.
- **NO UPDATE SOURCE CONFIGURED** — no checker has anything to read: neither
  installer metadata nor a usable `declared_source`.

A check that was skipped, errored, or could not be resolved is none of these:
say that the check did not run, and never report it as CURRENT.

Before and after detection, `sigildex check` every approved skill against its
record. All must exit `0` both times; a `2` afterwards means something in the
detection path wrote to an active installation.

## Scheduled checks

For repositories, a workflow in your own account can run the same read-only
check on a schedule and open an issue or draft pull request when upstream has
moved. It never merges, never replaces the trusted skill, never records an
approval, and never treats "upstream released something" as approval; its only
job is to tell a human there is something to look at.
