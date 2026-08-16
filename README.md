# Sigildex

> Sigildex does not replace discovery, security scanning, or human review. It connects them into a durable workflow by recording exactly what was approved and detecting when that artifact changes.

Sigildex is a local, deterministic command-line tool for AI agent skills. `sigildex lock` records an approval baseline for a skill directory you have reviewed, `sigildex check` detects drift in the bytes it measured, and `sigildex diff` explains what changed between two versions. It operates on local paths only: no network calls, no telemetry, and no safety scoring.

## Status

v0.1 in preparation — not yet published. It will be published as `sigildex` on npm; until then, build it from this repository. The identity specification ([docs/identity-spec.md](docs/identity-spec.md)) is the normative contract; implementation follows it.

## Trust boundary

> Sigildex records artifact identity and explains changes. It does not certify that a skill, script, dependency, remote service, installer, or runtime behavior is safe. Pair it with security scanning and human review appropriate to your environment.

A record can also carry a `declared_source` — where you believe the artifact came from, set with `lock`'s `--source-*` flags. It is user-supplied, never verified, and outside the identity digest: it is a note to your future self, not provenance.

**What a record measures.** Two names are excluded from the walk at any depth: `.git` and `.sigildex`. Nothing beneath them is hashed, so nothing beneath them is measured, compared, or reported — content can be added, changed, or removed under either name and a record will still report `Match`. The limiting case is worth stating outright: a valid record with an empty manifest matches *any* tree whose in-scope content is empty, so `Match` on its own is not evidence that a particular skill is present. Read the file count `check` prints alongside the verdict, and treat a count that surprises you as a finding.

## What the tooling does not check

`sigildex lock` refuses to write a record whose filename does not match its `approval_id`, and `sigildex check` compares one artifact against one record. Nothing in v0.1 audits a directory of approvals: duplicate approval IDs, duplicate artifact paths, and locks left behind without their artifact are not detected by the tool or by the CI example, which watches a single configured pair. Keeping an approval store clean stays a review responsibility — branch protection and code owners over the approvals directory.

## Documentation

- [docs/identity-spec.md](docs/identity-spec.md) — the normative identity and approval-record specification.
- [docs/safe-skill-adoption.md](docs/safe-skill-adoption.md) — an end-to-end workflow for adopting agent skills safely.
- [docs/ci](docs/ci) — a copy-paste CI workflow that keeps one skill and its approval record consistent, with an explicit account of what it cannot prove.
- [schema/](schema) — JSON Schema for the approval record and the diff report. These are *structural subsets* of the specification, published so tools can read the shape of a document: their string limits count code points where the specification counts UTF-8 bytes, and they cannot express the Unicode-assignment rule on paths, manifest ordering, or the requirement that `root_digest` agree with its own manifest. Records exist that the schema accepts and `sigildex check` rejects. `sigildex check` is the authority on whether a record is valid; each schema says so in its own `description` and `$comment`.
