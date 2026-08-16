# Sigildex

> Sigildex does not replace discovery, security scanning, or human review. It connects them into a durable workflow by recording exactly what was approved and detecting when that artifact changes.

Sigildex is a local, deterministic command-line tool for AI agent skills. `sigildex lock` records an approval baseline for a skill directory you have reviewed, `sigildex check` detects any drift from that baseline, and `sigildex diff` explains what changed between two versions. It operates on local paths only: no network calls, no telemetry, and no safety scoring.

## Status

v0.1 in preparation. The identity specification ([docs/identity-spec.md](docs/identity-spec.md)) is the normative contract; implementation follows it.

## Trust boundary

> Sigildex records artifact identity and explains changes. It does not certify that a skill, script, dependency, remote service, installer, or runtime behavior is safe. Pair it with security scanning and human review appropriate to your environment.

A record can also carry a `declared_source` — where you believe the artifact came from, set with `lock`'s `--source-*` flags. It is user-supplied, never verified, and outside the identity digest: it is a note to your future self, not provenance.

## What the tooling does not check

`sigildex lock` refuses to write a record whose filename does not match its `approval_id`, and `sigildex check` compares one artifact against one record. Nothing in v0.1 audits a directory of approvals: duplicate approval IDs, duplicate artifact paths, and locks left behind without their artifact are not detected by the tool or by the CI example, which watches a single configured pair. Keeping an approval store clean stays a review responsibility — branch protection and code owners over the approvals directory.

## Documentation

- [docs/identity-spec.md](docs/identity-spec.md) — the normative identity and approval-record specification.
- [docs/safe-skill-adoption.md](docs/safe-skill-adoption.md) — an end-to-end workflow for adopting agent skills safely.
- [docs/ci](docs/ci) — a copy-paste CI workflow that keeps one skill and its approval record consistent, with an explicit account of what it cannot prove.
