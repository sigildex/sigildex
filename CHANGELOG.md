# Changelog

All notable changes to this package. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the
compatibility rules in [docs/identity-spec.md](docs/identity-spec.md) §14.

## 0.1.1 — 2026-08-18

Documentation and release metadata only. `lock`, `check`, and `diff` and the
identity computation are unchanged; a record written by 0.1.0 verifies with
0.1.1 and vice versa.

- README rewritten: the problem first, the ten-stage workflow with an object
  diagram, a comparison with neighbouring tools, and a smoke test that runs
  entirely from the installed package.
- llms.txt and the Agent Skill state the rules an agent hits first: install
  and PATH preflight, the `--artifact-path` rule, the `--approval-id` default,
  the exit-code ordering, and how `gh skill update` relates to a record's
  `declared_source`.
- New: docs/code-map.md (behaviour → specification → implementation → tests)
  and CONTRIBUTING.md (frozen v0.1 scope; maintenance and compatibility
  policy).
- Website rebuilt from the same sources; section navigation works on small
  screens; the page head links /llms.txt for discovery.
- CI additionally installs the packed tarball into a clean prefix and asserts
  the binary's version and the example's exit sequence.

## 0.1.0 — 2026-08-18

Initial release: `sigildex lock`, `sigildex check`, `sigildex diff`; the
identity specification, JSON Schemas, threat model, safe-skill-adoption guide,
CI example, Agent Skill, and the version-drift example.
