# Postmortem: building an index of agent skills, and shipping without one

*Written for the 0.1 release, August 2026. Figures come from the project's own records; estimates are marked. Nothing described here is callable. The hosted API, the index and the payment rail have been shut down. What remains is the local command-line tool in the [README](../README.md).*

Sigildex started in April 2026 as a side project: a hosted "trust preflight" for agent skills, an API and MCP server that let an agent find a skill, inspect it before install, and verify the installed copy by content hash. It grew past what I'd planned. By August it was about 160K lines of TypeScript, 200+ test files, 73 database migrations, and a raw skills table of 201,463 rows. I'm winding it down and shipping the one piece that stands on its own: a small CLI that records exactly which bytes a human approved and tells you when the installed copy drifts.

I had three goals going in: build something useful for agents; get more hands-on experience building with frontier coding agents and harnesses; and experiment with the emerging agentic payments space, x402 in particular. The first ended up smaller than the pitch. The second paid off more than I expected. The third I only got to start. Here is how it went.

## The idea

The pitch in April was simple. Agents were starting to install skills (a `SKILL.md` plus supporting files) from GitHub and from registries, and nothing sat between "found it" and "installed it." I wanted a headless service that did three things: discover, inspect, verify. No UI, no accounts. The wallet would be the identity and every call would settle for a fraction of a cent over x402. Two sources to start: a seed-and-expand crawl of GitHub, and ClawHub, the registry for OpenClaw agents.

The first index was built within a couple of days: 78,394 skills, 37,604 from GitHub and 40,790 from ClawHub. Payments were gated on every endpoint a few days after that. That part took a week. Everything after it turned out to be more complicated than expected.

## ClawHub, and where discovery actually starts

My original plan for ClawHub was to make its OpenClaw skills usable everywhere: adapt them to the shared `SKILL.md` format so Claude Code, Codex, OpenCode and the rest could pull from the same pool.

Two things killed that. The first was that format adaptation isn't a product. The ecosystem had already converged on one skill spec (agentskills.io); OpenClaw's additions live in a `metadata` block that other platforms simply ignore, so an OpenClaw skill is already a valid skill everywhere. There was nothing to translate. The second was more important: OpenClaw agents start and finish their skill discovery inside ClawHub. `openclaw skills search`, `install` and `update` are native, and ClawHub already accepts skills written for other platforms. Nobody in that loop was going to route through a third-party index. Whatever traffic Sigildex got would come from non-OpenClaw agents.

So at the end of April I decided to focus on those agents and froze the ClawHub source at its last good sync. The public API defaulted to GitHub-only from then on. Roughly 80% of the segmentation design I'd been planning fell away, and I kept the crawler code in case I ever wanted it back. I never did.

## Inspection and verification were the interesting part

Safety was a launch blocker from the start: an index that recommends a malicious skill is worse than no index. Scoring ran in three layers, cheapest first. Known signals from the data already in the database (audits, whether the skill executes code) cost nothing. Regex patterns for prompt injection, exfiltration URLs, destructive commands and credential harvesting cost nothing. Only then did a model read the skill: a small, fast model screened everything, and only skills it flagged escalated to a larger one. Everything was keyed by content hash, so unchanged skills were never re-scored. The first bulk pass covered 88,903 skills for about $100 in model spend, against an $18 estimate. System-prompt overhead and escalation volume ate the difference, and that gap is why every later paid job ran under a hard cost cap. Across the ~94K skills scored, 85.6% came back safe, 5.4% caution, 1.8% warning, and 2.1% flagged dangerous by the pipeline (those four shares don't account for the whole corpus in my records).

By June the shape of the product had shifted. The verdicts were the durable asset. The rows were inventory. A verdict keyed by content hash is tiny, append-only and never stale, and it works whether or not you found the skill through me. In early July I wrote that down as the direction: a free-first trust preflight, with curated discovery as the front door and verification as the primitive. The safety path was never behind a paywall; payment stayed on the wire as an over-quota rail and dropped out of the pitch.

I still wanted to launch with an index. A curated one this time: GitHub only, rebuilt from scratch, sized for quality rather than count, and expanded over time. That rebuild is where most of the summer went.

## What the rebuild taught me

The serving corpus was 128,747 GitHub skills across 4,034 repositories, and it was a textbook power law. Nineteen repositories held about 46% of it. Content-hash comparison found 97,735 distinct hashes, so roughly a quarter of the rows were byte-identical duplicates, 32,215 of them verbatim copies of a skill in another repository. Size said nothing about authority: the canonical vendor repos held 18 and 66 skills, while the giants were aggregators, mirrors and marketplaces.

I fired the rebuild four times in early June and eleven more times between mid-June and mid-July. Most attempts died on a new defect, usually deeper than the last. The ones worth sharing:

- One aggregator repository (~53,000 files, 163 MB, a registry that collects thousands of skills from hundreds of upstream repos) burned through several rate-limit budgets with no end in sight. Killing it recovered nothing, because the crawl only checkpointed on clean completion. A full crawl took two to two and a half days.
- Two rows out of 85,137 were rejected at insert with a 403: a web-application firewall in front of the database read their content (both were load-testing skills) as an attack. Fair enough. The real problem was that my dry run should have caught it and didn't. Its insert probe relied on a rollback header the REST layer ignores, so all 15,055 probe attempts had quietly been no-ops since the day it shipped.
- The deepest run reached the paid safety pass for the first time, then died about 15% in on a six-hour default timeout inherited from an earlier CI-based setup. The pass was estimated to need ~35 hours at ~2,600 rows an hour. Spend: about $23.
- A NUL byte reached a JSONB column (UTF-16 dependency files decoded as UTF-8), turning ~51% of writes into failures. Production had a sanitizer for exactly this. The staging path didn't.

Fail-closed design meant every one of those failures cost either nothing or that $23, and none touched the live index. It also meant a run could clear the entire crawl (82,974 rows staged) and then refuse to proceed because an in-memory counter read 30 where the guard expected 200 to 3,000. Fail-closed is right, and it is expensive.

Eventually I salvaged a complete build: 84,769 skills, fully scored and embedded, every quality gate green until the retrieval evaluation. A word on how I evaluated retrieval. The instrument was a golden set: a few dozen realistic queries, each with the skills a human had graded relevant, drafted by a model and adjudicated by hand, and a standard ranking metric (NDCG@10) that scores how high the relevant skills land in the top ten. Then the eval collapsed. NDCG@10 went from 0.633 to 0.122. The index wasn't broken. The instrument was. The golden set dated from May and its labels were joined to skills by database row ID, which a rebuild doesn't preserve; of the labels still in scope, only 44 of 170 could be recovered by that key. Rebuilding the golden set properly came out at 986 human labeling decisions. I had done 17 when I stopped.

## The payments experiment I didn't get to

The part I most wanted to build going in was the merchant side: a service with no signup, no API key and no invoice, where an agent pays per call and the wallet is the identity. That shipped. x402 on Base with USDC through the Coinbase facilitator, $0.002 per query, gated on REST and MCP, with a Sign-In-With-X lane so a wallet could hold a higher free tier without an account. In early July I ran it end to end for real: an agent discovered skills through the API, paid per call in USDC, and every payment settled on-chain.

What I didn't do was innovate on it. I'd wanted to find out what a truly headless merchant looks like once a second rail (Stripe's Machine Payments Protocol) sits next to x402, and I'd done the research: support both, and neither one solves agent identity, metering or reconciliation for you. Then reality. Real x402 volume was still small in mid-2026 and I couldn't tell how much of it was organic, so "pay per call" couldn't be the reason anyone adopted this. At my price point the facilitator's per-transaction fee ate about half of each call. And the crawl and rebuild consumed nearly all the engineering attention. Payment stayed a rail. It never became a product.

## The ecosystem filled in around me

While I was planning and running the rebuild, the workflow I had imagined was being built, piece by piece, by other people. NVIDIA published SkillSpector for scanning skill bundles. Vercel's `skills` CLI tracks folder hashes for update detection. GitHub previewed `gh skill` for discovery and install. Cisco shipped a scanner with a reusable GitHub Actions workflow, and Snyk shipped one too. Every new catalog was something to ingest, and point-in-time scanning was crowded and often free.

I was traveling for most of July, and when I got back I decided to pivot to open source and stop. "Just finish the labeling" hides the recurring term underneath it: crawl operations, freshness upkeep, hosting, keeping public claims true as the corpus drifts, on call for all of it, indefinitely, alone. So I timeboxed the exit. Two weeks, bounded, no index to maintain: ship the piece that survives without one, write this down, and turn the hosted service off.

To be honest: beyond talking to a few AI developers I know, I never ran a real market test. I never publicised it, so there is no meaningful traffic, usage or retention data. That is a gap in the evidence, not a finding about demand.

## What ships

Three commands. `sigildex lock` records the exact bytes of a skill a human approved into an approval record you commit beside the code. `sigildex check` verifies the copy that will actually run and exits 2 on drift, so a preflight or CI step can stop there. `sigildex diff` explains, file by file, what changed before you re-approve. Local, deterministic, no network. It records bytes, not trust: it doesn't certify that a skill is safe and it doesn't verify where a skill came from. It sits between the scanners and the installers you already use.

The hosted API, the semantic index and the crawler have been shut down, frozen in a private archive rather than deleted. Nothing stays running to keep the option open.

## Learnings from building for AI agents

Three things I'd carry into any product whose user is an agent.

**An MCP tool result is prompt input.** Author-supplied names and descriptions land straight in a model's context. A skill description containing a newline could forge a verdict line above the real one. So the safety verdict went out as the first line of every result, before any author-controlled string, and inspected content was wrapped in a fence that named it as untrusted, with embedded fence markers neutralised first. Controls like these reduce risk; they are not a security boundary, and I said so in the docs.

**Publish contracts that break the build when they drift.** An agent can't ask a colleague what a doc meant. The `llms.txt`, the OpenAPI document, the MCP descriptor and the skill that wrapped the client were all generated from one source map and never hand-edited, and a linter failed CI when the free-tier limit or version in the published files stopped matching the code. Retriability was published data on every error, not something the agent had to infer from a status code.

**Test with the actual users: spin up agents and watch.** When the user is a program, user research is cheap. A handful of times I pointed fresh agents, on different models from different vendors and with nothing but the entry file, at the product and the agent-facing docs, watched what they did, and asked them what was missing. Every run produced a short list of things a human reader glides past: an install line in the wrong place, a flag rule stated once where it needed to be twice, an exit-code table in the wrong order. I fixed most of them the same day. It's the cheapest usability testing I've done, and it's the part of this I'd repeat first.

## What I'd do differently

**Decide corpus quality before chasing corpus scale.** Nearly half the index sat in 19 aggregator repos while the size threshold that would have fixed it was still an open question.

**Decouple the market test from index completeness.** Collecting adoption signal never required a finished rebuild. I sequenced it as if it did, partly because my other two goals, hands-on building and x402, kept pulling me toward building more.

**Bind the evaluation instrument to corpus identity from day one.** Joining labels on mutable row IDs was the single defect that invalidated a finished build.

**Every component needs a way to show it has stopped working.** The dead probe was green for its whole life. "What goes wrong if this stops working?" should be answered before merge, not after.

**Resumability is a primitive.** The deepest failures threw away 25 to 50 hours of wall clock, largely because finish-line state lived in memory.

Fail-closed is why most failed runs cost nothing and no write ever reached the live corpus. The mistake was sequencing.

## What I got out of it

The second goal is the one that paid off. Most of this was built with two frontier coding agents, one holding continuity and one attacking the work, and Sigildex is where that workflow got refined: plan reviews before implementation, adversarial reviews after, a decisions log that survives context resets, fail-closed gates instead of hopeful instructions. I wrote up the version I had in June ([Two Models Today, Meta-Harnesses Tomorrow](https://jonathanavni.com/blog/two-models-today-meta-harnesses-tomorrow)) and I've kept iterating since. The catches were real: several of the defects above, and a few in the CLI that ships here, were found by the model that didn't write the code.

The third goal I got to start. x402 works, end to end, and I now know what a headless merchant needs that neither rail gives you yet. That's where the next project picks up.

Sigildex didn't become the product I pitched. It made me a much faster builder, and it left me with a clear picture of what to build next.

If you're building trust tooling for agents, or you've walked a similar arc, I'd love to hear from you.
