# Sigildex artifact identity specification

**Spec version: 1** · Status: **LOCKED (2026-08-14)** — normative

**Amendments to spec version 1** (editorial and clarifying only; no change to
`schema_version`, the digest construction, or any record grammar):

- §9.3 — the four approval-store invariants are restated explicitly, and the
  section now says which of them the shipped tool enforces and which remain the
  project's responsibility.
- §9.4 — records that `declared_source` is settable at write time, and names
  the flags that do it.

This document defines how Sigildex computes the content identity of an Agent
Skill directory. It is the normative contract for the `lock`, `check`, and
`diff` commands and for the approval-record schema. Implementation follows this
specification; where implementation and specification disagree, the
specification wins and the implementation is defective.

A second reader must be able to implement an interoperable tool from this
document alone. Every constant, rule, and failure behavior is stated
explicitly; nothing is left to implementation discretion unless marked
*implementation-defined*.

---

## 1. Scope and non-goals

**In scope:** deterministic byte-level identity for a single local skill
directory — which files are included, how each file is hashed, how paths are
recorded, how the per-file records are canonically serialized, and how the
single **root digest** is derived.

**Non-goals.** This specification does not define: safety or risk assessment
of any kind; provenance verification (a lock records what was present, not
where it truly came from); network, registry, archive, or Git-reference
inputs; signatures or attestation. A matching digest means "these exact bytes
were approved" — never "these bytes are safe."

## 2. Definitions

- **Skill root** — the directory passed to the tool, after resolving the
  supplied path with `realpath` semantics (all symlinks in the *supplied path
  itself* are resolved before the walk begins). The skill root must be a
  directory; anything else is a tool error.
- **Artifact** — the set of in-scope regular files under the skill root,
  together with their recorded paths, sizes, executable bits, and SHA-256
  digests.
- **Manifest** — the ordered list of per-file records (§7).
- **Root digest** — the single SHA-256 that identifies the artifact (§8).
- **Lock (approval record)** — the JSON document produced by `lock`,
  containing the manifest, the root digest, and metadata (§9).

## 3. File scope

### 3.1 Inclusion

Walk the skill root recursively. **Every regular file is in scope**, including:

- binary files (hashed even though they cannot be parsed);
- hidden files (dotfiles);
- platform metadata files such as `.DS_Store` (deliberately **not** excluded:
  identity covers every byte that ships in the directory; authors should clean
  their trees rather than rely on the tool to ignore junk);
- files with no extension, unusual extensions, or unknown types — file *type*
  never affects inclusion, only classification (§7.3).

Empty directories are not represented in the artifact. Two trees that differ
only by empty directories have the same identity; this is a documented
limitation.

### 3.2 Exclusions (closed list)

Exactly two names are excluded, at any depth:

1. Any directory entry named exactly `.git` (whether a directory or a file —
   Git worktrees and submodules use a `.git` *file*). Excluded entries are
   pruned: nothing beneath an excluded directory is walked.
2. Any directory entry named exactly `.sigildex` (the tool's own metadata
   directory), pruned the same way.

**Exclusion never precedes type validation.** Every directory entry —
including entries with excluded names — is first `lstat`-validated per §5. A
symlink or special file named `.git` or `.sigildex` **fails closed** under §5;
it is not silently pruned. Only a verified regular directory or regular file
with an excluded name is excluded. (Two conforming implementations must never
disagree on whether an excluded-name symlink is an error: it is.) Excluded
entries still count toward the traversal-entry limit (§11) and still
participate in the §4.3 collision comparison.

There is no other exclusion, no ignore-file support, and no user-configurable
exclusion in spec version 1. Adding any exclusion is a spec-version change.

### 3.3 Lock self-inclusion is prevented, not excluded

The tool **refuses to write its output inside the tree it is walking**: if the
resolved output path of the lock being generated is equal to or beneath the
skill root, the command fails closed (exit 1) before walking. Consequently a
"generated output lock" can never appear in its own manifest. A *pre-existing*
file that happens to look like a lock inside the skill root is an ordinary
file: included and hashed.

## 4. Path rules

### 4.1 Recorded form

Every file is recorded by its path **relative to the skill root** in POSIX
form:

- separator is `/` (recorded paths never contain a platform-specific
  separator);
- no leading `/`, no leading `./`, no trailing `/`;
- no `.` or `..` components;
- no empty components (no `//`);
- the path is the exact byte sequence of each directory-entry name as returned
  by the operating system, joined with `/` — the tool never renames,
  case-folds, or Unicode-normalizes a recorded path.

### 4.2 Rejected names (fail closed, exit 1)

The walk fails closed if any directory-entry name:

1. is not valid UTF-8;
2. contains any byte in the range `0x00`–`0x1F`, or `0x7F` (control
   characters — this closes terminal-injection and line-based serialization
   ambiguity in one rule: newline, carriage return, escape, and NUL can never
   appear in a recorded path);
3. is longer than 255 bytes (UTF-8 encoded);
4. contains any code point **unassigned in Unicode 15.1** (checked against
   the shipped assigned-ranges table, §4.3). This pins the §4.3 equivalence
   key's domain: within the accepted domain, Unicode's stability policies
   make the key reproducible across runtime Unicode versions; outside it,
   they would not, so such names are refused rather than ambiguously
   compared.

Absolute paths and traversal cannot arise from a directory walk of a resolved
root, but implementations MUST still validate every recorded path against
§4.1 before serialization and fail closed on violation (defense in depth
against walker bugs).

### 4.3 Ambiguity collision rule (fail closed, exit 1)

Define the **equivalence key** of a directory-entry name as:

```
key(name) = scf(NFC(name))
```

where `NFC` is Unicode Normalization Form C and `scf` is **Unicode simple
case folding** (the context-free, one-to-one `C` + `S` mappings of
`CaseFolding.txt`), both per **Unicode 15.1**. The domain is restricted by
§4.2 rule 4: every code point in an accepted name is assigned in
Unicode 15.1. Within that domain the computation is version-stable by
Unicode's published stability policies — canonical normalization of strings
containing only assigned characters is stable across versions, and case
folding, once assigned, does not change (this is why simple case folding is
used here rather than lowercase mapping, which carries no such guarantee).
Two artifacts ship with the implementation as generated, committed tables:
the assigned-as-of-15.1 ranges (§4.2 rule 4) and the 15.1 simple
case-folding map. A conforming key computation is therefore reproducible
from this paragraph plus those published tables: same names in, same keys
out, on every conforming implementation, on any runtime.

The rule is applied **per directory, to every entry in that directory** —
including excluded-name entries (§3.2) before pruning, and including
directories: if any two distinct entry names in the same directory have equal
equivalence keys, fail closed with both names named. Applying the rule at
every level catches colliding *ancestors* (`A/x` vs `a/y` collide at the
`A`/`a` level even though the full paths differ after folding).

Additionally, after the walk, any two byte-identical recorded paths are a
tool defect: fail closed.

Rationale: colliding trees materialize differently on case-insensitive or
normalization-insensitive filesystems (macOS APFS defaults) versus
case-sensitive ones (Linux ext4). An artifact whose identity depends on which
filesystem reads it is not portable, so it is rejected everywhere. The
equivalence key deliberately **over-rejects**: it is a portability guard, not
an identity input, and rejecting a tree that one filesystem could have
tolerated is the fail-closed direction. It is not claimed to reproduce any
particular filesystem's exact equivalence relation (APFS case-insensitivity
is defined against a fixed Unicode 9.0 table; exotic pairs that APFS folds
but this key does not remain a documented limitation — such trees fail at
materialization on APFS rather than producing a wrong identity here).

Filenames are otherwise recorded as exact bytes. A tree authored with
non-NFC filenames keeps those bytes through Git (which preserves path bytes),
so its identity is stable; authors are nevertheless advised to use ASCII
filenames. This is a documented limitation, not a normalization step.

## 5. Symlinks and special files

1. **Any symlink** encountered anywhere under the skill root — whether it
   points inside the tree, outside it, at a file, at a directory, or at
   nothing — causes the command to **fail closed (exit 1)** with the symlink's
   recorded path named. Symlinks are never followed and never recorded. There
   is no opt-out in spec version 1.
2. **Any non-regular, non-directory entry** (FIFO, socket, device, or any
   unknown type) fails closed the same way.
3. The **skill root itself** may be reached via symlinks (they are resolved
   per §2 before the walk); only entries *under* the root are subject to rule 1.
4. Hard links are undetectable byte-duplicates and are treated as ordinary
   regular files.

## 6. Hashing and read discipline

### 6.1 Per-file digest

The per-file digest is **SHA-256 over the raw bytes of the file** — no
newline normalization, no BOM stripping, no transcoding, no preprocessing of
any kind. The recorded form is lowercase hex.

**Interoperability requirement:** for every file, the recorded digest MUST
equal the output of `sha256sum <file>` (GNU coreutils) and
`shasum -a 256 <file>` (macOS) on the same bytes. This is a deliberate design
choice: byte identity is what a harness reads and executes, and it lets any
party verify a single file with standard tools.

### 6.2 Read discipline and the two-pass stability protocol (TOCTOU)

Implementations MUST NOT hash via a path-based convenience read alone. The
walk is a **snapshot-verify protocol** with two passes over the tree.

**Pass 1 — enumerate and hash.** Depth-first from the skill root:

1. For every directory (the root included): `lstat` it, record its
   `(dev, inode)`, and record the complete sorted list of its entry names
   (excluded names included).
2. For every entry: `lstat`; symlinks and special files → §5 fail-closed.
3. For every in-scope regular file:
   a. open **without following symlinks** (`O_NOFOLLOW` where the platform
      provides it — both supported platforms do);
   b. `fstat` the open descriptor; verify it is still a regular file and its
      `(dev, inode)` matches the `lstat` result — mismatch → fail closed;
   c. stream the file through SHA-256 from the descriptor, subject to the
      §11 byte caps;
   d. record `(dev, inode, size, mtime, ctime)` from the `fstat`, and the
      byte count actually hashed. Hashed-byte count ≠ `fstat` size → fail
      closed.

**Pass 2 — re-verify.** After pass 1 completes (and for `lock`, before any
output is written):

1. For every recorded directory, perform the three observations
   **consecutively, in this order**: re-`lstat` (its `(dev, inode)` must be
   unchanged and it must still be a directory), re-enumerate (the sorted
   entry-name list must be byte-identical to pass 1 — this catches files
   **added** after their parent was enumerated, which no per-file check can
   see), then re-`lstat` **again** (same requirement). The closing `lstat`
   ensures a directory swapped in just before the enumeration cannot present
   its listing and vanish unobserved: a swap surviving to the closing
   `lstat` fails; a swap reverted before it must have presented the same
   names to be undetected, and can only have substituted content by changing
   some file's identity tuple — which that file's own final verification
   (step 2) detects.
2. Re-`lstat` every hashed file: it must still be a regular file and its
   `(dev, inode, size, mtime, ctime)` must all be unchanged from the pass-1
   `fstat` (ctime moves on a same-size in-place rewrite or metadata change
   and cannot be suppressed by an unprivileged writer; see the guarantee
   statement below for the granularity-bounded exception).

Any pass-2 mismatch means the filesystem mutated during the walk: **fail
closed (exit 1)**, naming the first mismatched path. Any read error
(permissions, I/O error, disappearance) at any step of either pass is a tool
error: **fail closed (exit 1)**. There is no skip-and-continue mode.

**What this protocol guarantees — and what it cannot.** Each individual
observation — a directory's opening `lstat`, its enumeration, its closing
`lstat`, a file's re-`lstat` — has its own **final verification time**: the
moment that observation is last performed. The protocol's claims are made
per observation, never for the tree atomically. The guarantee is exactly
this:

- A **quiescent tree** produces a correct identity.
- Any mutation whose effects are still observable at the relevant
  observation's final verification time produces **exit 1** — this covers
  deletions, additions visible at the parent's pass-2 re-enumeration,
  renames, type changes, ancestor-directory swaps that survive to the
  closing directory `lstat`, and any rewrite that changes size, inode, or
  the ctime/mtime tuple.
- A mutation initiated **after** the relevant observation's final
  verification time is outside the measurement window and escapes that
  observation — it is equivalent to a mutation after the tool returns. In
  particular, a directory swap performed after a directory's closing
  `lstat`, or one reverted before it while presenting an identical name
  list, escapes *structural* detection; such a swap can only alter approved
  content by changing some file's identity tuple, which that file's own
  final verification detects on the normative floor.
- Timestamp comparison is performed at the platform's full stored resolution
  (nanosecond fields on both supported platforms). A same-size, same-inode
  rewrite is detected via ctime, which an unprivileged writer cannot
  suppress; a rewrite falling within the filesystem's timestamp granularity
  *and* racing the verification instant is theoretically undetectable
  without rehashing. Implementations MAY additionally rehash during pass 2
  to narrow this window; the tuple comparison is the normative floor.

No userspace scan on a live POSIX filesystem can provide a globally atomic
snapshot; this protocol minimizes and bounds the race window and never
*widens* an error into a match. Consumers who need stronger assurance MUST
use the copy-then-verify pattern: copy the artifact to a location the
consumer exclusively controls, run `check` against the copy, and execute
only the verified copy (§15). Standard portable runtimes (including Node.js)
lack `openat`-anchored traversal; the per-file `O_NOFOLLOW` + `fstat`
identity check defeats final-component symlink swaps, and pass 2 detects
persisting ancestor swaps. What no scan can provide is a binding on bytes
*after* the tool returns — a `check` exit 0 says the artifact matched during
the verified window, not that it cannot change next (§15).

### 6.3 Executable bit

The manifest records one boolean per file: whether any execute bit
(`S_IXUSR | S_IXGRP | S_IXOTH`) is set. The executable bit is **part of
identity** (§8): flipping it changes whether a script runs, so it must be
drift. No other mode bits, ownership, or timestamps participate in identity.

## 7. The manifest

### 7.1 Per-file record

For each in-scope file: `path` (§4), `sha256` (lowercase hex, §6.1), `size`
(bytes, decimal, §6.2), `executable` (boolean, §6.3), `class` (§7.3).

### 7.2 Ordering

Manifest entries are sorted by `path`, compared as **byte-wise lexicographic
order of the UTF-8 path bytes** (i.e. `memcmp` order). Never locale collation,
never case-insensitive. This ordering is used everywhere the manifest is
serialized, including the root-digest input and the lock JSON.

### 7.3 File classification (informational only)

Each file gets one `class`, derived **solely from its recorded path** (never
from content), by first match in this order:

| Order | Rule (case-insensitive match on path) | Class |
|---|---|---|
| 1 | exactly `SKILL.md` at the root | `instructions` |
| 2 | basename ends `.md`, `.mdx`, or `.txt` | `reference` |
| 3 | basename ends `.sh`, `.bash`, `.zsh`, `.py`, `.rb`, `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, `.pl`, `.ps1` — or `executable` is true | `script` |
| 4 | basename ends `.json`, `.yaml`, `.yml`, `.toml`, `.ini`, `.cfg`, `.conf`, or basename is `Makefile`, `Dockerfile` | `config` |
| 5 | basename ends `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`, `.ico`, `.pdf`, `.woff`, `.woff2` | `asset` |
| 6 | anything else | `other` |

Classification exists for human-facing reporting (`diff` grouping, review
prompts). It is **excluded from the root digest** so a future classification
improvement cannot change any artifact's identity. Two locks of the same tree
by different tool versions may therefore disagree on `class` while agreeing on
identity; `check` MUST NOT report a classification difference as drift.

## 8. Canonical serialization and the root digest

### 8.1 Canonical manifest line

For each file, in manifest order (§7.2), form one line:

```
<sha256-hex> <size-decimal> <x-flag> <path>\n
```

- `<sha256-hex>` — 64 lowercase hex characters;
- `<size-decimal>` — the size in bytes, base 10, no leading zeros (`0` for an
  empty file);
- `<x-flag>` — the single character `x` if `executable` is true, else `-`;
- `<path>` — the recorded path bytes (§4 guarantees no control characters, so
  the line form is unambiguous);
- separators are single ASCII spaces (`0x20`); terminator is a single LF
  (`0x0A`). No CR, no trailing padding.

### 8.2 Root digest

The root digest is SHA-256 over the UTF-8 bytes of:

```
sigildex-root-digest-v1\n
<canonical manifest line 1>
<canonical manifest line 2>
...
```

— that is, the fixed domain-separation header line followed by every
canonical manifest line in manifest order. The recorded form is
`sha256:<64 lowercase hex>`.

The root digest input includes **every in-scope file** (§3.1) — an artifact
with any file added, removed, renamed, resized, edited, or exec-flipped has a
different root digest. It includes exactly: path, size, executable flag, and
per-file SHA-256. It excludes: classification, frontmatter fields, timestamps,
tool version, and `declared_source` — those may change or be re-derived
without changing what the artifact *is*.

### 8.3 Independent reproduction

Any party can reproduce the root digest of a symlink-free, quiescent tree
with standard tools (subject to the same scope rules). On Linux
(GNU coreutils):

```sh
cd <skill-root>
find . \( -name .git -o -name .sigildex \) -prune -o -type f -print \
  | LC_ALL=C sort \
  | while IFS= read -r p; do
      rel=${p#./}
      h=$(sha256sum < "$p" | cut -d' ' -f1)
      s=$(wc -c < "$p" | tr -d ' ')
      m=$(stat -c '%a' "$p"); m=$(printf '%03d' "$m" | tail -c 3)
      case $m in *[1357]*) x=x;; *) x=-;; esac
      printf '%s %s %s %s\n' "$h" "$s" "$x" "$rel"
    done \
  | { printf 'sigildex-root-digest-v1\n'; cat; } | sha256sum
```

On macOS, replace both `sha256sum` invocations with `shasum -a 256` and the
`stat` invocation with `m=$(stat -f '%Lp' "$p")`. Notes on correctness of the
recipe itself: every path handed to a command keeps its `./` prefix and file
contents are read via stdin redirection, so filenames that look like options
(`--help`) cannot be misparsed; sorting happens on the
uniformly-`./`-prefixed list, which orders identically to sorting the
stripped recorded paths; `LC_ALL=C sort` gives byte-wise ordering; the
executable flag is derived from the file's **mode bits** (`mode & 0111 ≠ 0` —
any of the low three octal digits odd), never from `[ -x ]`, which tests the
*current user's* execute permission and would make the digest depend on
verifier credentials (§6.3 defines identity by mode bits alone; setuid/
setgid/sticky digits above the low three are ignored, which the
`tail -c 3` masking guarantees for the GNU variant). The recipe is
illustrative and omits the fail-closed checks a conforming implementation
must perform (§4.2, §4.3, §5, §6.2, §11) — it reproduces the digest of an
already-accepted tree; it does not decide acceptance.

### 8.4 Determinism requirement

Two runs over byte-identical trees MUST produce byte-identical manifests,
canonical serializations, and root digests — across runs, across supported
platforms, and across conforming implementations. Anything observable that
varies (walk order, hash chunking, parallelism) must be normalized away by
the sorting and serialization rules above.

## 9. The lock (approval record)

### 9.1 Contents

A lock is a single UTF-8 JSON document (no BOM). The top-level value is a
JSON object with **exactly** these keys, all required unless marked optional,
serialized in exactly this order:

| # | Field | Type | Role | Meaning |
|---|---|---|---|---|
| 1 | `schema_version` | integer `1` | version gate | The approval-record schema version |
| 2 | `spec_version` | integer `1` | version gate | The version of this specification |
| 3 | `tool_version` | string | metadata | Version of the CLI that wrote the lock |
| 4 | `approval_id` | string | metadata | Stable ID; grammar `[a-z0-9][a-z0-9-]{0,63}` |
| 5 | `artifact_path` | string | metadata | Project-relative POSIX path of the skill root (§9.3); never absolute, subject to §4.1 form |
| 6 | `root_digest` | string | **identity (derived)** | `sha256:<64 lowercase hex>`, derived from `files[]` per §8.2 — never an independent input |
| 7 | `files` | array | **identity (input)** | The manifest (§7): objects with exactly `path`, `sha256`, `size`, `executable`, `class`, in manifest order (§7.2) |
| 8 | `skill` | object | metadata | Parsed `SKILL.md` identity (§10); closed shape below |
| 9 | `created_at` | string | metadata | UTC timestamp, exact grammar below; explicitly outside identity |
| 10 | `declared_source` | object, optional | metadata | User-supplied, unverified update-check hint (§9.4); closed shape below |
| 11 | `limitations` | string | metadata | The exact normative literal below |

**Nested shapes (all closed — unknown keys invalid at every level except
inside `skill.frontmatter`):**

- `files[]` entries: exactly `path`, `sha256`, `size`, `executable`, `class`.
- `skill`: exactly two keys — `frontmatter_status` (one of `"ok"`,
  `"missing"`, `"invalid"`) and `frontmatter` (`null` unless status is
  `"ok"`; when `"ok"`, a JSON object holding the parsed YAML mapping
  restricted to JSON-representable values). `skill.frontmatter` is the one
  deliberately **open** object in the record: it is data captured from the
  artifact, not schema-controlled, and it is metadata — never identity.
- `declared_source` (when present): keys drawn from exactly `kind` (string,
  `[a-z0-9-]{1,32}`), `repository` (string, ≤ 512 **UTF-8 bytes**), `path`
  (string satisfying §4.1 form, or `"."`), `approved_commit` (string,
  `[0-9a-f]{7,64}`), `tracking_policy` (string, ≤ 128 **UTF-8 bytes**), and
  the required literal `verification: "user_supplied"`. All but
  `verification` optional. (All string-length limits in this section are
  measured in UTF-8 bytes of the decoded string value, never UTF-16 code
  units or code points.)
- `created_at` — validity is **exactly** a match of
  `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$`. No calendar,
  range, or leap-second semantics are validated: the field is
  non-identity metadata, and regex-only validation is chosen precisely so
  that two implementations can never disagree about a lock's validity over
  a date quirk. Writers MUST emit a real RFC 3339 UTC instant; validators
  check only the shape.
- `tool_version` grammar: `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`.
- `artifact_path`: a §4.1-form relative path, or the literal `"."` when the
  skill root is the project root.
- `limitations` is the exact literal (validation is byte equality against
  the single line inside this code fence, excluding the fence itself):

  ```
  This record attests the byte identity of the listed files at lock time only. It does not attest safety, provenance, or future content.
  ```

Unknown keys anywhere outside `skill.frontmatter` are invalid. "Identity"
fields determine what artifact the lock identifies; metadata fields can
differ between two locks that identify the same artifact. `root_digest` is
**derived** from `files[]` by the §8.2 construction — a lock where the two
disagree is internally inconsistent and invalid (§9.5).

The published `schema/approval-record.schema.json` is generated from this
table and MUST match it; where they disagree, this specification wins.

### 9.2 Serialization stability

Lock JSON is written deterministically: the §9.1 key order, 2-space
indentation, LF line endings, trailing LF, no non-ASCII escapes beyond what
JSON requires. Locking the same tree twice yields byte-identical files except
for `created_at` and, across versions, `tool_version`. Consumers MUST treat
JSON formatting as non-normative — the digest rules (§8) are defined over the
canonical manifest lines, never over the JSON bytes.

### 9.3 Identity and layout rules for stored approvals

When approvals are stored in a project (recommended layout
`.sigildex/approvals/<approval-id>.lock.json`), the following are normative
invariants of the approval store:

1. **Filename/ID agreement** — the filename derives from and must match the
   `approval_id` (`<approval_id>.lock.json`). This holds wherever the record is
   written, not only under `.sigildex/approvals/`.
2. **One artifact per lock** — each lock maps to exactly one normalized
   project-relative artifact path (§4.1 form, or `"."`).
3. **Store uniqueness** — approval IDs are unique across the store, and so are
   artifact paths: two records must not claim the same ID or the same artifact.
4. **No half states** — a lock whose artifact is missing, and an artifact with
   no lock, are both broken states.

**What enforces each invariant in this version.** Invariant 1 is enforced by
the tool: `lock` refuses to write a record whose output filename is not
`<approval_id>.lock.json`, and it refuses before walking, so a misnamed
destination produces exit 1 and no file. Invariant 2 is enforced by the record
grammar (§9.1) and by `lock`'s rejection of a non-§4.1 `artifact_path`.
Invariants 3 and 4 are **not** enforced by anything this version ships: they
are per-pair checkable, and the published CI example checks them for the one
artifact/record pair it is configured with, but **this version does not audit a
directory of approvals for duplicate approval IDs, duplicate artifact paths, or
orphaned locks.** Keeping a multi-skill store free of those conditions is the
project's responsibility — branch protection and human review of the approvals
directory — and it is not proved by any check Sigildex distributes. A
conforming implementation MAY add such an audit; this specification does not
require one, and no consumer should assume one is running.

### 9.4 `declared_source`

Optional orchestration metadata for update checking: `kind`, `repository`,
`path`, `approved_commit`, `tracking_policy`, and a fixed
`verification: "user_supplied"`. It is stored **outside** the root-digest
input, is never verified by the tool, and MUST NOT be described as
provenance. A lock with a tampered `declared_source` still verifies — this is
by design and documented.

A writer MUST provide a way to set these members as part of writing the
record, so that declaring a source never requires hand-editing a lock. In this
implementation that is the `lock` command's `--source-kind`,
`--source-repository`, `--source-path`, `--source-commit`, and
`--source-tracking` flags: giving none omits `declared_source` entirely, giving
any subset records exactly those members, and `verification` is always set by
the writer rather than supplied by the user. Values are validated against the
§9.1 grammars before anything is walked or written, so a record can never be
produced with a `declared_source` the validator would reject.

### 9.5 Lock validation algorithm (`check` step 2; exit 3 on any failure)

Given acquired lock bytes, a conforming implementation MUST validate, in
order — any failure is "invalid approval-record schema", exit 3:

1. **Syntax** — the bytes are valid UTF-8 JSON with a single top-level
   object. **Duplicate keys anywhere in the document are invalid**; because
   common parsers silently keep the last duplicate, implementations MUST
   detect duplicates (e.g. a validating scan) rather than trusting a
   convenience parser.
2. **Versions** — `schema_version` and `spec_version` are integers the
   implementation supports; anything else exits 3 — never a best-effort
   comparison (§14).
3. **Shape** — exactly the §9.1 keys, correct types, no unknown keys at
   top level or in `files[]` entries; field grammars hold (`approval_id`
   pattern, `sha256` = 64 lowercase hex, `root_digest` prefix and length,
   `size` a non-negative integer, `class` one of the §7.3 values, `path`
   satisfying every §4.1/§4.2 rule).
4. **Manifest integrity** — `files[]` paths are unique, in exact §7.2 byte
   order, and free of §4.3 collisions.
5. **Internal consistency** — recompute the §8.2 root digest from `files[]`;
   it MUST equal `root_digest`. A mismatch means the lock was hand-edited or
   corrupted; comparing an artifact against it would be meaningless.

Only a lock passing all five steps may be compared against a walked artifact.
This closes the false-success family where a duplicate-path, unsorted,
digest-inconsistent, or hand-tampered lock produces exit 0 in one
implementation and exit 2 in another.

## 10. `SKILL.md` and frontmatter

1. `lock` requires a regular file named exactly `SKILL.md` at the skill root;
   its absence is a tool error (exit 1) — a directory without `SKILL.md` is
   not an Agent Skill.
2. The file's YAML frontmatter (the first `---` … `---` block, if present) is
   parsed for recording: `name`, `description`, and selection-facing metadata
   are copied into the lock's `skill` object. *(Clarification, 2026-08-14,
   post-lock: `name` and `description` are the scalar-expected fields — a
   non-scalar value for either yields `frontmatter_status: "invalid"`; all
   other frontmatter keys admit any JSON-representable value.)*
3. **Identity never depends on parse success.** The bytes of `SKILL.md` are
   hashed like any file. If frontmatter is absent, malformed, not a YAML map,
   or contains non-scalar values where scalars are expected, the lock records
   `skill.frontmatter: null` plus `skill.frontmatter_status` of `"missing"`
   or `"invalid"` — loudly recorded, never silently dropped, and never a
   reason to fail the lock.
4. Frontmatter parsing MUST be bounded: the parser is given only the bytes of
   the frontmatter block, must reject aliases/anchors expansion beyond a fixed
   small budget, and must not execute or resolve custom tags. Parser failure
   or resource exhaustion → `frontmatter_status: "invalid"`, never a crash.

## 11. Limits (fail closed, exit 1)

| Limit | Value | Counter semantics |
|---|---|---|
| Max in-scope files | 4,096 | incremented as each file enters scope during pass 1; the 4,097th file fails before it is hashed |
| Max traversed directories | 4,096 | every directory entered, root included |
| Max traversed entries | 65,536 | every directory entry examined, excluded and rejected entries included — bounds empty-directory fanout no other counter sees |
| Max single-file bytes | 64 MiB (67,108,864) | checked twice: `lstat`/`fstat` size before reading (over → fail without reading), **and** a hard streaming cap — reading byte 67,108,865 aborts mid-stream |
| Max total in-scope bytes | 256 MiB (268,435,456) | running sum of **actual bytes hashed**; the read that would exceed the cap aborts mid-stream |
| Max directory depth below root | 64 | during walk |
| Max recorded-path length | 1,024 bytes | per file |
| Max name-component length | 255 bytes | per entry (§4.2) |

Every counter is checked **before** the work it bounds is performed, and the
streaming caps bound actual bytes read — a file growing concurrently with the
walk cannot push resource use past the caps (it is caught by the streaming
cap or by the §6.2 pass-2 mismatch, whichever fires first). Exceeding any
limit fails the whole command — there is no truncated or partial lock. The
limits are spec constants: changing any of them is a spec-version change.
(Values are far above any legitimate skill; they bound resource use against
hostile trees.)

## 12. Fail-closed matrix (walker level)

Authoritative behavior table for `lock` and `check`. "Fail" means: no lock is
written (a partially written output must be removed or never made visible,
e.g. write-to-temp + rename), `check` reports no verdict, exit code as shown.

| # | Condition | Behavior | Exit |
|---|---|---|---|
| 1 | Skill root missing, not a directory, or unreadable | fail | 1 |
| 2 | Symlink or special file anywhere under root (§5) | fail, path named | 1 |
| 3 | Unreadable file / read error / permission denied (§6.2) | fail, path named | 1 |
| 4 | Filesystem mutation detected mid-walk or mid-read (§6.2) | fail | 1 |
| 5 | Non-UTF-8, control-character, or over-long name (§4.2) | fail, path named | 1 |
| 6 | NFC/case collision between recorded paths (§4.3) | fail, both named | 1 |
| 7 | Any limit exceeded (§11) | fail, limit named | 1 |
| 8 | `SKILL.md` missing at root (`lock` only, §10.1) | fail | 1 |
| 9 | Lock output path inside the walked tree (§3.3) | fail before walk | 1 |
| 10 | Malformed frontmatter (§10.3) | **proceed**, recorded as `invalid` | — |
| 11a | Lock file missing, unreadable, or I/O error (`check`) | fail, no verdict | 1 |
| 11b | Lock bytes acquired but syntactically or schema-invalid, unsupported version, or internally inconsistent (§9.5) (`check`) | fail, no verdict | 3 |
| 12 | Artifact ≠ lock (any file added/removed/changed/exec-flipped) (`check`) | drift report | 2 |
| 13 | Artifact = lock (`check`) | match | 0 |

Row 10 is the single deliberate non-failure: byte identity is intact, so the
approval decision remains sound; the condition is surfaced, not fatal.

**Exit-code contract (all commands):** `0` success/match · `2` drift detected
· `1` tool, input, filesystem, or walk error · `3` unsupported or invalid
approval-record schema. A tool error and an invalid record MUST never be
reported as a match. Evaluation order for `check` is fixed:

1. **Acquire** the lock bytes — a missing, unreadable, or I/O-failing lock
   path is a filesystem/input error: **exit 1**, without walking.
2. **Validate** the acquired bytes per §9.5 (syntax, schema, versions,
   internal consistency) — failure: **exit 3**, without walking.
3. **Walk** and hash the artifact — any walk failure in this section's
   matrix: **exit 1**, no verdict emitted.
4. **Compare** — exit 0 or 2.

An error encountered during steps 3–4 exits 1, never 2: a run that cannot
complete its walk has no business emitting a drift verdict.

`check` compares: the file set (by recorded path), each file's `sha256`,
`size`, and `executable` flag, and the root digest. Any difference → exit 2
with a per-file report (added / removed / modified / mode-changed).
Differences in `class`, `skill.*`, `created_at`, `tool_version`, or
`declared_source` are **not** drift (§7.3, §8.2).

### 12.1 `diff` command contract

`diff <base-dir> <candidate-dir>` compares two local skill directories. It is
subject to every walker rule in this specification — scope (§3), path rules
(§4), symlink refusal (§5), read discipline (§6.2), limits (§11, applied to
each tree independently) — and to §10's requirement that each input contain a
regular `SKILL.md` at its root.

Evaluation order:

1. Walk the base tree completely; any walk failure → **exit 1** (no report).
2. Walk the candidate tree completely; any walk failure → **exit 1**
   (no report).
3. Compare and report.

Exit codes: `0` — both walks completed and the trees' root digests are equal;
`2` — both walks completed and the trees differ; `1` — either walk failed.
`diff` never exits 3 (no lock is involved). A partial report from one
complete and one failed walk is never emitted.

**Report contract (normative).** Every differing path appears in **exactly
one** of three mutually exclusive categories:

- `added` — present only in the candidate; carries the candidate's `class`;
- `removed` — present only in the base; carries the base's `class`;
- `changed` — present in both with any difference; carries the **candidate's**
  `class` plus two independent booleans, `content_changed` (sha256 or size
  differs) and `mode_changed` (executable flag differs) — a file whose bytes
  and mode both change is one `changed` entry with both booleans true, never
  two entries.

Report ordering is fixed: the three categories in the order above, entries
within each category in §7.2 byte-wise path order. Grouping by `class` is a
presentation choice of the human renderer over these ordered facts; the
underlying report (and the `--json` output) is the flat ordered structure:

```
{ "schema_version": 1,
  "base":      { "root_digest": "sha256:…",
                 "skill": { "frontmatter": …, "frontmatter_status": "…" } },
  "candidate": { "root_digest": "sha256:…",
                 "skill": { "frontmatter": …, "frontmatter_status": "…" } },
  "added":   [ { "path", "class", "sha256", "size", "executable" } … ],
  "removed": [ { "path", "class", "sha256", "size", "executable" } … ],
  "changed": [ { "path", "class", "content_changed", "mode_changed",
                 "base": { "sha256", "size", "executable" },
                 "candidate": { "sha256", "size", "executable" } } … ] }
```

This inline shape is normative and complete — there is no other key; the
JSON Schema published with the implementation must match it (spec wins on
disagreement, as with §9.1). That schema is
`schema/diff-report.schema.json`. The two `skill` objects carry each side's §9.1
skill shape verbatim (object keys serialized in byte-wise sorted order), so
a consumer can compute any frontmatter comparison it wants from exact
inputs; the JSON report itself contains **no** computed frontmatter diff.
A human renderer MAY additionally present a frontmatter comparison derived
from these two objects; that presentation is explicitly non-normative and
carries no interoperability requirement. Report content is a deterministic
function of the two manifests plus the two frontmatter parses; two
conforming implementations produce identical facts in identical order.
Classification skew across tool versions cannot arise within one report
(both sides are classified by the running tool), and class is never drift.

## 13. Platform contract

1. **Supported and CI-tested: macOS and Linux.** The CI matrix runs the full
   test suite, including every fail-closed case in §12, on both.
2. **Windows is explicitly out of scope in v0.1.** On `win32` the CLI exits 1
   with a clear unsupported-platform error before doing any work. Rationale:
   path-separator translation, missing execute bits, and case-insensitive
   NTFS semantics would silently change identity; refusing is the fail-closed
   choice.
3. Filesystem-behavior differences (APFS normalization-insensitivity and
   default case-insensitivity vs ext4 case sensitivity) are **mitigated** by
   §4.3: trees whose names collide under the §4.3 equivalence key are
   rejected on every platform. The key deliberately over-rejects and is not
   an exact model of APFS's Unicode-9.0-based equivalence; residual exotic
   pairs fail at materialization on APFS rather than yielding a wrong
   identity (§4.3 limitation).
4. The tool's output (digests, manifest, lock bytes minus `created_at`) MUST
   be identical for the same tree on both supported platforms; this is a
   CI-asserted property (same fixture tree locked on macOS and Linux produces
   the same root digest).

## 14. Versioning

- **This document** carries the spec version (currently `1`). Any change to
  scope, exclusions, path rules, hashing, canonical serialization, limits, or
  the fail-closed matrix increments it.
- **Locks** carry `spec_version` + `schema_version`. A `check` reading a lock
  with an unsupported `spec_version` or `schema_version` exits 3 — never a
  best-effort comparison.
- The hash algorithm is fixed at SHA-256 for spec version 1; algorithm
  agility, if ever needed, arrives as a new spec version, never as a runtime
  option.

## 15. Security considerations (summary)

The adversarial review of any implementation must cover, at minimum: path
traversal; symlink escape and TOCTOU (§5, §6.2); binary and oversized inputs
(§3.1, §11); newline/Unicode/path-normalization ambiguity (§4.2, §4.3);
canonical-serialization collisions (§8.1 — closed by the control-character
ban and single-line format); lock self-inclusion (§3.3); malformed
frontmatter and parser resource exhaustion (§10); malicious terminal or
Markdown output (control characters cannot enter recorded paths per §4.2;
all other untrusted strings — frontmatter values, `declared_source` — MUST be
sanitized or escaped before terminal/Markdown emission); filesystem mutation
during the walk (§6.2 — same-size in-place overwrites, ancestor-directory
swaps, and late additions after enumeration are all pass-2 detections); and
false-success exit paths (§12 — every error path must be shown to produce a
non-zero, non-2 exit; §9.5 — every internally inconsistent lock must exit 3).

**Point-in-time boundary (restated for consumers).** A successful `check`
binds the artifact's bytes during the verified measurement window only. It
does not and cannot bind what a harness later loads: a consumer that needs
execution-time integrity must re-run `check` immediately before activation or
execute from an immutable copy of the verified artifact. Documentation and
CLI output MUST NOT imply that a past check certifies future content.
