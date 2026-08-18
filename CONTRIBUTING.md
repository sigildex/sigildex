# Contributing

Sigildex does three things: `sigildex lock` writes an approval record for a
directory a human reviewed, `sigildex check` detects drift against it, and
`sigildex diff` explains what changed. The scope is fixed for 0.1. The useful
contribution is a defect, described well enough to reproduce.

## Welcome

- **Bug reports**, including any divergence between the specification and the
  implementation. The specification wins: where the two disagree, the
  implementation is defective. Name the section you read and the behaviour you
  saw.
- **Documentation corrections**: a claim that overstates the tool, a command
  that does not run as written, a link to the wrong page.
- **Failing tests.** A test that demonstrates a defect is a complete bug
  report.

Open these as [GitHub issues](https://github.com/sigildex/sigildex/issues)
with the version, the platform and Node.js version, and the steps.

Security reports do not go in issues. Follow [SECURITY.md](SECURITY.md), which
routes them through private vulnerability reporting.

## Out of scope

New commands, flags that change what identity means, hosted services, network
features, discovery, safety scoring, and scope expansion generally.

Pull requests that change identity semantics, the JSON Schemas, or the
specification will not be merged into 0.1.x. A record written by one 0.1.x
version has to keep verifying under another. If you believe the specification
is wrong, open an issue saying why.

## Development

```sh
git clone https://github.com/sigildex/sigildex
cd sigildex
npm ci
npm run build
npm test
```

Node.js 20 or later, macOS or Linux. CI also runs `npm run typecheck` and
`npm run verify:example`. The test suite follows the specification section by
section. [docs/code-map.md](docs/code-map.md) says which tests hold which
claim.

## Compatibility

- **0.1.x receives documentation and packaging fixes**, and fixes that bring
  the implementation back to what the specification says. A record written by
  any 0.1.x version verifies with any other 0.1.x version. A `check` that reads
  a `spec_version` or `schema_version` it does not support exits `3` without
  comparing anything.
- **What forces a version bump** is defined in
  [docs/identity-spec.md](docs/identity-spec.md) §14: any change to scope,
  exclusions, path rules, hashing, canonical serialization, limits, or the
  fail-closed matrix increments the spec version. The hash algorithm is fixed
  at SHA-256 for spec version 1. A patch is what is left: wording, packaging,
  messages, tests, and specification-conformance fixes.
- **The supported integration surfaces are the CLI and the published JSON
  Schemas.** The package also publishes a JavaScript entry point
  (`main: dist/index.js`, with type declarations). Importing it works, but its
  exports may change in any 0.1.x release. Pin an exact version if you build on
  it. Nothing else is deprecated or changed without a version bump.
