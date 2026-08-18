# Case study: designing an API for agents first

*Written for the 0.1 release, August 2026. Figures come from the project's own records; estimates are marked. Nothing described here is callable. The hosted API, the index and the payment rail are being retired. What remains is the local command-line tool in the [README](../README.md).*

Sigildex was a hosted trust preflight for agent skills, a side project from April to August 2026. It had no dashboard, no sign-up and no console. Every design decision assumed the caller was a program with a limited context window, a retry loop, and no colleague to ask what an ambiguous field meant. The [postmortem](postmortem.md) covers why I wound it down. This is the technical account: what I'd keep, what I'd change, and what carries into the CLI that ships instead.

One caveat up front. I never ran a market test, so nothing here is evidence that a design was adopted. Only that it worked.

## Agents as the first-class consumer

The product was a REST API, an MCP server and a static page, designed for agents from the start rather than retrofitted onto a human-shaped API.

The most useful decision was to price and rate-limit the workflow rather than the call. One discovery workflow meant one ranked search plus inspection of up to five candidates, valid for an hour. An agent that pays per inspection is pushed to inspect less, which is the wrong incentive on a safety surface.

The API taught a flow. The machine-readable entry file spelled out six steps: check health, discover candidates, reject anything the safety verdict marks as blocked, inspect for full content and a pin, install only after the user confirms, verify on future loads or in CI.

The safety path was never paywalled. Inspection was free with a valid query id from any discovery call. Verification was free and unauthenticated with no prerequisite at all.

## Machine-readable surfaces that break the build

The entry file was a ~2.5 KB summary with a ~90 KB full expansion behind it: progressive disclosure for a caller paying by the token. Alongside it: an OpenAPI 3.1 document, an MCP descriptor at a well-known path, an RFC 9116 security contact file, and a robots file that allowed every agent and pointed at a sitemap. I also shipped the product as a skill, so an agent could install the client the way it installs anything else.

The file list isn't the point. Both machine surfaces were generated from one source map and never hand-edited, and drift between them and the code failed the build. A linter cross-checked the free-tier limit and version constants across the published files, the rate-limit middleware and both package manifests. The generator refused to run in check mode against a hand-edited output.

If you publish a contract to agents, the contract has to break the build when it stops being true.

One caveat: every public descriptor stood at version 0.9.0 when I stopped. That number reflects the built artifact, not a tagged public release.

## Exact-artifact identity

Content identity was a SHA-256 over the normalised raw skill, computed on a shared raw seam so that sanitising surrounding metadata never perturbed a clean row's hash. Verification answered one question, is this the artifact you told me about, by content hash or source URL, free and unauthenticated. The real loop was inspect, pin the hash, install, verify.

The lesson that outlived the index came from failing to apply it internally. My own evaluation labels were joined to skills by database row id. Across one rebuild only 44 of 170 resurfaced that way; content hash recovered 49. No single key survived every failure mode: content hash breaks on any edit, location identity breaks on a rename, so the redesign used both. Mutable identifiers are not identity. I learned it the expensive way.

This is the primitive the open-source release keeps: raw-byte identity over a whole skill package, computed locally, no hosted dependency, no network calls, no telemetry.

## Typed freshness, and saying so when degraded

Freshness was typed rather than implied. Every safety verdict carried an explicit state: never audited, stale and unverifiable, stale because content drifted, stale because the scanner moved on, or fresh. An agent could branch on that without heuristics. Index-level state was just as explicit: healthy, degraded or rebuilding, with a health endpoint for freshness, and every result declared which of the two source registries it came from.

Candour under degradation is the transferable idea. When I froze the second source (ClawHub, the OpenClaw registry, for the reasons in the postmortem), the API didn't hide it. The spec stated that one safety field was populated only for rows from that frozen snapshot, so rows from the other source would report `false` even when the bundle contained scripts, and told callers which field to check instead, because a field's blind spot is cheap to publish and expensive to discover.

Those enums earned their keep at the end. The corpus stopped growing in mid-July, and the freshness states are what made that visible on the wire rather than silently wrong. A successor freshness spec was agreed and never fully built; one of its three parts shipped as a serving-side fix.

## MCP: a tool result is prompt input

The MCP server exposed exactly three tools mirroring the three endpoints. Every extra tool is context an agent has to carry, so I added none.

The sharpest finding is small: an MCP tool result is prompt input. Author-supplied names and descriptions are untrusted text landing directly in a model's context. A description containing a newline could forge a verdict line above the real one. So the safety verdict was emitted as the first line of every result, before any author-controlled string could impersonate it, and inspected content was wrapped in an explicit fence naming it as untrusted, with embedded fence markers neutralised first.

The threat model of the release says what this is worth: controls like these reduce risk and are not a security boundary. Quoting untrusted text does not make it safe for the model reading it.

The hosted-era CLI had four commands over a shared library: one HTTP client, one config loader, one error contract, one output layer, one payment path. Thin commands over a shared core is unglamorous, and it's why the human and agent surfaces couldn't drift apart.

## Free-first, and what the payment rail taught me

Free-first was deliberate. The rail stayed on the wire as an over-quota path and stayed out of every adoption-path surface.

The anonymous tier ran at 50 discovery workflows per day per IP, no key, no account. Rate-limit headers reported which principal bucket the request had spent from, anonymous IP, verified wallet or partner allocation, so an agent could reason about which identity it was operating under. Sign-in-with-wallet raised the tier without an account system: a nonce endpoint, a verification endpoint, a shared principal resolver wired through rate limiting and the paid fallback. No email, no password, no dashboard. The wallet was the only identity. It worked.

The paid path was exercised live: three paid calls, one over REST and two over MCP, six-tenths of a cent in total, all three settled on-chain. Only the REST leg completed the full path through to the settlement ledger. The MCP legs returned paid results, but their ledger transition was slow and unreliable in a serverless environment and was never signed off. One settlement captured on-chain stayed marked pending in my database; I never finished reconciling it.

The economic finding is the useful part. At two-tenths of a cent per workflow, with the facilitator charging a tenth of a cent per transaction beyond a free monthly allowance, roughly half of gross revenue per call went to facilitator cost. Micropayment rails are mechanically impressive and, at this price point, structurally unattractive as a steady-state model. That's the economics behind why payment stayed a rail.

Not shipped: a credits model, a deeper paid inspection endpoint, and general availability of the paid MCP path.

## Fail-closed error contracts

Every error used one envelope: code, message, a retriability flag, a retry delay, optional structured details. Making retriability published data rather than something an agent infers from a status code removed a whole class of guesswork.

There were thirteen error codes, defined as a single constant array so a contract test could iterate the runtime values and assert each one appears in the published OpenAPI enum. Where ambiguity would cost an agent a wasted retry loop, I sub-classified: an invalid query id resolved to expired, mismatched or unknown.

My own spec put it plainly: if payments were disabled service-side, free-tier exhaustion returned `RATE_LIMITED` with HTTP 402 and no payment challenge, and callers were told to branch on the code, not the status. Transport-level signals are ambiguous. A contract-level code is not.

Boundary translation was a real bug class. My code duck-typed on a property that an upstream provider SDK's error objects never carried, so the translation layer never fired once, and genuine upstream throttles reached callers as non-retriable client errors. The bug was mine, not the provider's. The fix was to classify at the boundary and translate into my own vocabulary.

Fail-closed under shared-state unavailability was tested explicitly across REST and MCP, including the paths that must never fall through to payment verification or to serving content. The counterweight: on the pipeline side, fail-closed guards false-failed my own happy path three times, on three different guards. Correct, and not free.

## Observability, and bounded paid work

My operating rule: a job that runs green while silently wrong is two bugs, the wrong behaviour and the missing detector. Alerts were specific thresholds, not uptime checks: no successful sync in 36 hours, total skills dropping more than 5%, embedding coverage under 80%, safety coverage under 50%, a sync run that stored nothing.

The dead-man switch is the pattern worth copying. A watchdog ran daily inside CI, but the detector for the watchdog lived outside it: an external ping service that alerts when the daily success ping doesn't arrive. Inside the job, the courtesy notification runs first and never blocks; the success ping runs last, so only a run that actually completed can send it. An absence detector hosted by the thing it monitors isn't an absence detector.

Paid work was bounded by an explicit cost cap. When the cap engages, the run records that it was hit and exits successfully on purpose. A guardrail firing is not a failure, so nobody gets paged. It counts estimated cost from a pinned pricing table, so a price change can let real spend exceed it until the table is updated (a test fails loudly when prices rotate), and calls that time out bill outside its accounting. The same discipline covered evaluation work: a $25 ceiling on the label-drafting harness, against which the whole arc came in at $4.24.

One detector shipped dormant. I built an absence-detector for settlements stuck pending, wired it onto the twice-daily alerter later, and my runbook kept calling it dormant long after it was live. A stale runbook is the same failure class as a silently-wrong job.

## What should, and shouldn't, need central state

This is the question the whole project ended up answering, and the answer is cleaner than I expected: verification wants no central state; ranking and quota do.

The hosted verification endpoint needed only a content hash, which is why the idea survives as a local command with zero hosted dependency. The two aren't the same check: the 0.1 `check` compares a whole artifact against an approval record covering paths, contents and executable bits, rather than looking a single hash up in an index.

Ranking genuinely needed the index: semantic relevance combined with community signals, freshness decay and publisher trust. None of that is computable on one laptop.

Quota was the state that hurt. Moving shared quota state from process memory into the database was correct (in-memory quota across serverless instances is a real correctness bug) and it cost about 500 ms at the 95th percentile against a budget of 100. That failed my own latency gate. I recorded it as a failure and an explicit re-baseline rather than reinterpreting the gate. The probe I'd run beforehand had looked fine, because it measured database compute rather than the network hop where the cost lived. Probes measure what you point them at.

One strategic note. The hardest review I got located the durable business in the hosted longitudinal record, what only a service that watches over time can produce, and called local point-in-time work crowded and increasingly free. Keeping the stateless half is a defensible engineering decision and a deliberate commercial retreat. Both are true.

So the release keeps only the stateless half: three local commands over local paths, no hosted index, no hosted component of any kind. Other projects hash skill directories, run update checks and produce diffs too. What Sigildex keeps is the record of what a human approved and a deterministic way to notice when that stops matching reality.

The record proves that the approved bytes are unchanged, and nothing more. It doesn't certify that a skill is safe and it doesn't verify where a skill came from. How it fits beside the scanners and installers you already use is in the [README](../README.md).
