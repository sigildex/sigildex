# Removal, emergency revocation, and rollback

Read this when a human reports a compromised publisher, a skill behaving badly,
or asks to remove or roll back an approved skill. Everything here is something
you propose and the human runs or approves (hard boundary 1); the approval
record and the artifact move together.

## Ordinary removal

Delete the artifact and its approval record in the same change:

```sh
rm -rf .claude/skills/<name>
rm .sigildex/approvals/<name>.lock.json
```

Half of that is a broken state, and each half fails on its own: a record whose
artifact is gone exits `1` with no verdict; an artifact with no record is what
CI catches as unapproved, for the pairs it is configured to watch. Nothing scans
the approvals directory for records left behind, so removal is something done
completely, not something relied on being caught.

## Emergency revocation

In this order:

1. **Remove the artifact from every active skills directory first.** The record
   is bookkeeping; the artifact is what runs.
2. **Remove the approval record in the same change**, so nothing re-derives
   trust from it.
3. **Restart the agent harness.** Many harnesses read skills at startup or
   cache them; deleting files does not necessarily unload what is already
   resident. Assume a restart is required unless the harness documents
   otherwise.
4. **Check everywhere else the skill may be installed** — other machines, other
   repositories, CI images.
5. **Treat every credential the skill could reach as exposed, and rotate it.**

What the record can and cannot tell a responder: it lists exactly which files
were present — paths, sizes, SHA-256 digests, executable bits, and classes. It
does **not** store file contents, so the skill cannot be read back out of it;
recover the approved contents from the reviewed commit or from a retained copy
of the artifact. And it says nothing about what already ran.

## Rollback to a previously approved artifact

When the artifact and its record are committed together, a previous approved
state is a previous commit. Find it, restore both together, then verify:

```sh
git log --oneline -- .sigildex/approvals/<name>.lock.json
git checkout <known-good-commit> -- .claude/skills/<name> .sigildex/approvals/<name>.lock.json
sigildex check .claude/skills/<name> --against .sigildex/approvals/<name>.lock.json
```

Exit `0`. Restoring one without the other produces exit `2` and a failing CI
gate, which is the intended behavior. A rollback is an install: it needs the
human's explicit yes (hard boundary 1). If the pair is not under Git — a
user-level directory such as `~/.claude/skills`, or an uncommitted pair —
there is no history to restore; treat the previous version as a new candidate
and take it through review.

## Discarding a rejected update

If review rejects an update, delete the quarantined copy. The active
installation was never modified and its record still matches:

```sh
rm -rf ~/skill-review/<name>-next
sigildex check .claude/skills/<name> --against .sigildex/approvals/<name>.lock.json
```

Exit `0`.
