# Case study: designing an API for agent-first, programmatic use

*Prepared for the v0.1 release, 2026-08. Figures are from the project's internal records; where a number is an estimate or a limitation exists, the text says so. This is a historical account of a system that is being retired: nothing described below — the endpoints, the index, the payment rail — is callable, and the current project is the local command-line tool described in the repository [README](../README.md).*

Sigildex was a hosted trust preflight for agent skills, designed for programmatic callers rather than for people. There was no dashboard, no sign-up, and no console. Every design decision assumed the caller was a program with a limited context window, a retry loop, and no ability to ask a colleague what an ambiguous field meant.

That hosted system is being retired, and this open-source release closes the project. What follows is a technical account of what we built, written to be useful to anyone designing an API whose primary consumer is an agent. We are labelling each part **Shipped** (ran in production), **Experiment** (built and proven mechanically, never validated by adoption), or **Abandoned** (designed or partly built, never shipped). Where something carries forward, we say that it **ships in v0.1** of the open-source release.

One limitation up front, and it colours everything below: we never ran a market test. We have no traffic, install, or retention data for any of these surfaces. Nothing here is evidence that the design was *adopted* — only that it worked.

## Treating agents as first-class API consumers — Shipped

The product was a REST API, an MCP server, and a static page. The agent-first API and MCP redesign was run as its own milestone rather than as a retrofit onto a human-shaped API.

The most useful decision was making the *workflow* the unit of pricing and rate limiting rather than the call. One discovery workflow meant one ranked search plus review of up to five candidates, valid for an hour. An agent that must pay per inspection is incentivised to inspect less, which is exactly the wrong incentive on a safety surface.

The API also taught a flow, not just endpoints. The machine-readable front door spelled out six steps: check health, discover candidates, reject anything the safety verdict marks as blocked, inspect for full content and a pin, install only after user confirmation, and verify on future loads or in CI.

The safety path was never paywalled. Inspection was free with a valid query identifier from any discovery call, and verification was free and unauthenticated with no prerequisite at all.

## Machine-readable documentation surfaces — Shipped

The front door was a roughly 2.5 KB summary file with a roughly 90 KB full expansion behind it — progressive disclosure for a caller paying by the token.

Alongside it: an OpenAPI 3.1.0 document, an MCP server descriptor at a well-known path declaring a streaming HTTP transport, an RFC 9116 security contact file, and a permissive robots file that allowed every agent and pointed at a sitemap. We also shipped the product *as a skill*, so an agent could install our client the same way it installs anything else.

The transferable mechanism is not the file list. It is that both machine surfaces were **generated from one source map and never hand-edited**, and that drift between them and the code was machine-enforced rather than reviewed: a linter cross-checked the free-tier limit and version constants across the published files, the rate-limit middleware, and both package manifests, and failed the build when they disagreed, while the generator refused to run in check mode against a hand-edited output. If you publish a contract to agents, the contract has to break the build when it stops being true.

Two honest caveats. The pricing and payment descriptors under `.well-known/` were served dynamically by the application, not shipped as static files — so they will not outlive the scheduled shutdown of the service, while the static files will. And the codebase and every public descriptor stood at version 0.9.0 when we stopped; that number reflects the built artifact, not a tagged public release.

## Exact-artifact identity and pinning — Shipped, and carried forward

Content identity was a SHA-256 over the normalized raw skill, computed on a shared raw seam so that sanitizing surrounding metadata never perturbed a clean row's hash. We verified that byte-identically.

Verification existed to answer exactly one question — is this the artifact you told me about? — by content hash or source URL, free and unauthenticated. The real product loop was inspect, pin the hash, install, verify.

The lesson that outlived the index came from failing to apply it internally. Our own evaluation labels were joined to skills by database row ID. Across one rebuild, only 44 of 170 resurfaced that way — and only because that rebuild happened to carry IDs forward, which is not a property you can rely on. Content hash recovered 49, because it credits rows that are byte-identical even when their location has changed. No single key survived every failure mode — content hash breaks on any edit, location identity breaks on a rename — so the redesign used both. Mutable identifiers are not identity, and we learned it the expensive way.

This is the one primitive the open-source release keeps, and it **ships in v0.1**: raw-byte identity over a whole skill package, computed locally, with no hosted dependency, no network calls, and no telemetry.

## Source and freshness semantics — Shipped

Freshness was typed rather than implied. Every safety verdict carried an explicit freshness state: never audited, stale and unverifiable, stale because content drifted, stale because the scanner version moved on, or fresh. An agent could branch on that without heuristics.

Index-level state was equally explicit — responses declared whether the index was healthy, degraded, or rebuilding, with a dedicated health endpoint for freshness — and every result declared which of the two source registries it came from.

Honesty under degradation is the transferable idea here. When we froze the crawler for our second source, the API did not hide it. The specification stated plainly that one safety field was populated only for rows from that frozen snapshot — so rows from the other source would report `false` even when the bundle contained scripts — and told callers which other field to check instead. Publishing a field's blind spot next to the field is cheap. Discovering it as a consumer is not.

Those enums earned their keep at the end: the corpus stopped growing in mid-July 2026, and the freshness states are what made that visible on the wire rather than silently wrong.

**Abandoned:** a successor trust-wire specification was written and agreed but never implemented as a whole. One of its three parts shipped separately as a serving-side fix; the rest was gated on a corpus rebuild that never finished.

## MCP and CLI integration — Shipped

The MCP server exposed exactly three tools mirroring the three endpoints one to one. Resisting extra tools was deliberate: every additional tool is context an agent has to carry.

The sharpest finding in this whole project is small and easy to miss: **an MCP tool result is prompt input.** Author-supplied names and descriptions are untrusted text landing directly in a model's context — a description containing a newline could forge a verdict line above our real one. So our safety verdict is emitted as the *first* line of every result, before any author-controlled string can impersonate one, and inspected content is wrapped in an explicit fence that names it as untrusted and instructs the reader not to follow instructions within, with embedded fence markers neutralized first. The open-source release's threat model says plainly what this is worth: controls like these reduce risk and are not a security boundary. Quoting untrusted text does not make it safe for the model processing it, and we claim no immunity.

The CLI shipped with four commands over a shared library: one HTTP client, one configuration loader, one error contract, one output layer, one payment path. Thin commands over a shared core is unglamorous, and it is why the human and agent surfaces could not drift apart.

Payment was invisible until needed: a wallet key enabled automatic payment only past the free tier, and anonymous discovery, verification, and identity exchange needed no wallet at all.

**Abandoned:** a companion install-verification skill repository was built locally and never published.

## Free-first access, and the payment experiments

**Shipped.** Free-first was a ratified positioning decision, not a pricing accident: the payment rail stayed on the wire as an over-quota path while being kept out of every adoption-path surface.

The anonymous free tier ran at 50 discovery workflows per day per IP, with no key and no account. Rate-limit headers reported which *principal bucket* the request had spent from — anonymous IP, verified wallet, or partner allocation — so an agent could reason about which identity it was operating under rather than guessing.

**Experiment.** Sign-in-with-wallet raised the free tier without an account system: a nonce endpoint, a verification endpoint, and a shared principal resolver wired through rate limiting and the paid-fallback path. No email, no password, no dashboard, no self-serve signup — the wallet was the only identity. It worked; we have no adoption data to say whether anyone wanted it.

**Experiment.** The paid path was exercised live: three paid calls in all — one over REST, two over MCP — totalling six-tenths of a cent, and all three payments settled on-chain. Only the REST leg completed the full path from payment through to the settlement ledger. The MCP legs returned paid results, but their ledger transition was slow and unreliable in a serverless environment and was never signed off, and one of the two rows remained pending.

The honest economic finding is the most useful thing in this section. At two-tenths of a cent per workflow, with the payment facilitator charging a tenth of a cent per transaction beyond a free monthly allowance, **roughly half of gross revenue per call went to facilitator cost.** Micropayment rails are mechanically impressive and, at this price point, structurally unattractive as a steady-state model.

**A residual we are disclosing rather than omitting:** one settlement captured on-chain remained marked pending in our database. Reconciliation was never completed.

**Abandoned:** a credits and top-up model, a deeper package-inspection endpoint intended as the first genuinely paid transactional product, and general availability of the paid MCP path.

## Fail-closed error contracts — Shipped

Every error used one envelope carrying a code, a message, a retriability flag, a retry delay, and optional structured details. Making retriability *published data* rather than something an agent infers from a status code removed an entire class of guesswork.

There were thirteen error codes, defined as a single constant array specifically so that a contract test could iterate the runtime values and assert each one appears in the published OpenAPI enum. The code-to-public-surface contract was machine-enforced rather than documented. Where ambiguity would cost an agent a wasted retry loop, we sub-classified: an invalid query identifier resolved to expired, mismatched, or unknown.

The single best illustration of the principle is a sentence from our own specification, about the public payment protocol the service used: *"If x402 payments are temporarily disabled service-side, free-tier exhaustion returns `RATE_LIMITED` with HTTP 402 and no payment challenge — branch on the error code, not the HTTP status."* Transport-level signals are ambiguous. A contract-level code is not.

Boundary translation was a real bug class rather than theory. Our code duck-typed on a property that an upstream provider SDK's error objects never actually carried, so the translation layer never fired once — dead code from the day it was written, while genuine upstream throttles and server errors reached callers as non-retriable client errors telling them not to retry. The bug was ours, not the provider's; the fix was to classify at the boundary and translate into our own vocabulary. Fail-closed behaviour under shared-state unavailability was tested explicitly across REST and MCP, including the paths that must never fall through to payment verification or to serving content.

The counterweight belongs here too: on the pipeline side, fail-closed guards false-failed our own happy path repeatedly — three long, legitimate runs died on three different guards. Fail-closed is correct and it is expensive.

## Observability and bounded paid work — Shipped

Our operating principle was that a job which runs green while being silently wrong is two bugs — the wrong behavior and the missing detector. Alerts were specific and threshold-driven rather than generic uptime checks: no successful sync in 36 hours, total skills dropping more than 5%, embedding coverage under 80%, safety coverage under 50%, or a sync run that stored nothing at all.

The dead-man switch is the pattern worth copying. A watchdog ran daily inside our CI provider, but the detector *for the watchdog* deliberately lived outside it: an external ping service that alerts when the daily success ping fails to arrive. Inside the job, the courtesy notification runs first and never blocks, and the success ping runs last, so a ping can only be sent by a run that actually completed. An absence detector hosted by the thing it monitors is not an absence detector.

Paid work was bounded by an explicit cost cap. When the cap engages, the run records both the cap and the fact that it was hit, and **exits successfully on purpose** — a guardrail firing is not a failure, so no alert pages anyone. We are publishing the cap's two real limitations rather than the clean version: it counts *estimated* cost from a pinned pricing table, so a provider price change can let real spend exceed the cap until that table is updated (a test fails loudly when prices rotate), and calls that time out bill outside its accounting.

The same discipline covered our evaluation work: a $25 ceiling on the label-drafting harness, against which the whole arc came in at $4.24 of model spend.

**A detector that shipped dormant, then got scheduled.** We built a revenue absence-detector for settlements stuck in a pending state. It shipped as an unscheduled verdict, invoked on demand, and was wired onto the twice-daily alerter afterward. Our own operational notes lagged that change: one section still described it as dormant long after it was live. A stale runbook is the same failure class as a silently-wrong job — a document that says nothing pages you is an absence-detection gap of its own.

## What should, and should not, require centralized state

This is the question the whole project ended up answering, and the answer is cleaner than we expected: **verification wants no central state; ranking and quota do.**

The hosted verification endpoint needed only a content hash to answer its question, which is precisely why the idea survives as a local command with zero hosted dependency. The two are not the same check: v0.1's `check` compares a whole artifact against an approval record covering paths, contents, and executable bits, rather than looking a single hash up in an index.

Ranking genuinely needed the index — semantic relevance combined with community signals, freshness decay, and publisher trust. None of that is computable on one developer's laptop.

Quota was the state that hurt. Moving shared quota state from process memory into the database was correct — in-memory quota across serverless instances is a real correctness bug, not a theoretical one — and it cost about 500 milliseconds at the 95th percentile against a budget of 100. That failed our own latency gate. We recorded it as a failure and an explicit, written re-baseline rather than reinterpreting the gate, choosing correctness over latency before any market test.

The probe we ran beforehand had looked fine, because it measured database compute rather than the network hop where the cost actually lived. Probes measure what you point them at.

Wallet-as-principal is the interesting middle: per-caller quota with no email, no password, and no self-serve account object behind it.

One strategic note we owe the reader, because it is not only an architecture question. Our own most critical review located the durable business position in the hosted longitudinal record — the thing only a service that watches over time can produce — and described local point-in-time work as crowded and increasingly free. Choosing the stateless half is a defensible engineering decision and a deliberate commercial retreat. Both are true at once.

So the open-source release keeps only the stateless half, and that is what **ships in v0.1**: three local commands over local paths, with no hosted index and no hosted component of any kind. The hosted estate itself is scheduled for shutdown. Sigildex does not replace discovery, security scanning, or human review. It connects them into a durable workflow by recording exactly what was approved and detecting when that artifact changes.

That claim is narrow on purpose, and complementary. Scanners such as SkillSpector and the Cisco Skill Scanner analyse a candidate directory and produce the evidence a reviewer needs; Snyk Agent Scan audits the agent components already installed on a machine; the Vercel Skills CLI and `gh skill` handle discovery and installation. Several projects already hash skill directories. Baselines, hashes, update checks, and diffs are not uncontested ground, and we claim to be neither first nor only at any of it. What we are keeping is the record of what a human approved, and a deterministic way to notice when that stops matching reality.
