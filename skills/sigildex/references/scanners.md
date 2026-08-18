# Scanners

Per-tool commands and caveats for scanning a quarantined candidate. Read this
before running any scanner. Scanners produce evidence, not certification: a
clean report is not approval, and no findings does not mean no risk. Run more
than one when you can — they disagree, and the disagreements are informative.

*Commands were checked against each project's published documentation on
2026-08-16. All three projects are young and moving; verify each command against
the tool's current documentation, and report a failure rather than guessing at
syntax. If the syntax has changed, the step has not: point a scanner at the
quarantined directory, capture machine-readable output, and read it.*

Always point a scanner at the staged copy (`~/skill-review/<name>` below), never
at an active skills directory. Summarize from the JSON: counts by severity, rule
or category names, file paths. Restate finding text that originated in candidate
content only as far as the human needs to locate it.

## NVIDIA SkillSpector

<https://github.com/NVIDIA/skillspector>

```sh
uv tool install git+https://github.com/NVIDIA/skillspector.git
skillspector scan ~/skill-review/<name> --no-llm --format json --output ~/skill-review/skillspector.json
```

- `--no-llm` restricts it to static pattern and AST analysis: nothing is sent
  to a model provider and no API key is needed. Omit it to enable semantic
  evaluation through a configured provider.
- `--no-llm` is not the same as no network: its static dependency check may
  query OSV.dev for advisories, falling back to local analysis when offline.
  Check its documentation if network egress from the review environment
  matters.
- It exits non-zero on a do-not-install verdict while still writing a valid
  report, so read the JSON file rather than branching on the exit code.
- To run without installing:
  `uvx --from git+https://github.com/NVIDIA/skillspector.git skillspector scan …`.

## Cisco AI Defense Skill Scanner

<https://github.com/cisco-ai-defense/skill-scanner>

```sh
pip install cisco-ai-skill-scanner
skill-scanner scan ~/skill-review/<name> --format json
```

- The default run is local; its LLM and network analyzers are opt-in flags,
  some of which need API keys. Consult the project's documentation for the
  current set.
- To run without installing:
  `uvx --from cisco-ai-skill-scanner skill-scanner scan …`.

## Snyk Agent Scan

<https://github.com/snyk/agent-scan>

Do not offer to run this one during a candidate review. Its machine-wide mode
(run without a path) discovers agent components in well-known locations and,
with consent, starts configured stdio MCP servers to enumerate them. That is a
reasonable way to audit what a person already runs; it is also exactly what
quarantine exists to prevent (hard boundary 5). Point the human at it and say
they may run it themselves, scoped to the staged directory:

```sh
SNYK_TOKEN=<your-token> uvx snyk-agent-scan@0.5.17 ~/skill-review/<name>
```

- `0.5.17` was the current release on 2026-08-16; pin deliberately rather than
  tracking `@latest`.
- It accepts a skill directory or file path as a positional argument per its
  documentation; that syntax was not executed for this guide (it requires a
  `SNYK_TOKEN`), so verify it before relying on it.
- The PyPI package declares no project URLs, so the published metadata does not
  link back to a source repository; confirm what is being installed first.

For scanning a single quarantined directory, SkillSpector and the Cisco scanner
are the more direct fit.
