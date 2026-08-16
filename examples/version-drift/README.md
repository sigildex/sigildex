# Worked example: approving a skill, then noticing it changed

This directory is a complete, runnable walkthrough of the approval lifecycle:
adopt a skill, verify the installed copy, detect that a new version drifted from
what was approved, review exactly what changed, and re-approve deliberately.

Everything here is synthetic: the `log-summarizer` skill, its reference doc, and
its script were written for this repository as example content. They are not
copied from, and do not describe, any real published skill.

## What is in here

| Path | What it is |
|---|---|
| `skill-v1/` | The skill as first reviewed: `SKILL.md` plus one reference doc. No scripts. |
| `skill-v2/` | The same skill, updated: `SKILL.md` instructions changed, and a new executable `scripts/summarize.sh` added. |
| `approvals/` | The approval records (locks) for each version. |
| `generate-locks.mjs` | Regenerates both locks from the trees above, with a pinned `created_at` so the committed files are byte-stable. |
| `verify-example.mjs` | Asserts every claim on this page against the library. Run it after changing anything here. |

The two versions sit side by side so both states can be inspected at once. A
real project holds **one** lock per artifact, at
`.sigildex/approvals/<approval-id>.lock.json`; re-approval replaces that file in
place rather than adding a second one.

## Running the commands

Commands below are written for the installed CLI and are run from this
directory:

```sh
cd examples/version-drift
```

If you are working inside a clone rather than from an installed package, build
the repository first (`npm run build` at the root) and substitute
`node ../../dist/cli/index.js` for `sigildex` in every command.

Exit codes are the contract, and each one below is asserted by
`verify-example.mjs`: `0` match, `2` drift, `1` tool or filesystem error,
`3` invalid or unsupported approval record.

## 1. Adoption — record what you reviewed

You have staged the candidate somewhere no agent loads it, read `SKILL.md`,
read the reference doc, and decided to adopt it. Record that decision:

```sh
sigildex lock skill-v1 \
  --approval-id log-summarizer-v1 \
  --out approvals/log-summarizer-v1.lock.json
```

Exit `0`. The record lists every in-scope file with its SHA-256, size, and
executable bit, plus a root digest over that manifest.

The output filename is not free-form: it must be `<approval-id>.lock.json`, so a
record and its id can never disagree about which approval it is. A mismatch is
refused before anything is walked:

```sh
sigildex lock skill-v1 --approval-id log-summarizer-v1 --out approvals/v1.lock.json
```

Exit `1`, no file written — the expected name is `log-summarizer-v1.lock.json`.

The lock is also refused if you try to write it inside the tree it measures — an
approval record can never end up inside its own manifest:

```sh
sigildex lock skill-v1 --approval-id log-summarizer-self --out skill-v1/log-summarizer-self.lock.json
```

Exit `1`, no file written.

## 2. Install and verify — is the installed copy the reviewed copy?

After moving the artifact out of quarantine into the place your agent loads it,
verify before anything runs:

```sh
sigildex check skill-v1 --against approvals/log-summarizer-v1.lock.json
```

Exit `0`. This binds the artifact's bytes at the moment of the check only. It
says nothing about whether the skill is safe, and nothing about what the bytes
will be later — re-check immediately before activation if that matters to you.

## 3. Drift — the upstream skill moved

`skill-v2/` is what a later upstream release looks like. The approval you hold
is still the v1 record:

```sh
sigildex check skill-v2 --against approvals/log-summarizer-v1.lock.json
```

Exit `2`. The report names:

- **added** — `scripts/summarize.sh`
- **modified** — `SKILL.md`

Nothing was removed and no executable bit flipped on an already-approved file.
Drift is a fact, not a judgement: the tool will not tell you whether the change
is fine. That is step 4.

## 4. Review — what actually changed

```sh
sigildex diff skill-v1 skill-v2
```

Exit `2` (both trees walked cleanly; they differ). Every differing path lands in
exactly one category:

- **added** — `scripts/summarize.sh`, class `script`, executable
- **removed** — nothing
- **changed** — `SKILL.md`, `content_changed: true`, `mode_changed: false`

`reference/log-formats.md` is byte-identical in both versions, so it appears
nowhere in the report.

That is the whole review surface: the update introduces an executable script
where the approved version had none, and rewrites the instructions to call it.
Read the new script and the instruction change before going further —
`sigildex diff --json` gives you the same facts in a stable structure if you
want to attach them to a review.

## 5. Re-approval — approve the new state deliberately

Only after a human has read the change:

```sh
sigildex lock skill-v2 \
  --approval-id log-summarizer-v2 \
  --out approvals/log-summarizer-v2.lock.json

sigildex check skill-v2 --against approvals/log-summarizer-v2.lock.json
```

Exit `0`. Rolling back is symmetrical — checking the old tree against the new
record is drift too, with `scripts/summarize.sh` reported as **removed**:

```sh
sigildex check skill-v1 --against approvals/log-summarizer-v2.lock.json
```

Exit `2`.

## 6. A change to the lock alone

Metadata inside a record is not identity. Copy the v2 lock, change its
`created_at`, and it still matches its tree:

```sh
cp approvals/log-summarizer-v2.lock.json /tmp/edited.lock.json
# edit "created_at" in /tmp/edited.lock.json
sigildex check skill-v2 --against /tmp/edited.lock.json
```

Exit `0` — a **technical pass**. The same holds for `tool_version`, `class`
values, `skill.*`, and `declared_source`: none of them is drift.

This is the case tooling cannot decide for you. A pull request that touches only
an approval record passes the consistency check and still deserves human review,
which is why approval files belong under CODEOWNERS (see [../../docs/ci](../../docs/ci)).

Editing the *manifest* is different. Change one `sha256` and the record no longer
agrees with its own root digest:

```sh
cp approvals/log-summarizer-v2.lock.json /tmp/tampered.lock.json
# change one character of one "sha256" value in /tmp/tampered.lock.json
sigildex check skill-v2 --against /tmp/tampered.lock.json
```

Exit `3` — invalid record. A hand-edited or corrupted lock is refused, never
compared and never reported as a match.

## 7. Removal

Retiring a skill means deleting the artifact **and** its approval record in the
same change. Half of that is a broken state, and each half fails on its own:

```sh
cp -R skill-v2 /tmp/log-summarizer
cp approvals/log-summarizer-v2.lock.json /tmp/log-summarizer.lock.json

rm -rf /tmp/log-summarizer
sigildex check /tmp/log-summarizer --against /tmp/log-summarizer.lock.json
```

Exit `1` — the record's artifact is gone, so there is no verdict to give. The
mirror case, an artifact left behind with its approval deleted, also exits `1`
(the lock cannot be acquired) and is what CI must catch as an unapproved skill.
The workflow in [../../docs/ci](../../docs/ci) fails closed on both partial
states and passes only when the artifact and its record move together.

## Verifying this example

```sh
npm run build            # at the repository root
node examples/version-drift/verify-example.mjs
```

It prints one `PASS` line per claim made above and exits non-zero if any of them
stops holding. If you edit the skill trees, regenerate the records first:

```sh
node examples/version-drift/generate-locks.mjs
```
