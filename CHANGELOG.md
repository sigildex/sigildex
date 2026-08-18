# Changelog

All notable changes to this package. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the
compatibility rules in [docs/identity-spec.md](docs/identity-spec.md) §14.

## 0.1.1 — 2026-08-18

Documentation and release metadata only. `lock`, `check`, and `diff` and the
identity computation are unchanged; a record written by 0.1.0 verifies with
0.1.1 and vice versa.

### Added

- `CONTRIBUTING.md`: what is in and out of scope for 0.1, and the
  compatibility policy.
- `docs/code-map.md`: each documented claim, its specification section, the
  file that implements it, and the tests that hold it.
- Agent Skill reference files under `skills/sigildex/references/` — CLI
  reference, update checks, scanners, CI, revocation — loaded only when a step
  needs them.

### Changed

- README, website, `llms.txt`, the Agent Skill, and the adoption guide
  rewritten: shorter, each fact stated once at its home, limits in one section
  per surface. The workflow reads as two loops — adopt and update — with the
  ten-stage detail in the guide.
- The Agent Skill states the rules an agent meets first: install and PATH
  preflight, the `--artifact-path` rule, the `--approval-id` default, and how
  `gh skill update` relates to a record's `declared_source`.
- Website: section navigation works on small screens; the page head links
  `/llms.txt` for discovery.

## 0.1.0 — 2026-08-18

Initial release: `sigildex lock`, `sigildex check`, `sigildex diff`; the
identity specification, JSON Schemas, threat model, safe-skill-adoption guide,
CI example, Agent Skill, and the version-drift example.
