# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's private vulnerability
reporting on the repository:

https://github.com/sigildex/sigildex/security/advisories/new

Do not open a public issue for a suspected vulnerability. Include the affected
version, the platform and Node.js version, reproduction steps, and the impact
you observed. Reports are handled best-effort with no guaranteed response time;
critical issues are prioritized.

## Scope

Sigildex records artifact identity and explains changes. It does not certify
that a skill, script, dependency, remote service, installer, or runtime behavior
is safe. Reports that a given skill is malicious are out of scope; reports that
Sigildex misreports identity, fails to detect drift, or is itself exploitable
are in scope.

[docs/threat-model.md](docs/threat-model.md) lists the assets, trust
boundaries, attacker classes, and residual risks. Read it first, so a report
can say which boundary it crosses.
