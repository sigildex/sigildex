# Contributing

## What this project is

Sigildex is a bounded, complete release rather than an open-ended one. It does
three things — record an approval baseline, detect drift against it, explain
what changed — and the v0.1 boundary around those three is frozen. What
"frozen" means precisely is written down in the compatibility rules of
[docs/identity-spec.md](docs/identity-spec.md) §14: records carry
`spec_version` and `schema_version`, and any change to scope, exclusions, path
rules, hashing, canonical serialization, limits, or the fail-closed matrix
increments the spec version rather than landing inside it.

So the useful contribution here is not a feature. It is a defect, described
well enough to reproduce.

## What is welcome

- **Bug reports**, including a divergence between the specification and the
  implementation. The specification wins those: where the two disagree, the
  implementation is defective. A report that names the section it read and the
  behaviour it saw is the most valuable thing this project can receive.
- **Documentation corrections** — a claim that overstates what the tool does, a
  command that does not run as written, a link that resolves to the wrong page.
- **Test cases that demonstrate a defect.** A failing test is a complete bug
  report.

Open these as [GitHub issues](https://github.com/sigildex/sigildex/issues).
Include the version, the platform and Node.js version, and the steps.

**Security reports do not go in issues.** Follow [SECURITY.md](SECURITY.md),
which routes them through private vulnerability reporting. A suspected
vulnerability posted publicly is a disclosure, not a report.

## What is out of scope

New commands, new flags that change what identity means, hosted services,
network features, discovery, safety scoring, and scope expansion generally.
These are not deferred; they are outside what this release is.

Pull requests that change identity semantics, the JSON Schemas, or the
specification will not be merged into 0.1.x. That is not a judgement on the
change — it is what the compatibility rules above require, because a record
written by one 0.1.x version has to keep verifying under another. If you
believe the specification is wrong, open an issue saying why; that is the path
such a change would take.

## Development setup

```sh
git clone https://github.com/sigildex/sigildex
cd sigildex
npm ci
npm run build
npm test
```

Node.js 20 or later, on macOS or Linux. `npm run typecheck` and
`npm run verify:example` are the other two checks CI runs; the test suite
covers the specification section by section, and
[docs/code-map.md](docs/code-map.md) says which tests hold which claim.

## Maintenance and compatibility policy

- **0.1.x receives documentation and packaging fixes**, and fixes that bring
  the implementation back to what the specification already says.
- **The record format follows the specification's compatibility rules.**
  `schema_version` and `spec_version` are carried in every record, and a
  `check` that reads a value it does not support exits 3 rather than comparing
  anything and reporting a result.
- **A record written by any 0.1.x version verifies with any other 0.1.x
  version.** That is the guarantee the frozen boundary buys, and it is why the
  restrictions above exist.
- **Nothing is deprecated without a version bump.** A behaviour documented here
  will not quietly change underneath a record that depends on it.
