#!/usr/bin/env node
/**
 * Generates the static site from this repository's own sources.
 *
 * Every document the site serves is a byte-for-byte copy of the file that
 * lives in the repository, so the site can never drift from the tool it
 * describes. Only the front page, the routing file, and the small
 * machine-readable files at the root are generated here.
 *
 * Output is deterministic: nothing depends on the clock, the environment, or
 * the order of a directory read. `test/site.test.ts` rebuilds into a temporary
 * directory and compares the result byte-for-byte against the committed
 * `site/`, which is what proves the committed copy is current.
 *
 * Usage: node scripts/build-site.mjs [output-directory]   (default: site)
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The origin every absolute site URL is built from. */
const ORIGIN = "https://sigildex.ai";

/**
 * Fixed expiry for `.well-known/security.txt`, one year from the release of
 * this page. Hard-coded rather than computed so two builds on two days produce
 * identical bytes; bump it by hand when it approaches.
 */
const SECURITY_TXT_EXPIRES = "2027-08-16T00:00:00.000Z";

/**
 * Repository file -> site path. These are copied verbatim, never rewritten.
 * `schema/` is expanded from the directory listing so a new schema is served
 * without editing this table.
 */
const COPIES = [
  ["llms.txt", "llms.txt"],
  ["skills/sigildex/SKILL.md", "SKILL.md"],
  ["docs/identity-spec.md", "identity-spec.md"],
  ["docs/safe-skill-adoption.md", "safe-skill-adoption.md"],
  ["docs/threat-model.md", "threat-model.md"],
  ["SECURITY.md", "security.md"],
  ["docs/postmortem.md", "postmortem.md"],
  ["docs/case-study.md", "case-study.md"],
  ["README.md", "README.md"],
];

/** Hosted paths that no longer exist, answered with 410 and a JSON body. */
const RETIRED_PATHS = [
  ["/discover", "^/discover/?$"],
  ["/inspect", "^/inspect/?$"],
  ["/verify", "^/verify/?$"],
  ["/mcp", "^/mcp/?$"],
  ["/health", "^/health/?$"],
  ["/prices", "^/prices/?$"],
  ["/openapi.json", "^/openapi\\.json$"],
  ["/llms-full.txt", "^/llms-full\\.txt$"],
  ["/.well-known/x402.json", "^/\\.well-known/x402\\.json$"],
  ["/.well-known/mcp.json", "^/\\.well-known/mcp\\.json$"],
  ["/.well-known/agent-pricing.json", "^/\\.well-known/agent-pricing\\.json$"],
  ["/api(/.*)?", "^/api(/.*)?$"],
  ["/v1(/.*)?", "^/v1(/.*)?$"],
];

/** Legacy human pages, permanently folded into the front page. */
const REDIRECTED_PATHS = ["^/about/?$", "^/docs(/.*)?$", "^/legal(/.*)?$"];

/** The captured terminal transcript shown on the front page. */
const DEMO_TRANSCRIPT = `$ sigildex lock skill-v1 --approval-id log-summarizer --out log-summarizer.lock.json
Locked skill-v1
  approval id:            log-summarizer
  root digest:            sha256:d445576462862500bd9537c93fc2390802d97bf3df13879a9b83cc21e04890ad
  files:                  2
  frontmatter:            ok
    name:                 log-summarizer
    description:          Summarize a plain-text application log into a short incident report — error counts, the first and last timestamp seen, and the most frequent messages. Use when …
  written to:             log-summarizer.lock.json
This records byte identity only. It does not attest safety, provenance, or future content.
$ echo $?
0

$ sigildex check skill-v1 --against log-summarizer.lock.json
Match: the artifact matches approval record log-summarizer.
  root digest:            sha256:d445576462862500bd9537c93fc2390802d97bf3df13879a9b83cc21e04890ad
  files:                  2
This records byte identity only. It does not attest safety, provenance, or future content.
$ echo $?
0

$ sigildex check skill-v2 --against log-summarizer.lock.json
Drift: the artifact no longer matches the approval record (1 added, 0 removed, 1 modified, 0 mode-changed).
  approved root digest:   sha256:d445576462862500bd9537c93fc2390802d97bf3df13879a9b83cc21e04890ad
  actual root digest:     sha256:0b0bec0d4e4435beed62b983c530f4f8249e7b1af01d31fbb8be1989d94cf1c6

  + scripts/summarize.sh (script)
  ~ SKILL.md (instructions)

Review the changes and re-lock only after approving them.
$ echo $?
2`;

/** Escapes the five characters that change meaning inside HTML markup. */
function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The one page a human reads. No scripts, no external requests, no tracking. */
function indexHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sigildex — know what changed in an Agent Skill</title>
<meta name="description" content="Sigildex is an open-source, local workflow for recording the exact Agent Skill you reviewed, detecting artifact drift, and focusing human or agent review on the files and capabilities that changed.">
<meta name="color-scheme" content="light dark">
<style>
:root {
  --bg: #ffffff;
  --fg: #16181d;
  --muted: #5b6270;
  --rule: #e2e5ea;
  --surface: #f6f7f9;
  --accent: #1a4fd6;
  --code-bg: #14161b;
  --code-fg: #e6e8ec;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #101216;
    --fg: #e7e9ee;
    --muted: #9aa2b1;
    --rule: #262a32;
    --surface: #181b21;
    --accent: #8fb0ff;
    --code-bg: #06070a;
    --code-fg: #dfe2e8;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  padding: 0 1.25rem 5rem;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
main { max-width: 46rem; margin: 0 auto; }
header { padding: 4rem 0 0; }
h1 { font-size: clamp(1.7rem, 5vw, 2.5rem); line-height: 1.2; margin: 0 0 1rem; letter-spacing: -0.02em; }
h2 { font-size: 1.15rem; margin: 3.25rem 0 0.75rem; letter-spacing: -0.01em; }
p { margin: 0 0 1rem; }
a { color: var(--accent); }
.lead { font-size: 1.1rem; color: var(--fg); }
.muted { color: var(--muted); }
.positioning {
  margin: 1.5rem 0 0;
  padding: 1rem 1.15rem;
  background: var(--surface);
  border-left: 3px solid var(--accent);
  border-radius: 0 6px 6px 0;
}
.workflow {
  margin: 0;
  padding: 0.9rem 1.15rem;
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 6px;
  font-size: 0.95rem;
}
pre {
  margin: 0;
  padding: 1rem 1.15rem;
  background: var(--code-bg);
  color: var(--code-fg);
  border-radius: 6px;
  overflow-x: auto;
  font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; min-width: 36rem; font-size: 0.92rem; }
th, td { text-align: left; vertical-align: top; padding: 0.6rem 0.7rem; border-bottom: 1px solid var(--rule); }
th { font-weight: 600; }
tr.here { background: var(--surface); }
ul { margin: 0 0 1rem; padding-left: 1.25rem; }
li { margin: 0.3rem 0; }
footer { margin-top: 3.5rem; padding-top: 1.25rem; border-top: 1px solid var(--rule); font-size: 0.9rem; color: var(--muted); }
</style>
</head>
<body>
<main>

<header>
  <h1>Know what changed in an Agent Skill before you trust the update.</h1>
  <p class="lead">Sigildex is an open-source, local workflow for recording the exact Agent Skill you reviewed, detecting artifact drift, and focusing human or agent review on the files and capabilities that changed. It runs without an API, account, database, or LLM. Sigildex complements security scanners; it does not certify that a skill is safe.</p>
</header>

<section id="positioning">
  <p class="positioning">Sigildex does not replace discovery, security scanning, or human review. It connects them into a durable workflow by recording exactly what was approved and detecting when that artifact changes.</p>
</section>

<section id="workflow">
  <h2>The workflow</h2>
  <p class="workflow">Discover → stage → inspect/scan → human review → record approval → install &amp; verify → detect update → quarantine → diff → re-approve</p>
</section>

<section id="demo">
  <h2>You approved a skill. Then it changed.</h2>
  <pre>${escapeHtml(DEMO_TRANSCRIPT)}</pre>
  <p class="muted" style="margin-top:1rem">An update added an executable script where the approved version had none, and rewrote the instructions to call it. <code>sigildex diff</code> shows exactly what changed. A human decides whether to approve it.</p>
</section>

<section id="ecosystem">
  <h2>Where Sigildex sits</h2>
  <div class="table-wrap">
  <table>
    <thead>
      <tr><th>Stage</th><th>What it does</th><th>Examples</th><th>Sigildex</th></tr>
    </thead>
    <tbody>
      <tr>
        <td>Discovery</td>
        <td>Find candidate skills</td>
        <td>GitHub CLI <code>gh skill</code>, Vercel Skills CLI, publisher catalogs</td>
        <td>Not this</td>
      </tr>
      <tr>
        <td>Scanning</td>
        <td>Produce evidence about a candidate — patterns, injection risk, secrets</td>
        <td>NVIDIA SkillSpector, Cisco AI Defense Skill Scanner, Snyk Agent Scan</td>
        <td>Not this</td>
      </tr>
      <tr>
        <td>Human review</td>
        <td>Decide whether the skill belongs in your environment</td>
        <td>You</td>
        <td>Not this</td>
      </tr>
      <tr class="here">
        <td><strong>Approval record</strong></td>
        <td><strong>Record exactly what was approved, and detect when it changes</strong></td>
        <td></td>
        <td><strong>This</strong></td>
      </tr>
      <tr>
        <td>Installation &amp; updates</td>
        <td>Put skills on disk; report when upstream moves</td>
        <td>Package managers and skill installers</td>
        <td>Not this</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p class="muted" style="margin-top:1rem">Each stage is someone else's job, and they are all better at it than a single tool would be. The gap is between them: what you approved is no longer what is installed, and nobody noticed. That is the gap Sigildex closes.</p>
</section>

<section id="agent">
  <h2>Use it with your agent</h2>
  <p>Sigildex ships an Agent Skill that runs the whole loop under hard boundaries: it stages candidates in quarantine, offers scanner commands, presents the review checklist, and summarizes what it finds — then stops and asks you. It never infers approval from a clean scan, never installs without your explicit approval, and refuses to activate an artifact that does not match its approval baseline. These controls reduce risk; they are not a security boundary.</p>
  <ul>
    <li><a href="${ORIGIN}/SKILL.md">Agent Skill</a> — drop it into your agent's active skills directory.</li>
    <li><a href="${ORIGIN}/llms.txt">Machine-readable front door</a> — point an agent at this file and it can navigate the whole project.</li>
    <li><a href="https://github.com/sigildex/sigildex/blob/main/skills/sigildex/SKILL.md">The same Agent Skill in the repository</a> — <code>skills/sigildex/SKILL.md</code>.</li>
  </ul>
</section>

<section id="links">
  <h2>Links</h2>
  <ul>
    <li><a href="https://github.com/sigildex/sigildex">Repository</a></li>
    <li><a href="https://github.com/sigildex/sigildex/blob/main/README.md">README quickstart</a></li>
    <li><a href="https://github.com/sigildex/sigildex/blob/main/docs/safe-skill-adoption.md">Safe skill adoption guide</a></li>
    <li><a href="https://github.com/sigildex/sigildex/blob/main/docs/identity-spec.md">Identity specification</a></li>
    <li><a href="https://github.com/sigildex/sigildex/blob/main/skills/sigildex/SKILL.md">Agent Skill</a></li>
    <li><a href="https://github.com/sigildex/sigildex/blob/main/docs/case-study.md">Architecture case study: building an agent-first system</a></li>
    <li><a href="https://github.com/sigildex/sigildex/blob/main/docs/postmortem.md">Postmortem: what the crawl and rebuild actually cost</a></li>
  </ul>
</section>

<section id="status">
  <h2>Where this stands</h2>
  <p>Sigildex v0.1 is open source and local-first. It runs on macOS and Linux, reads only the paths you give it, and makes no network calls.</p>
  <p>v0.1 is not published yet; it will be published to npm as <code>sigildex</code>, and until then you build it from the <a href="https://github.com/sigildex/sigildex/blob/main/README.md">repository</a>.</p>
  <p>There is no hosted index, no discovery API, and no publisher-monitoring service. Update detection is read-only and something you or your CI runs on purpose — never automatic.</p>
  <p>Sigildex does not certify that a skill is safe, and it does not verify where a skill came from. An approval record is a review snapshot: it records the exact bytes you designated as approved, and tells you when they change. Pair it with security scanning and human review appropriate to your environment.</p>
  <p>It also does not police your approvals directory. <code>lock</code> refuses to write a record under any name but <code>&lt;approval-id&gt;.lock.json</code>, and <code>check</code> compares one artifact against one record — but nothing in v0.1 scans a folder of approvals for duplicate ids, duplicate artifact paths, or records left behind without their artifact. Code owners and review cover that.</p>
</section>

<footer>
  The repository is the canonical source of truth. This page is a front door, generated from the repository's own files.
</footer>

</main>
</body>
</html>
`;
}

function robotsTxt() {
  return `User-agent: *
Allow: /

Sitemap: ${ORIGIN}/sitemap.xml
`;
}

function sitemapXml(paths) {
  const entries = paths.map((path) => `  <url><loc>${ORIGIN}${path}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
}

function securityTxt() {
  return `Contact: https://github.com/sigildex/sigildex/security/advisories/new
Policy: https://github.com/sigildex/sigildex/blob/main/SECURITY.md
Canonical: ${ORIGIN}/.well-known/security.txt
Expires: ${SECURITY_TXT_EXPIRES}
Preferred-Languages: en
`;
}

function retiredJson() {
  return `${JSON.stringify(
    {
      status: 410,
      message: "This hosted endpoint has been retired. Sigildex is now an open-source local tool.",
      see: `${ORIGIN}/llms.txt`,
      repository: "https://github.com/sigildex/sigildex",
    },
    null,
    2,
  )}\n`;
}

/**
 * Static hosting configuration.
 *
 * The legacy `routes` array is used on its own — it is the only form that can
 * answer a request with 410 and a body without a serverless function, and the
 * platform forbids mixing it with `rewrites`, `redirects`, `headers`, or
 * `cleanUrls`. Order matters: content-type headers continue past their match,
 * the filesystem handle then lets every real file win, and only paths with no
 * file behind them reach the retirement rules.
 */
function vercelJson() {
  const routes = [
    {
      src: "^/(.*)\\.md$",
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
      continue: true,
    },
    {
      src: "^/(llms\\.txt|robots\\.txt|\\.well-known/security\\.txt)$",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      continue: true,
    },
    { handle: "filesystem" },
    ...RETIRED_PATHS.map(([, src]) => ({
      src,
      dest: "/retired.json",
      status: 410,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex",
      },
    })),
    ...REDIRECTED_PATHS.map((src) => ({
      src,
      status: 308,
      headers: { Location: "/" },
    })),
  ];
  return `${JSON.stringify({ $schema: "https://openapi.vercel.sh/vercel.json", routes }, null, 2)}\n`;
}

/** Writes `relativePath` under `outDir`, creating parent directories. */
async function emit(outDir, relativePath, contents) {
  const target = join(outDir, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

/**
 * Builds the whole site into `outDir`, replacing whatever was there.
 * Returns the site-relative paths written, sorted.
 */
export async function buildSite(outDir = join(repositoryRoot, "site")) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const written = [];
  const copies = [...COPIES];
  const schemaFiles = (await readdir(join(repositoryRoot, "schema")))
    .filter((name) => name.endsWith(".schema.json"))
    .sort();
  for (const name of schemaFiles) copies.push([`schema/${name}`, `schema/${name}`]);

  for (const [source, destination] of copies) {
    await emit(outDir, destination, await readFile(join(repositoryRoot, source)));
    written.push(destination);
  }

  const generated = [
    ["index.html", indexHtml()],
    ["robots.txt", robotsTxt()],
    ["sitemap.xml", sitemapXml(["/", ...copies.map(([, destination]) => `/${destination}`)])],
    [".well-known/security.txt", securityTxt()],
    ["retired.json", retiredJson()],
    ["vercel.json", vercelJson()],
  ];
  for (const [destination, contents] of generated) {
    await emit(outDir, destination, contents);
    written.push(destination);
  }

  return written.sort();
}

/** Site-relative paths that must exist for every documented URL to resolve. */
export const COPIED_FILES = COPIES.map(([source, destination]) => ({ source, destination }));
export const RETIRED_ROUTE_PATHS = RETIRED_PATHS.map(([path]) => path);

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2] === undefined ? undefined : join(process.cwd(), process.argv[2]);
  const files = await buildSite(target);
  process.stdout.write(`wrote ${files.length} files\n`);
}
