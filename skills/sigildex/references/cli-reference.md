# CLI reference

Flag rules, JSON shapes, and a Node fallback for the reducer. The normative
contract is `docs/identity-spec.md` in the repository; this file restates what
an agent needs at the keyboard.

## Exit codes

`0` success, match, or identical · `2` drift detected, or the two directories
differ (a completed run) · `1` tool, input, filesystem, or walk error · `3`
unsupported or invalid approval record. `1` and `3` are not verdicts and are not
a match. Shell `127` (not on PATH) and `126` (found, not executable) mean the
tool did not run.

## `sigildex lock <skill-path> --out <lock-path>`

Every flag is validated before anything is walked or written; a violation exits
`1` naming the flag and the rule.

- `--out <lock-path>` — required. The filename must be exactly
  `<approval-id>.lock.json`; the parent directory must already exist (`lock`
  creates no directories); the path may not lie inside the directory being
  measured. `.sigildex/approvals/<approval-id>.lock.json` is the convention.
- `--approval-id <id>` — `[a-z0-9][a-z0-9-]{0,63}`. Defaults to a value derived
  from the skill directory's name; when that derived value would not match the
  grammar, `lock` exits `1` and asks for the flag. Pass it explicitly when
  locking a staging directory, so the id does not depend on what that
  directory happens to be called.
- `--artifact-path <path>` — the project-relative location the artifact will
  occupy. Defaults to the skill path relative to the current directory, so a
  `<skill-path>` that lies outside the current directory *as typed* exits `1`
  without this flag. The rule reads the path as written, not what it resolves
  to: a symlink inside the project counts as inside, so pass the flag
  explicitly when staging through a link.
- `--source-kind <kind>` — 1 to 32 characters of `[a-z0-9-]`; a free-form label
  (`git`, `registry`, `local`, …) recorded as written, never interpreted.
- `--source-repository <url>` — at most 512 UTF-8 bytes.
- `--source-path <path>` — a relative POSIX path with no `.` or `..` component,
  or the literal `.`.
- `--source-commit <hex>` — 7 to 64 lowercase hexadecimal characters.
- `--source-tracking <policy>` — at most 128 UTF-8 bytes; a free-form label,
  not an enumeration.

The five `--source-*` flags are optional and any subset is valid. Together they
write `declared_source`, which sits outside the identity digest and always
carries `verification: "user_supplied"` — set by the tool, never by a flag.
Omitting all five omits the field. `declared_source` is never hand-edited into a
record; to add or change it, re-lock. Re-locking rewrites the record from the
artifact's current bytes, so re-lock only when `check` already exits `0`.

## `sigildex check <skill-path> --against <lock-path>`

Compares the tree at `<skill-path>` with the record. Exit `0` prints
`Match: the artifact matches approval record <id>.` plus the file count; exit
`2` prints `Drift: the artifact no longer matches the approval record (n added,
n removed, n modified, n mode-changed).` and lists each path with its class.
Read the file count: an empty-manifest record matches any tree that is empty in
scope. `.git` and `.sigildex` are excluded at any depth; empty directories do
not affect identity. `check` reads whatever record `--against` names and does
not verify that the filename matches its `approval_id`; that rule is enforced
only when `lock` writes, so store naming is a review responsibility.

## `sigildex diff <base-path> <candidate-path>`

Compares two trees. Exit `0` identical, `2` differ, `1` a walk failed. Reports
`added`, `removed`, and `changed`; each `changed` entry carries independent
`content_changed` and `mode_changed` booleans. Frontmatter differences are
informational and never part of identity.

## What `--json` prints

Three documents. Branch on the exit code before parsing.

- **Approval record** — `lock` (exit `0`) and `check` on a match (exit `0`):
  `schema_version`, `spec_version`, `tool_version`, `approval_id`,
  `artifact_path`, `root_digest`, `files[]` (`path`, `sha256`, `size`,
  `executable`, `class`), `skill` (`frontmatter`, `frontmatter_status`),
  `created_at`, `limitations`, and `declared_source` when recorded.
- **Drift report** — `check` on drift (exit `2`): `added`, `removed`,
  `modified`, `mode_changed`, `expected_root_digest`, `actual_root_digest`.
  `added` entries carry `actual`, `removed` entries carry `expected`,
  `modified` and `mode_changed` entries carry both. No `schema_version` field,
  and no frontmatter.
- **Diff report** — `diff`: `schema_version`, `base`, `candidate` (each with
  `root_digest` and `skill`), `added`, `removed`, `changed`.

Candidate frontmatter rides verbatim under `skill.frontmatter` (approval
record) and `base.skill.frontmatter` / `candidate.skill.frontmatter` (diff
report). Strip it before reading; `frontmatter_status` is the tool's own
verdict and can stay.

## Reducer without `jq`

Capture the exit code first, then reduce with Node alone:

```sh
out=$(sigildex diff BASE CAND --json); code=$?
printf '%s\n' "$out" | node -e '
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c)).on("end", () => {
  const strip = (v) =>
    Array.isArray(v) ? v.map(strip)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "frontmatter").map(([k, x]) => [k, strip(x)]))
      : v;
  process.stdout.write(JSON.stringify(strip(JSON.parse(chunks.join(""))), null, 2) + "\n");
});
'
```

Both reducers work on all three documents. Stripping frontmatter reduces
exposure; it is not a security boundary, and it says nothing about the file
contents, which you are not reading either way.
