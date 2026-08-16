# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately through GitHub's private
vulnerability reporting on the canonical repository:

https://github.com/sigildex/sigildex/security/advisories/new

Do not open a public issue for a suspected vulnerability.

A useful report includes the affected version, the platform and Node.js version,
reproduction steps, and the impact you observed.

## Response

Reports are handled on a best-effort basis. No response time is guaranteed or
advertised. Fixes for issues judged critical are prioritized over other work.

## Scope

Sigildex records artifact identity and explains changes. It does not certify
that a skill, script, dependency, remote service, installer, or runtime behavior
is safe. Reports that a given skill is malicious are out of scope; reports that
Sigildex misreports identity, fails to detect drift, or is itself exploitable
are in scope.

[docs/threat-model.md](docs/threat-model.md) sets out the assets, the trust
boundaries, the attacker classes considered, and the residual risks that are
explicitly out of scope. Read it before reporting, so a report can say which
boundary it crosses.
