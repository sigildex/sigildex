# Postmortem: building and rebuilding an index of agent skills

*Prepared for the 0.1 release, 2026-08. Figures come from the project's own records; estimates and gaps are marked as such. Nothing described here is callable — the endpoints, the index, and the payment rail are retired; the current project is the local command-line tool in the [README](../README.md). **Shipped** ran in production; **Experiment** was built and measured but never validated by adoption; **Abandoned** was designed or partly built and never shipped.*

We could not finish a clean rebuild of the index.

Sigildex was a hosted, agent-first trust preflight for agent skills. Agents called an API to find a candidate skill, inspect it before install, and verify an installed copy by content hash. That system is retired, and this open-source release closes the project.

The rebuild was fired four times in the first week of June 2026, then eleven more times between mid-June and 10 July. Each attempt exposed a distinct defect, generally deeper than the last, though two later runs regressed to earlier cache-gate failures. When a build finally completed, the instrument we would have used to sign it off had silently rotted.

Our own production evidence said the remaining work was open-ended, so we closed the project with the parts that survive without an index. Every failure below had a mechanism, and most were absence-detection failures before they were correctness failures.

## What we set out to build

The product was headless: a REST API, an MCP server, and a static page. No UI, no accounts, three operations. On 1 July 2026 we settled on a free-first trust preflight — the safety path was never behind a paywall; payment existed only as an over-quota rail. The wedge was selection-time trust, above the catalog layer and distinct from install-time scanners.

**Shipped.** Safety scoring was a launch blocker, not a feature. A three-layer pass ran over roughly 94,000 skills — 85.6% safe, 5.4% caution, 1.8% warning, 2.1% dangerous; those four shares do not account for the whole corpus in our record. The initial bulk run covered 88,903 skills for about $100 in model spend.

## The corpus we tried to index

We drew from two sources: a seed-and-expand crawl of GitHub and a second public registry with roughly 36,000 entries, which we later froze. When we stopped, the raw skills table held 201,463 rows — 197,495 live, 3,968 tombstoned. No row had been created since 14 July 2026, and the newest crawled content dated from 1 June.

One caution, because we got it wrong ourselves first: the 128,747 that appears throughout our records is a *filtered serving count* of active GitHub-sourced rows, not the raw table total.

That serving corpus was a textbook power law: 4,034 repositories holding 128,747 skills, with 19 repositories accounting for about 46% of the index. Content-hash comparison put a number on the duplication — 97,735 distinct hashes, so roughly a quarter of rows were byte-identical duplicates, 32,215 of them verbatim copies of a skill in another repository.

Size did not indicate authority. The canonical vendor repositories were small — 18 skills in one, 66 in another — while the giant ones were aggregators, mirrors, and marketplaces. The final staging build we completed reached 84,769 active rows across roughly 16,456 repositories, fully scored and embedded. **Abandoned:** it was never cut over into service.

## Why crawling agent skills was harder than we expected

The central product constraint was that large does not mean bad. A legitimate publisher can ship thousands of canonical skills, so every size cap had to be a circuit breaker routing a repository to review, never a quality verdict.

The fourth of the first attempts was killed by a single mega-aggregator repository — roughly 53,000 files and 163 MB, self-described as a registry of thousands of skills collected from hundreds of upstream repositories. It burned multiple rate-limit budgets with no completion in sight.

Killing it recovered nothing. The crawl had no intra-run resumability, only a single end-of-run checkpoint written on clean completion. A full crawl took two to two and a half days; a killed one started over.

Earlier attempts were more mundane and no less expensive: one died about 20 hours in when the process ran out of memory, another on a single row with an empty content hash that was not even in the run's own scope.

The mirrors also split a rule we had thought was simple. We had decided not to deduplicate, since the same skill on two platforms is a positive trust signal. That does not extend to verbatim mirror copies inside one platform, so mirror suppression had to run before the write — preferring the canonical copy, logging every suppression.

**Shipped:** the first phase of crawler hardening alone was seven separate restart-blocking pieces of work, each taken through a full two-model review.

## Failure modes worth publishing

**An edge firewall rejected content, deterministically.** Our managed database's REST endpoint sits behind an edge firewall. Two rows out of 85,137 were blocked at insert with a 403 because their content was attack-shaped: both were load-testing skills. We reproduced the block 48 hours later with a zero-cost probe; a benign control request passed. Both layers behaved as documented. Our first classification — transient upstream errors — was wrong, and we corrected the record.

**The probe that should have caught it had been dead since the day it shipped.** The dry run's insertability probe relied on a transaction-rollback request preference this REST layer does not honor by default, so all 15,055 probe attempts fell back to a warning-level no-op. The dry run "passed" those two rows because it never posted their content — a component that was green, useless, and unmonitored for its entire life.

**A timeout inherited from a different execution environment.** The last attempt was the first to reach the paid safety pass. It died at roughly 15% of it, on a six-hour default timeout carried over from an earlier CI-based execution model; the pass needed an estimated 35 hours at roughly 2,600 rows per hour. Real spend was about $23, the cost cap never engaged, and the live corpus was untouched.

**Fail-closed guards that false-failed the happy path.** One run cleared the entire crawl for the first time — 82,974 staged rows — then fail-closed at zero cost when a recovery-band counter read 30 where the band expected 200 to 3,000. The counter lived in memory and undercounted: checkpoint-skipped repositories bypassed the code path that increments it. Pre-run guards separately false-fired on three legitimate dry runs, each time a *different* guard. Fail-closed is the right default and it is expensive; both halves are true.

**A text-encoding storm on the write path.** One run hit a deterministic ~51% write-failure rate: a NUL byte reaching a JSONB column, root-caused to UTF-16-LE dependency files being decoded as UTF-8. Production had a sanitizer for exactly this; the staging write path did not.

**Dying at the finish line.** This hit three times. One run completed a full crawl of about 25 hours, then failed on four transient authentication errors. Our first hypothesis — the classifier did not treat those as retryable — was wrong: it did. The defect was a retry *coverage* gap; the helper was wired onto some request paths and not others.

**Staleness.** The evaluation baseline carried an explicit stale-snapshot flag, and regenerating it from scratch ten days after the previous copy returned bit-identical numbers — a maximum absolute delta of 0.00000000 across all eleven metrics. The corpus had stopped moving, and it never moved again.

## How a complete build was invalidated by its own instrument

After the timeout death we salvaged the build rather than re-firing, and it worked: the staging table came out fully populated, with every quality gate up to vendor presence passing. The build looked done.

Then the retrieval evaluation collapsed. NDCG@10 fell from 0.6333 to 0.122; the rate of queries returning nothing relevant went from 0.0755 to 0.528; the rate of confidently-returned-but-unexpected results hit 1.000.

The diagnosis, chosen against two competing hypotheses, was instrument invalidity, not a retrieval regression. Our golden set held 63 queries and 293 labels, 232 of them graded relevant, calibrated in May against a *mixed* corpus from both sources across roughly 4,000 repositories. The launch corpus was single-source and much larger. Sixty-two of the 232 relevant labels pointed at rows from the second registry, which the launch corpus by definition did not contain — structurally unreachable.

The deeper defect was the join key. Of the 170 remaining relevant labels, only 44 could be recovered by the database's own row ID — and only because that rebuild happened to carry IDs forward keyed on the skill's location, which no rebuild guarantees. Content hash recovered 49, crediting five byte-identical survivors the ID join could not see.

A rebuilt golden set that kept joining on mutable row IDs would have died at the next rebuild too. The index was not what had rotted. The instrument measuring it was.

## What fail-closed design actually bought

Every one of those failures cost either nothing or about $23, and none touched the live corpus. That is not luck. It is the payoff of refusing to build a salvage path next to a paid spend, gating spend behind checks that stop the run rather than warn, and diffing fire-time inputs byte-for-byte as immutable artifacts before every run.

**Shipped as tooling.** When we rebuilt the evaluation instrument, the integrity machinery came first, before a single label was generated: candidate pools bracketed by a corpus hash taken before and after capture; a completeness gate bound to its inputs, not to anyone's say-so; a required, deterministic, digest-derived blind sample of items graded zero, which makes cherry-picking structurally impossible; an immutable $25 spend ceiling; and prompt-injection fencing on skill content.

One detail made all of it work: the content hash was computed over a shared raw seam, so sanitizing surrounding fields never perturbed a clean row's hash.

## How a 300-item estimate became 986

The plan to rebuild the golden set was agreed with an accepted human workload of roughly 230 to 300 labels and a pre-declared threshold for unsafe exposure. The machine side went well: a candidate pool of 63 queries and 3,194 query-skill pairs, bracketed against the 84,769-row corpus, drafted with zero errors for $2.12. The whole relabeling step ran to $4.24 of model spend against the $25 ceiling.

The human workload is what exploded. A second, independent read of the first batch of labeling decisions found two real problems: the proposed slate had quietly narrowed the labeling populations the plan specified, and had dropped an entire channel — manually seeded retrieval misses — that existed precisely to measure what retrieval never surfaced. Rather than quietly reinterpret the plan, we made a written change to it and agreed to it again.

The resulting mandatory workload was 986 items after deduplication, drawn from five populations: 373 slate items, 279 items where repeated model votes disagreed, 215 safety-edge items graded zero, 85 manual seeds, and 105 blind-sample items.

That is more than a three-fold expansion over the estimate, discovered only after the instrument had been rebuilt. When we closed the project, 17 of the 986 had been labeled by a human. **Abandoned** there, and frozen rather than deleted: the instrument, its tooling, and the partial labeling are in a private archive. 986 counts human judgments, not model calls.

## Hardening worked. It also cost us the market test.

The arc trends deeper without being a straight line: attempts died inside the crawl, then at the staging write, then at the crawl finish line, then at the end of the full write pass. Two later runs failed *earlier*, at a pre-spend cache gate, on new guard defects; the last run reached the paid safety pass.

The fixes held where we could observe them: the encoding fix produced zero errors on the next run, the cache-gate floor fix worked live, and the ReDoS guard held under load.

The cost side is equally concrete: twelve review pull requests, two hardening phases, two independent plan reviews, and a whole-repository audit that produced 46 findings — 2 critical, 14 high, 30 medium.

In all of that we collected no external adoption signal. We never ran a market test, so we have no traffic, usage, or retention data of any kind — a gap in our evidence, not a finding about demand. Our own framing had been to let external adoption decide the project's future; the decision arrived before the test did.

The strongest argument for stopping came from an independent review of our own wind-down proposal: a repair that fails three consecutive independent reviews is evidence about the true cost to finish, not reviewer fatigue. "Just finish the labeling" left out the recurring term underneath it — crawl operations, freshness upkeep, hosting bills, keeping public claims true as the corpus drifts, and being on call for all of it, indefinitely, alone.

The same review supplied the fair counter-argument, which stays in the record: a wind-down plan built on optimistic sizing reproduces the failure mode it exists to escape.

## What we would scope differently

**Bind the evaluation instrument to corpus identity from day one.** Joining labels on mutable row IDs was the single defect that invalidated a finished build.

**Make absence detection a per-component shipping requirement.** Every component should answer one question before it ships: what metric goes wrong if this stops working?

**Treat intra-run resumability as a primitive.** The deepest failures discarded 25 to 50 hours of wall clock, largely because finish-line inputs lived only in memory. A staged pipeline where each phase commits durable output turns most failures into progress.

**Never let a timeout from one execution environment govern a job in another.** A six-hour CI default has no business bounding a 35-hour job on a dedicated host.

**Decide corpus quality before chasing corpus scale, and decouple a market test from index completeness.** Nearly half the index sat in 19 aggregator repositories while the size threshold that would have addressed it was still an open product decision — and collecting adoption signal never required a finished rebuild.

One counterweight: the same rigor that made this slow is why model spend stayed at zero on most failed runs and about $23 on the deepest, while no write ever reached the live corpus. The scoping error was in sequencing, not in standards.

## What remains useful without an index

One element of the thesis survived intact: raw-byte content identity over a whole skill package, plus optional, user-declared source metadata (unverified) — no index, no ongoing operation. It is the core of this release: a reviewable record of what a human approved, plus deterministic drift detection a CI job can enforce. The record sits between the scan and the install, and each `check` re-verifies the installed copy against it.

Three process findings transfer beyond this project. Fail-closed error contracts and typed exit codes should be the default for anything an agent drives unattended; an agent cannot infer intent from a bare non-zero exit. Identity-bracketed capture plus digest-bound blind sampling is a cheap, general recipe for benchmark integrity. And a second, independent review of the same change kept finding issues the first one missed — budget for it on anything security-adjacent.

What does not survive: anything requiring a live crawl, a hosted ranking model, or ongoing freshness upkeep. The hosted API, the semantic index, and the crawler are being decommissioned — frozen in a private archive rather than deleted — and no service stays alive to preserve the option of one.

The record proves that the approved bytes are unchanged, and nothing more: it does not certify that a skill is safe, and it does not verify where a skill came from. How it fits beside the scanners and installers you already use is in the [README](../README.md).
