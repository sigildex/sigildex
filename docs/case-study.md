# Case study: designing an API for agent-first, programmatic use

*Prepared for the 0.1 release, 2026-08. Figures come from the project's own records; estimates and gaps are marked as such. Nothing described here is callable — the endpoints, the index, and the payment rail are retired; the current project is the local command-line tool in the [README](../README.md). **Shipped** ran in production; **Experiment** was built and measured but never validated by adoption; **Abandoned** was designed or partly built and never shipped.*

Sigildex was a hosted trust preflight for agent skills, designed for programmatic callers rather than for people. There was no dashboard, no sign-up, and no console. Every design decision assumed the caller was a program with a limited context window, a retry loop, and no ability to ask a colleague what an ambiguous field meant.

That system is retired, and this open-source release closes the project. What follows is a technical account for anyone designing an API whose primary consumer is an agent. Where something carries forward, it **ships in 0.1** of the open-source release.

We never ran a market test and have no traffic, install, or retention data, so nothing here is evidence that a design was *adopted* — only that it worked.

## Treating agents as first-class API consumers — Shipped

The product was a REST API, an MCP server, and a static page. The agent-first API and MCP were designed as such, not retrofitted onto a human-shaped API.

The most useful decision was making the *workflow* the unit of pricing and rate limiting rather than the call. One discovery workflow meant one ranked search plus review of up to five candidates, valid for an hour. An agent that pays per inspection is incentivised to inspect less — the wrong incentive on a safety surface.

The API also taught a flow, not just endpoints. The machine-readable entry file spelled out six steps: check health, discover candidates, reject anything the safety verdict marks as blocked, inspect for full content and a pin, install only after user confirmation, and verify on future loads or in CI.

The safety path was never paywalled. Inspection was free with a valid query identifier from any discovery call, and verification was free and unauthenticated with no prerequisite at all.

## Machine-readable documentation surfaces — Shipped

The entry file was a roughly 2.5 KB summary with a roughly 90 KB full expansion behind it — progressive disclosure for a caller paying by the token.

Alongside it: an OpenAPI 3.1.0 document, an MCP server descriptor at a well-known path declaring a streaming HTTP transport, an RFC 9116 security contact file, and a permissive robots file that allowed every agent and pointed at a sitemap. We also shipped the product *as a skill*, so an agent could install our client the way it installs anything else.

The transferable mechanism is not the file list. Both machine surfaces were **generated from one source map and never hand-edited**, and drift between them and the code was machine-enforced rather than reviewed. A linter cross-checked the free-tier limit and version constants across the published files, the rate-limit middleware, and both package manifests, and failed the build when they disagreed; the generator refused to run in check mode against a hand-edited output.

If you publish a contract to agents, the contract has to break the build when it stops being true.

Two caveats. The pricing and payment descriptors under `.well-known/` were served dynamically by the application, not as static files, so they will not outlive the scheduled shutdown of the service; the static files will. And the codebase and every public descriptor stood at version 0.9.0 when we stopped; that number reflects the built artifact, not a tagged public release.

## Exact-artifact identity and pinning — Shipped, and carried forward

Content identity was a SHA-256 over the normalised raw skill, computed on a shared raw seam so that sanitising surrounding metadata never perturbed a clean row's hash. We verified that byte-identically.

Verification existed to answer exactly one question — is this the artifact you told me about? — by content hash or source URL, free and unauthenticated. The real product loop was inspect, pin the hash, install, verify.

The lesson that outlived the index came from failing to apply it internally. Our own evaluation labels were joined to skills by database row ID; across one rebuild only 44 of 170 resurfaced that way, while content hash recovered 49 (the full account is in the [postmortem](postmortem.md)). No single key survived every failure mode — content hash breaks on any edit, location identity breaks on a rename — so the redesign used both. Mutable identifiers are not identity, and we learned it the expensive way.

This is the one primitive the open-source release keeps, and it **ships in 0.1**: raw-byte identity over a whole skill package, computed locally, with no hosted dependency, no network calls, and no telemetry.

## Source and freshness semantics — Shipped

Freshness was typed rather than implied. Every safety verdict carried an explicit freshness state: never audited, stale and unverifiable, stale because content drifted, stale because the scanner version moved on, or fresh. An agent could branch on that without heuristics.

Index-level state was equally explicit — responses declared whether the index was healthy, degraded, or rebuilding, with a dedicated health endpoint for freshness — and every result declared which of the two source registries it came from.

Candour under degradation is the transferable idea here. When we froze the crawler for our second source, the API did not hide it. The specification stated that one safety field was populated only for rows from that frozen snapshot — so rows from the other source would report `false` even when the bundle contained scripts — and told callers which other field to check instead.

Publishing a field's blind spot next to the field is cheap. Discovering it as a consumer is not.

Those enums earned their keep at the end: the corpus stopped growing in mid-July 2026, and the freshness states are what made that visible on the wire rather than silently wrong.

**Abandoned:** a successor trust-wire specification was written and agreed but never implemented as a whole. One of its three parts shipped separately as a serving-side fix; the rest was gated on a corpus rebuild that never finished.

## MCP and CLI integration — Shipped

The MCP server exposed exactly three tools mirroring the three endpoints one to one. Every additional tool is context an agent has to carry, so we added none.

The sharpest finding in this whole project is small and easy to miss: **an MCP tool result is prompt input.** Author-supplied names and descriptions are untrusted text landing directly in a model's context — a description containing a newline could forge a verdict line above our real one.

So our safety verdict was emitted as the *first* line of every result, before any author-controlled string could impersonate one. Inspected content was wrapped in an explicit fence naming it as untrusted and instructing the reader not to follow instructions within, with embedded fence markers neutralised first.

The open-source release's threat model says what this is worth: controls like these reduce risk and are not a security boundary. Quoting untrusted text does not make it safe for the model processing it, and we claim no immunity.

The CLI shipped with four commands over a shared library: one HTTP client, one configuration loader, one error contract, one output layer, one payment path. Thin commands over a shared core is unglamorous, and it is why the human and agent surfaces could not drift apart.

Payment was invisible until needed: a wallet key enabled automatic payment only past the free tier, and anonymous discovery, verification, and identity exchange needed no wallet at all.

**Abandoned:** a companion install-verification skill repository was built locally and never published.

## Free-first access, and the payment experiments

**Shipped.** Free-first was a settled positioning decision, not a pricing accident: the payment rail stayed on the wire as an over-quota path while being kept out of every adoption-path surface.

The anonymous free tier ran at 50 discovery workflows per day per IP, with no key and no account. Rate-limit headers reported which *principal bucket* the request had spent from — anonymous IP, verified wallet, or partner allocation — so an agent could reason about which identity it was operating under rather than guessing.

**Experiment.** Sign-in-with-wallet raised the free tier without an account system: a nonce endpoint, a verification endpoint, and a shared principal resolver wired through rate limiting and the paid-fallback path. No email, no password, no dashboard, no self-serve signup — the wallet was the only identity. It worked.

**Experiment.** The paid path was exercised live: three paid calls in all — one over REST, two over MCP — totalling six-tenths of a cent, and all three payments settled on-chain. Only the REST leg completed the full path from payment through to the settlement ledger. The MCP legs returned paid results, but their ledger transition was slow and unreliable in a serverless environment and was never signed off. One settlement captured on-chain stayed marked pending in our database; reconciliation was never completed.

The economic finding is the most useful thing in this section. At two-tenths of a cent per workflow, with the facilitator charging a tenth of a cent per transaction beyond a free monthly allowance, **roughly half of gross revenue per call went to facilitator cost.** Micropayment rails are mechanically impressive and, at this price point, structurally unattractive as a steady-state model.

**Abandoned:** a credits and top-up model, a deeper package-inspection endpoint intended as the first genuinely paid transactional product, and general availability of the paid MCP path.

## Fail-closed error contracts — Shipped

Every error used one envelope carrying a code, a message, a retriability flag, a retry delay, and optional structured details. Making retriability *published data* rather than something an agent infers from a status code removed an entire class of guesswork.

There were thirteen error codes, defined as a single constant array so that a contract test could iterate the runtime values and assert each one appears in the published OpenAPI enum. The code-to-public-surface contract was machine-enforced, not documented. Where ambiguity would cost an agent a wasted retry loop, we sub-classified: an invalid query identifier resolved to expired, mismatched, or unknown.

The single best illustration of the principle is a sentence from our own specification, about the public payment protocol the service used: *"If x402 payments are temporarily disabled service-side, free-tier exhaustion returns `RATE_LIMITED` with HTTP 402 and no payment challenge — branch on the error code, not the HTTP status."* Transport-level signals are ambiguous. A contract-level code is not.

Boundary translation was a real bug class, not theory. Our code duck-typed on a property that an upstream provider SDK's error objects never carried, so the translation layer never fired once — dead code from the day it was written — while genuine upstream throttles and server errors reached callers as non-retriable client errors. The bug was ours, not the provider's; the fix was to classify at the boundary and translate into our own vocabulary.

Fail-closed behaviour under shared-state unavailability was tested explicitly across REST and MCP, including the paths that must never fall through to payment verification or to serving content. The counterweight belongs here too: on the pipeline side, fail-closed guards false-failed our own happy path — three long, legitimate runs died on three different guards. Fail-closed is correct and it is expensive.

## Observability and bounded paid work — Shipped

Our operating principle: a job that runs green while silently wrong is two bugs — the wrong behaviour and the missing detector. Alerts were specific and threshold-driven, not generic uptime checks: no successful sync in 36 hours, total skills dropping more than 5%, embedding coverage under 80%, safety coverage under 50%, or a sync run that stored nothing at all.

The dead-man switch is the pattern worth copying. A watchdog ran daily inside our CI provider, but the detector *for the watchdog* lived outside it: an external ping service that alerts when the daily success ping fails to arrive. Inside the job, the courtesy notification runs first and never blocks; the success ping runs last, so only a run that actually completed can send it. An absence detector hosted by the thing it monitors is not an absence detector.

Paid work was bounded by an explicit cost cap. When the cap engages, the run records both the cap and the fact that it was hit, and **exits successfully on purpose** — a guardrail firing is not a failure, so no alert pages anyone.

The cap has two limitations. It counts *estimated* cost from a pinned pricing table, so a provider price change can let real spend exceed the cap until that table is updated (a test fails loudly when prices rotate). And calls that time out bill outside its accounting.

The same discipline covered our evaluation work: a $25 ceiling on the label-drafting harness, against which the whole arc came in at $4.24 of model spend.

**A detector that shipped dormant, then got scheduled.** We built a revenue absence-detector for settlements stuck in a pending state. It shipped as an unscheduled verdict, invoked on demand, and was wired onto the twice-daily alerter afterward. Our operational notes lagged that change: one section still described it as dormant long after it was live. A stale runbook is the same failure class as a silently-wrong job — a document that says nothing pages you is an absence-detection gap of its own.

## What should, and should not, require centralized state

This is the question the whole project ended up answering, and the answer is cleaner than we expected: **verification wants no central state; ranking and quota do.**

The hosted verification endpoint needed only a content hash to answer its question, which is why the idea survives as a local command with zero hosted dependency. The two are not the same check: the 0.1 `check` compares a whole artifact against an approval record covering paths, contents, and executable bits, rather than looking a single hash up in an index.

Ranking genuinely needed the index — semantic relevance combined with community signals, freshness decay, and publisher trust. None of that is computable on one developer's laptop.

Quota was the state that hurt. Moving shared quota state from process memory into the database was correct — in-memory quota across serverless instances is a real correctness bug — and it cost about 500 milliseconds at the 95th percentile against a budget of 100. That failed our own latency gate. We recorded it as a failure and an explicit, written re-baseline rather than reinterpreting the gate, choosing correctness over latency.

The probe we ran beforehand had looked fine, because it measured database compute rather than the network hop where the cost actually lived. Probes measure what you point them at.

Wallet-as-principal is the interesting middle: per-caller quota with no email, no password, and no self-serve account object behind it.

One strategic note, because this is not only an architecture question. Our most critical review located the durable business position in the hosted longitudinal record — what only a service that watches over time can produce — and described local point-in-time work as crowded and increasingly free. Choosing the stateless half is a defensible engineering decision and a deliberate commercial retreat. Both are true at once.

So the open-source release keeps only the stateless half, and that is what **ships in 0.1**: three local commands over local paths, with no hosted index and no hosted component of any kind. The hosted estate itself is scheduled for shutdown.

Other projects hash skill directories too, and update checks and diffs are not uncontested ground. What Sigildex keeps is the record of what a human approved and a deterministic way to notice when that stops matching reality.

The record proves that the approved bytes are unchanged, and nothing more: it does not certify that a skill is safe, and it does not verify where a skill came from. How it fits beside the scanners and installers you already use is in the [README](../README.md).
