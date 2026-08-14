# Sigildex

> Sigildex does not replace discovery, security scanning, or human review. It connects them into a durable workflow by recording exactly what was approved and detecting when that artifact changes.

Sigildex is a local, deterministic command-line tool for AI agent skills. `sigildex lock` records an approval baseline for a skill directory you have reviewed, `sigildex check` detects any drift from that baseline, and `sigildex diff` explains what changed between two versions. It operates on local paths only: no network calls, no telemetry, and no safety scoring.

## Status

v0.1 in preparation. The identity specification ([docs/identity-spec.md](docs/identity-spec.md)) is the normative contract; implementation follows it.

## Trust boundary

> Sigildex records artifact identity and explains changes. It does not certify that a skill, script, dependency, remote service, installer, or runtime behavior is safe. Pair it with security scanning and human review appropriate to your environment.

## Documentation

- [docs/identity-spec.md](docs/identity-spec.md) — the normative identity and approval-record specification.
- [docs/safe-skill-adoption.md](docs/safe-skill-adoption.md) — an end-to-end workflow for adopting agent skills safely.
