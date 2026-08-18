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
 * The front page carries no JavaScript and fetches nothing. Both fonts are
 * embedded as base64 `data:` URIs read from `scripts/site-assets/` at build
 * time, and the mark is inline SVG, so the document is the only request a
 * reader's browser makes.
 *
 * Usage: node scripts/build-site.mjs [output-directory]   (default: site)
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The origin every absolute site URL is built from. */
const ORIGIN = "https://sigildex.ai";

/** The repository the front page links back to. */
const REPO = "https://github.com/sigildex/sigildex";
const BLOB = `${REPO}/blob/main`;

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
  ["docs/ci/README.md", "ci/README.md"],
  ["docs/ci/approval-check.yml", "ci/approval-check.yml"],
  // README.md is deliberately not mirrored: the static host does not serve a
  // root README.md, and llms.txt already points at the repository copy. A
  // nested ci/README.md is a different path and is served normally.
];

/**
 * Assets served at a stable URL but not documents, so they stay out of the
 * sitemap. `logo.png` exists because link previews fetch the image from the
 * crawler, not from the page — the page itself still requests nothing.
 * `fonts/GEIST-OFL.txt` is the licence for the two typefaces the page embeds:
 * the OFL requires the licence to travel with the font software, and the page
 * redistributes it as base64, so the site serves the text as well.
 */
const ASSET_COPIES = [
  ["scripts/site-assets/logo-400.png", "logo.png"],
  ["scripts/site-assets/GEIST-OFL.txt", "fonts/GEIST-OFL.txt"],
];

/** The one-line attribution the page and the font licence route point at. */
const FONT_NOTICE = "Geist and Geist Mono, copyright 2024 The Geist Project Authors, SIL Open Font License 1.1";

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

/**
 * The captured terminal transcript shown on the front page. It is real output:
 * `test/transcript.test.ts` replays every command in it against
 * `examples/version-drift` and compares stdout byte for byte.
 */
export const DEMO_TRANSCRIPT = `$ sigildex lock skill-v1 --approval-id log-summarizer --out log-summarizer.lock.json
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

/**
 * The ten stages, in order. `ours` marks the four a Sigildex command does the
 * work in.
 *
 * Escaping convention, here and in `ECOSYSTEM` below: every plain-text field is
 * escaped at render, so it is written here exactly as it should read on the
 * page. Only a field whose name ends in `Html` is emitted as markup.
 */
const WORKFLOW_STAGES = [
  { stage: "Discover", bodyHtml: "Find a candidate with the tools you already use.", who: "Not Sigildex", ours: false },
  {
    stage: "Stage",
    bodyHtml: "Copy it into quarantine outside every active skills directory. Run nothing.",
    who: "Documented",
    ours: false,
  },
  {
    stage: "Inspect / scan",
    bodyHtml: "Scanners produce evidence about the candidate, never a certification.",
    who: "Not Sigildex",
    ours: false,
  },
  {
    stage: "Human review",
    bodyHtml: "A person reads the skill and decides. Nothing automates this.",
    who: "Not Sigildex",
    ours: false,
  },
  {
    stage: "Record approval",
    bodyHtml: "<code>sigildex lock</code> writes the approved bytes to an approval record.",
    who: "Sigildex",
    ours: true,
  },
  {
    stage: "Install & verify",
    bodyHtml:
      "<code>sigildex check</code> the copy that will run. A mismatch exits 2; your preflight or CI gate stops there.",
    who: "Sigildex",
    ours: true,
  },
  {
    stage: "Detect update",
    bodyHtml: "Read-only checks, on demand or on your schedule. Never automatic.",
    who: "Documented",
    ours: false,
  },
  {
    stage: "Quarantine the update",
    bodyHtml: "Stage the update outside the active install, which stays untouched.",
    who: "Documented",
    ours: false,
  },
  {
    stage: "Diff",
    bodyHtml: "<code>sigildex diff</code> reports what changed, per file, by class.",
    who: "Sigildex",
    ours: true,
  },
  {
    stage: "Re-approve",
    bodyHtml: "A human reads the diff; CI and code owners keep it human.",
    who: "Sigildex + repo controls",
    ours: true,
  },
];

/**
 * Where each neighbouring layer sits. `here` marks the one row that is this
 * project. Every URL here has been checked to resolve to the page it names.
 */
const ECOSYSTEM = [
  {
    stage: "Discovery",
    what: "Find candidate skills.",
    examplesHtml:
      'GitHub CLI <a href="https://cli.github.com/"><code>gh skill</code></a>, <a href="https://github.com/vercel-labs/skills">Vercel Skills CLI</a>, publisher catalogs',
    here: false,
  },
  {
    stage: "Scanning",
    what: "Produce evidence about a candidate — patterns, injection risk, secrets.",
    examplesHtml:
      '<a href="https://github.com/NVIDIA/SkillSpector">NVIDIA SkillSpector</a>, <a href="https://github.com/cisco-ai-defense/skill-scanner">Cisco AI Defense Skill Scanner</a>, <a href="https://github.com/snyk/agent-scan">Snyk Agent Scan</a>',
    here: false,
  },
  {
    stage: "Human review",
    what: "Decide whether the skill belongs in your environment.",
    examplesHtml: "You, with the checklist in the adoption guide",
    here: false,
  },
  {
    stage: "Approval record",
    what: "Record exactly what was approved, and detect when it changes.",
    examplesHtml: "<code>sigildex lock</code> · <code>check</code> · <code>diff</code>",
    here: true,
  },
  {
    stage: "Installation & updates",
    what: "Put skills on disk; report when upstream moves.",
    examplesHtml:
      'Package managers and skill installers, <a href="https://cli.github.com/manual/gh_skill_update"><code>gh skill update --dry-run</code></a>',
    here: false,
  },
];

/** The documentation grid: label, href, one line of what it answers. */
const DOC_LINKS = [
  ["Repository", REPO, "Source, examples, and issues."],
  [`README quickstart`, `${BLOB}/README.md`, "Install, lock, check, diff in a few minutes."],
  ["Safe skill adoption guide", `${BLOB}/docs/safe-skill-adoption.md`, "The whole workflow, written out, with the review checklist."],
  ["Identity specification", `${BLOB}/docs/identity-spec.md`, "What the manifest covers, how the root digest is computed."],
  ["Threat model", `${BLOB}/docs/threat-model.md`, "What an approval record defends against, and what it does not."],
  ["Agent Skill", `${BLOB}/skills/sigildex/SKILL.md`, "The workflow as instructions your agent loads and follows."],
  ["CI example", `${BLOB}/docs/ci/approval-check.yml`, "A workflow that fails a pull request on unreviewed drift."],
  ["Architecture case study", `${BLOB}/docs/case-study.md`, "Building an agent-first system, and what it taught."],
  ["Postmortem", `${BLOB}/docs/postmortem.md`, "What the crawl and rebuild actually cost."],
];

/** Escapes the five characters that change meaning inside HTML markup. */
function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Wraps whole transcript lines in a class so the terminal can colour verdicts
 * and changed files. Whole lines only: a span that split a line would break the
 * literal output an agent or a reader can match against the tool's real stdout.
 * Classification reads the raw line; only the text inside the span is escaped.
 */
function colourTranscript(transcript) {
  return transcript
    .split("\n")
    .map((line) => {
      const escaped = escapeHtml(line);
      if (line === "") return "";
      if (line === "0" || line === "2") return `<span class="x${line}">${escaped}</span>`;
      if (line.startsWith("$ ")) return `<span class="cmd">${escaped}</span>`;
      if (line.startsWith("Match:")) return `<span class="ok">${escaped}</span>`;
      if (line.startsWith("Drift:")) return `<span class="drift">${escaped}</span>`;
      const trimmed = line.trimStart();
      if (trimmed.startsWith("+ ")) return `<span class="add">${escaped}</span>`;
      if (trimmed.startsWith("~ ")) return `<span class="mod">${escaped}</span>`;
      if (line.startsWith("  ")) return `<span class="det">${escaped}</span>`;
      return escaped;
    })
    .join("\n");
}

/**
 * The mark, inlined as geometry: it costs no request, inherits its colour from
 * the surrounding text, and stays sharp at any size. `scripts/site-assets/`
 * holds the two source files; only their inner markup is lifted, so this file
 * keeps control of the size, the class, and the accessible name.
 */
function markInner(sigilSvgFile) {
  const inner = sigilSvgFile.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  if (inner.trim() === "") throw new Error("sigil.svg has no drawable content");
  return inner.trim();
}

/** Inline sigil at `size` px. Decorative: the wordmark beside it carries the name. */
function sigilSvg(size, className, inner) {
  return `<svg class="${className}" width="${size}" height="${size}" viewBox="0 0 400 400" fill="currentColor" fill-rule="evenodd" aria-hidden="true" focusable="false">${inner}</svg>`;
}

/** The favicon, as a URL-encoded SVG data URI. No request, no separate file. */
function faviconDataUri(faviconSvgFile) {
  // Single quotes throughout so the value can sit inside a double-quoted
  // attribute; the file's attribute values contain no apostrophes.
  const svg = faviconSvgFile.trim().replace(/"/g, "'");
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Reads one of the committed page assets. */
function assetPath(fileName) {
  return join(repositoryRoot, "scripts", "site-assets", fileName);
}

/** Reads a font from `scripts/site-assets` and returns it as a `data:` URI. */
async function fontDataUri(fileName) {
  const bytes = await readFile(assetPath(fileName));
  return `data:font/woff2;base64,${bytes.toString("base64")}`;
}

/** The page stylesheet. Only what this page uses; nothing generic. */
function styles(sans, mono) {
  return `/* ${FONT_NOTICE}. Full licence: ${ORIGIN}/fonts/GEIST-OFL.txt */
@font-face{font-family:'Geist';src:url(${sans}) format('woff2');font-weight:100 900;font-style:normal;font-display:block}
@font-face{font-family:'Geist Mono';src:url(${mono}) format('woff2');font-weight:100 900;font-style:normal;font-display:block}

:root{
  color-scheme:dark;
  --bg:#07080C; --raised:#0D0E14; --surface:#14161F; --elevated:#161823;
  --text:#F1F2F4; --dim:#ADB0BA; --muted:#8B8D96;
  /* the smallest labels: this value is set by the contrast floor rather than by
     the type hierarchy — every pair on the page stays above 5:1 */
  --subtle:#8E9099;
  --accent:#7DF0FF; --accent-deep:#38C9E0; --accent-rgb:125,240,255;
  --accent-dim:rgba(125,240,255,.10); --accent-faint:rgba(125,240,255,.045);
  --good:#86EFAC; --good-rgb:134,239,172; --warn:#FBBF24;
  --border:rgba(255,255,255,.07); --border-hi:rgba(255,255,255,.12);
  --border-accent:rgba(125,240,255,.22);
  --radius:14px; --radius-lg:18px; --max-w:1120px;
  --ease:cubic-bezier(.22,1,.36,1);
  --sans:'Geist',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  --mono:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
/* the page is dark on purpose in every OS scheme, so the canvas is painted
   explicitly rather than inherited from the host */
html{background:var(--bg);-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{
  background:var(--bg); color:var(--text);
  font-family:var(--sans); font-size:16px; line-height:1.65;
  font-feature-settings:'ss01','cv11';
  -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale;
  overflow-x:hidden;
}
/* ambient dot field, masked to the top of the page */
body::before{
  content:''; position:fixed; inset:0; z-index:0; pointer-events:none;
  background-image:radial-gradient(rgba(255,255,255,.03) 1px,transparent 1px);
  background-size:36px 36px;
  -webkit-mask-image:radial-gradient(ellipse 120% 80% at 50% 0%,#000 30%,transparent 75%);
  mask-image:radial-gradient(ellipse 120% 80% at 50% 0%,#000 30%,transparent 75%);
}
body>*{position:relative;z-index:1}

a{color:var(--accent);text-decoration:none;transition:color .15s,opacity .15s}
a:hover{opacity:.82}
/* a visible ring first, then withdrawn only where the engine can tell the focus
   came from a pointer — so the ring never depends on :focus-visible support */
:focus{outline:2px solid var(--accent);outline-offset:3px}
:focus:not(:focus-visible){outline:none}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
::selection{background:var(--accent-dim);color:var(--text)}

code,.mono{font-family:var(--mono);font-feature-settings:'calt','liga'}
p code,li code,h3 code{background:var(--surface);color:var(--accent);border-radius:5px;padding:1.5px 5px;font-size:.9em;overflow-wrap:anywhere}
/* inside dense inline text a chip reads as a gap before the punctuation that
   follows it, so those places keep the colour and drop the box */
a code,.step p code,.eco .eg code,.commands code{background:none;padding:0}

.skip{position:absolute;left:-9999px;top:0}
.skip:focus{left:12px;top:12px;z-index:200;background:var(--accent);color:#06070A;padding:10px 16px;border-radius:9px;font-weight:600}

.wrap{max-width:var(--max-w);margin:0 auto;padding:0 28px}
.sec{padding:96px 0}
.band{background:linear-gradient(180deg,rgba(var(--accent-rgb),.02),transparent 60%),var(--raised);border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
section[id]{scroll-margin-top:78px}

.kicker{
  display:inline-flex;align-items:center;gap:9px;
  font-family:var(--mono);font-size:11px;font-weight:500;color:var(--accent);
  text-transform:uppercase;letter-spacing:.16em;margin-bottom:16px;
}
.kicker::before{content:'';width:22px;height:1px;background:var(--border-accent)}
.kicker .idx{color:var(--subtle)}
h2{font-size:clamp(25px,3.4vw,36px);font-weight:500;letter-spacing:-.03em;line-height:1.14;text-wrap:balance;max-width:20ch}
h3{font-size:15px;font-weight:600;letter-spacing:-.01em;line-height:1.35}
.sec-desc{color:var(--dim);max-width:62ch;margin-top:14px}
.note{color:var(--muted);font-size:14.5px;max-width:70ch;margin-top:22px}

/* ---------------- top bar ---------------- */
.topbar{
  position:sticky;top:0;z-index:100;
  background:rgba(7,8,12,.74);
  -webkit-backdrop-filter:blur(18px) saturate(140%);
  backdrop-filter:blur(18px) saturate(140%);
  border-bottom:1px solid var(--border);
}
.topbar .wrap{display:flex;align-items:center;gap:22px;height:60px}
.brand{display:inline-flex;align-items:center;gap:10px;color:var(--text);font-weight:600;font-size:15px;letter-spacing:.14em;flex-shrink:0}
.brand:hover{opacity:1}
.brand .sig{color:var(--accent)}
.topnav ul{display:flex;gap:24px;list-style:none}
.topnav a{color:var(--muted);font-size:14px;font-weight:500}
.topnav a:hover{color:var(--text);opacity:1}
.bar-end{margin-left:auto;display:flex;align-items:center;gap:18px}
.bar-end a{color:var(--muted);font-size:14px;font-weight:500}
.bar-end a:hover{color:var(--text);opacity:1}
.bar-end .go{color:var(--accent)}
@media(max-width:760px){.topnav{display:none}}

/* ---------------- hero ---------------- */
.hero{padding:104px 0 84px;position:relative}
.hero::before{
  content:'';position:absolute;top:0;left:50%;width:min(860px,100%);height:520px;
  transform:translateX(-50%);pointer-events:none;
  background:radial-gradient(ellipse at center,rgba(var(--accent-rgb),.10),rgba(var(--accent-rgb),.03) 38%,transparent 66%);
}
.hero .wrap{position:relative;display:grid;grid-template-columns:minmax(0,1.14fr) minmax(0,.86fr);gap:0 48px;align-items:start}
@media(max-width:1040px){.hero .wrap{grid-template-columns:minmax(0,1fr);gap:44px 0}}
.hero-copy{min-width:0}
.hero-mark{display:block;width:72px;height:72px;color:var(--accent);margin-bottom:26px;filter:drop-shadow(0 0 24px rgba(var(--accent-rgb),.42));animation:pulse 7s ease-in-out infinite}
h1{font-size:clamp(34px,5.4vw,58px);font-weight:500;line-height:1.06;letter-spacing:-.035em;max-width:17ch;text-wrap:balance}
.lead{margin-top:22px;font-size:clamp(16px,1.7vw,18.5px);color:var(--dim);max-width:60ch}
.install{
  display:inline-flex;align-items:center;gap:11px;margin-top:30px;
  padding:11px 18px;border-radius:11px;
  background:var(--elevated);border:1px solid var(--border-hi);
  font-family:var(--mono);font-size:14px;color:var(--text);
  overflow-wrap:anywhere;max-width:100%;
  box-shadow:0 0 0 4px rgba(var(--accent-rgb),.04);
}
.install .p{color:var(--accent)}
.cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:26px}
.btn{display:inline-flex;align-items:center;padding:12px 24px;border-radius:10px;font-size:15px;font-weight:600;white-space:nowrap;transition:transform .15s var(--ease),box-shadow .15s,border-color .15s}
.btn-primary{background:var(--accent);color:#06070A;box-shadow:0 0 0 1px var(--accent),0 10px 26px rgba(var(--accent-rgb),.20)}
.btn-primary:hover{opacity:1;transform:translateY(-1px);box-shadow:0 0 0 1px var(--accent),0 16px 34px rgba(var(--accent-rgb),.30)}
.btn-ghost{background:rgba(255,255,255,.02);color:var(--text);border:1px solid var(--border-hi)}
.btn-ghost:hover{opacity:1;transform:translateY(-1px);border-color:var(--muted)}
.facts{margin-top:30px;font-family:var(--mono);font-size:11.5px;letter-spacing:.02em;color:var(--subtle)}

/* what the tool actually is, beside the headline */
.commands{
  margin-top:8px;padding:24px 26px 20px;min-width:0;border-radius:var(--radius-lg);
  background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,0) 42%),var(--raised);
  border:1px solid var(--border);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 30px 60px -26px rgba(0,0,0,.8);
}
.commands h2{font-family:var(--mono);font-size:11px;font-weight:500;letter-spacing:.16em;text-transform:uppercase;color:var(--subtle);max-width:none}
.cmds{list-style:none;margin-top:6px}
.cmds li{display:flex;flex-direction:column;gap:3px;padding:15px 0;border-top:1px solid var(--border);min-width:0}
.cmds li:first-child{border-top:none}
.commands code{font-size:13.5px;font-weight:500;color:var(--accent);overflow-wrap:anywhere}
.commands .d{font-size:13.5px;color:var(--dim);line-height:1.55}
.codes{
  margin-top:4px;padding-top:15px;border-top:1px solid var(--border);list-style:none;
  display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:7px 16px;
  font-family:var(--mono);font-size:11.5px;line-height:1.5;color:var(--muted);
}
.codes li{min-width:0}
.codes b{font-weight:600;margin-right:6px}
.codes .c0{color:var(--good)}.codes .c2{color:var(--warn)}.codes .c1,.codes .c3{color:var(--dim)}

/* ---------------- positioning ---------------- */
.statement{
  font-size:clamp(17px,2.1vw,21px);line-height:1.6;color:var(--text);max-width:74ch;
  padding:26px 0 26px 26px;border-left:2px solid var(--accent);
  letter-spacing:-.012em;
}
.statement em{color:var(--accent);font-style:normal}

/* ---------------- terminal ---------------- */
.term{
  margin-top:36px;border-radius:var(--radius);overflow:hidden;
  background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,0) 42%),var(--raised);
  border:1px solid var(--border);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 30px 60px -26px rgba(0,0,0,.8);
}
.term-bar{display:flex;align-items:center;gap:8px;padding:12px 16px;background:rgba(255,255,255,.025);border-bottom:1px solid var(--border)}
.term-bar .dot{width:9px;height:9px;border-radius:50%;background:var(--border-hi)}
.term-bar .title{margin-left:8px;font-family:var(--mono);font-size:12px;color:var(--muted)}
.term-body{
  margin:0;padding:22px 24px;overflow-x:auto;
  font-family:var(--mono);font-size:12.5px;line-height:1.72;
  color:var(--dim);-webkit-overflow-scrolling:touch;
  /* a real terminal wraps a long line rather than hiding it; the column
     alignment of every short line survives, and nothing is off-screen */
  white-space:pre-wrap;overflow-wrap:anywhere;
}
.term-body .cmd{color:var(--text);font-weight:500}
.term-body .det{color:var(--muted)}
.term-body .ok{color:var(--good)}
.term-body .drift{color:var(--warn)}
.term-body .add{color:var(--good)}
.term-body .mod{color:#C4B5FD}
.term-body .x0{color:var(--good)}
.term-body .x2{color:var(--warn)}

/* ---------------- workflow ---------------- */
.spine{margin-top:32px;overflow-x:auto;border:1px solid var(--border);border-radius:11px;background:var(--surface)}
.spine p{padding:13px 18px;font-family:var(--mono);font-size:12.5px;color:var(--dim);white-space:nowrap}
.steps{list-style:none;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin-top:16px}
.step{
  display:flex;flex-direction:column;gap:7px;min-width:0;
  padding:18px 16px 16px;border-radius:12px;
  background:rgba(255,255,255,.015);border:1px solid var(--border);
  transition:border-color .2s,transform .2s;
}
.step:hover{border-color:var(--border-hi);transform:translateY(-2px)}
.step .n{font-family:var(--mono);font-size:11px;color:var(--subtle);letter-spacing:.08em}
.step p{font-size:13px;line-height:1.55;color:var(--muted);overflow-wrap:anywhere}
.step .who{margin-top:auto;padding-top:10px;font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.1em;color:var(--subtle)}
.step.ours{
  background:linear-gradient(180deg,var(--accent-faint),transparent 60%),var(--elevated);
  border-color:var(--border-accent);
  box-shadow:0 0 30px -12px rgba(var(--accent-rgb),.35);
}
.step.ours .n,.step.ours .who{color:var(--accent)}
.step.ours h3{color:var(--text)}
@media(max-width:1000px){.steps{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:560px){.steps{grid-template-columns:minmax(0,1fr)}}

/* ---------------- ecosystem ---------------- */
.eco{list-style:none;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:36px}
.eco li{
  display:flex;flex-direction:column;gap:9px;min-width:0;
  padding:22px 22px 20px;border-radius:var(--radius);
  background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(255,255,255,0) 42%),var(--raised);
  border:1px solid var(--border);
}
.eco .stage{font-size:15px;font-weight:600;letter-spacing:-.01em}
.eco .what{font-size:13.5px;color:var(--dim);line-height:1.6}
.eco .eg{font-size:13px;color:var(--muted);line-height:1.65;overflow-wrap:anywhere}
.eco .tag{
  margin-top:auto;padding-top:12px;font-family:var(--mono);font-size:10.5px;
  text-transform:uppercase;letter-spacing:.1em;color:var(--subtle);
}
.eco li.here{
  background:linear-gradient(180deg,var(--accent-dim),transparent 62%),var(--elevated);
  border-color:var(--border-accent);
  box-shadow:0 0 44px -14px rgba(var(--accent-rgb),.42);
}
.eco li.here .tag{color:var(--accent)}
/* five cards into three columns: the one that is this project takes the
   double-width slot on the second row rather than leaving it ragged */
.eco li.here{grid-column:span 2}
@media(max-width:900px){.eco{grid-template-columns:repeat(2,minmax(0,1fr))}.eco li.here{grid-column:span 2}}
@media(max-width:600px){.eco{grid-template-columns:minmax(0,1fr)}.eco li.here{grid-column:span 1}}

/* ---------------- agent entry points ---------------- */
.entries{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:32px}
.entry{
  display:flex;flex-direction:column;gap:8px;min-width:0;
  padding:24px;border-radius:var(--radius);color:var(--text);
  background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(255,255,255,0) 42%),var(--raised);
  border:1px solid var(--border);
  transition:border-color .2s,transform .2s;
}
.entry:hover{opacity:1;border-color:var(--border-accent);transform:translateY(-2px)}
.entry .nm{font-size:16px;font-weight:600;letter-spacing:-.01em}
.entry .pa{font-family:var(--mono);font-size:12.5px;color:var(--accent);overflow-wrap:anywhere}
.entry .ds{font-size:13.5px;color:var(--muted);line-height:1.6}
@media(max-width:700px){.entries{grid-template-columns:minmax(0,1fr)}}

/* ---------------- documentation grid ---------------- */
.docs{list-style:none;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:36px}
.docs li{display:flex;min-width:0}
.docs a{
  flex:1 1 auto;display:flex;flex-direction:column;gap:5px;min-width:0;
  padding:18px 20px;border-radius:12px;color:var(--text);
  background:rgba(255,255,255,.015);border:1px solid var(--border);
  transition:border-color .2s,transform .2s;
}
.docs a:hover{opacity:1;border-color:var(--border-hi);transform:translateY(-2px)}
.docs .nm{font-size:14.5px;font-weight:600;letter-spacing:-.01em;color:var(--accent)}
.docs .ds{font-size:13px;color:var(--muted);line-height:1.55;overflow-wrap:anywhere}
@media(max-width:900px){.docs{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:600px){.docs{grid-template-columns:minmax(0,1fr)}}

/* ---------------- status ---------------- */
.prose{max-width:70ch;margin-top:30px;display:flex;flex-direction:column;gap:16px}
.prose p{color:var(--dim);font-size:15.5px}
.prose strong{color:var(--text);font-weight:600}

/* ---------------- footer ---------------- */
footer{border-top:1px solid var(--border);padding:44px 0 60px}
footer .wrap{display:flex;flex-wrap:wrap;gap:20px 32px;align-items:center}
footer .mark{color:var(--accent);flex-shrink:0;opacity:.85}
footer p{font-size:13.5px;color:var(--muted);max-width:58ch}
footer .ends{margin-left:auto;display:flex;gap:20px;font-family:var(--mono);font-size:12px}
footer .ends a{color:var(--subtle)}
footer .ends a:hover{color:var(--accent);opacity:1}
/* the type attribution takes its own row under everything else */
footer .type{flex-basis:100%;font-size:12.5px;color:var(--subtle);max-width:none}

/* ---------------- motion ---------------- */
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes pulse{0%,100%{opacity:.92;filter:drop-shadow(0 0 18px rgba(var(--accent-rgb),.28))}50%{opacity:1;filter:drop-shadow(0 0 30px rgba(var(--accent-rgb),.46))}}
.r1,.r2,.r3,.r4,.r5{animation:rise .7s var(--ease) both}
.r1{animation-delay:.02s}.r2{animation-delay:.10s}.r3{animation-delay:.18s}
.r4{animation-delay:.26s}.r5{animation-delay:.34s}
/* scroll-driven reveal where the browser supports it; everything stays visible otherwise */
@supports (animation-timeline:view()){
  @media (prefers-reduced-motion:no-preference){
    .reveal{animation:rise .8s var(--ease) both;animation-timeline:view();animation-range:entry 0% cover 22%}
  }
}
@media (prefers-reduced-motion:reduce){
  html{scroll-behavior:auto}
  /* the delays matter as much as the durations: the rise animation runs with
     fill-mode both, so a staggered element would sit at opacity 0 for the
     length of its delay even with the duration zeroed */
  *,*::before,*::after{
    animation-duration:.001ms !important;animation-iteration-count:1 !important;
    animation-delay:0s !important;transition-duration:.001ms !important;transition-delay:0s !important;
  }
  .hero-mark{animation:none}
}
`;
}

/** The one page a human reads. No scripts, no external requests, no tracking. */
function indexHtml({ sansFont, monoFont, mark, faviconSvg }) {
  const description =
    "Sigildex is an open-source, local workflow for recording the exact Agent Skill you reviewed, detecting when the installed bytes drift from it, and showing reviewers exactly which files changed and how.";

  const steps = WORKFLOW_STAGES.map(({ stage, bodyHtml, who, ours }, index) => {
    const n = String(index + 1).padStart(2, "0");
    return `    <li class="step${ours ? " ours" : ""}">
      <span class="n">${n}</span>
      <h3>${escapeHtml(stage)}</h3>
      <p>${bodyHtml}</p>
      <span class="who">${escapeHtml(who)}</span>
    </li>`;
  }).join("\n");

  const ecosystem = ECOSYSTEM.map(
    (row) => `    <li${row.here ? ' class="here"' : ""}>
      <p class="stage">${escapeHtml(row.stage)}</p>
      <p class="what">${escapeHtml(row.what)}</p>
      <p class="eg">${row.examplesHtml}</p>
      <p class="tag">${row.here ? "This project" : "Not Sigildex"}</p>
    </li>`,
  ).join("\n");

  const docs = DOC_LINKS.map(
    ([name, href, line]) => `    <li><a href="${href}"><span class="nm">${name}</span><span class="ds">${line}</span></a></li>`,
  ).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sigildex — know what changed in an Agent Skill</title>
<meta name="description" content="${description}">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#07080C">
<link rel="canonical" href="${ORIGIN}/">
<link rel="icon" href="${faviconDataUri(faviconSvg)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Sigildex">
<meta property="og:title" content="Sigildex — know what changed in an Agent Skill">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${ORIGIN}/">
<meta property="og:image" content="${ORIGIN}/logo.png">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="Sigildex — know what changed in an Agent Skill">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${ORIGIN}/logo.png">
<style>
${styles(sansFont, monoFont)}</style>
</head>
<body>

<a class="skip" href="#overview">Skip to content</a>

<header class="topbar">
  <div class="wrap">
    <a class="brand" href="#overview">${sigilSvg(22, "sig", mark)}Sigildex</a>
    <nav class="topnav" aria-label="Primary">
      <ul>
        <li><a href="#workflow">Workflow</a></li>
        <li><a href="#ecosystem">Where it sits</a></li>
        <li><a href="#links">Docs</a></li>
      </ul>
    </nav>
    <div class="bar-end">
      <a href="https://www.npmjs.com/package/sigildex">npm</a>
      <a class="go" href="${REPO}">GitHub</a>
    </div>
  </div>
</header>

<main>

<section id="overview" class="hero">
  <div class="wrap">
    <div class="hero-copy">
      ${sigilSvg(72, "hero-mark r1", mark)}
      <p class="kicker r1">Approval records for Agent Skills</p>
      <h1 class="r2">Know what changed in an Agent Skill before you trust the update.</h1>
      <p class="lead r3">${description} It runs without an API, account, database, or LLM. Sigildex complements security scanners; it does not certify that a skill is safe.</p>
      <p class="install r4"><span class="p">$</span> npm install -g sigildex@0.1.1</p>
      <div class="cta r4">
        <a class="btn btn-primary" href="${BLOB}/docs/safe-skill-adoption.md">Read the guide</a>
        <a class="btn btn-ghost" href="${REPO}">View on GitHub</a>
      </div>
      <p class="facts r5">MIT licensed · Node.js 20+ · macOS and Linux · no network calls, no telemetry</p>
    </div>
    <aside class="commands r4">
      <h2>Three commands</h2>
      <ul class="cmds">
        <li><code>sigildex lock</code><span class="d">Record exactly what a human approved, beside the code.</span></li>
        <li><code>sigildex check</code><span class="d">Verify the copy that will actually run. A mismatch exits 2.</span></li>
        <li><code>sigildex diff</code><span class="d">Explain what changed, file by file, before you re-approve.</span></li>
      </ul>
      <ul class="codes">
        <li><b class="c0">0</b>match or identical</li>
        <li><b class="c2">2</b>drift or differ</li>
        <li><b class="c1">1</b>tool or input error</li>
        <li><b class="c3">3</b>unsupported record</li>
      </ul>
    </aside>
  </div>
</section>

<section id="positioning" class="band">
  <div class="wrap">
    <p class="statement reveal">Sigildex does not replace discovery, security scanning, or human review. It connects them into a durable workflow by recording exactly what was approved and detecting when that artifact changes.</p>
  </div>
</section>

<section id="demo" class="sec">
  <div class="wrap">
    <p class="kicker"><span class="idx">01</span> The gap</p>
    <h2>You approved a skill. Then it changed.</h2>
    <p class="sec-desc">You read version 1 and approved it. Version 2 adds an executable script and rewrites the instructions to call it, and nothing in the install path tells you.</p>
    <div class="term reveal">
      <div class="term-bar">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="title">examples/version-drift</span>
      </div>
      <pre class="term-body" tabindex="0" role="group" aria-label="Terminal transcript: locking version one, verifying it, then checking version two">${colourTranscript(DEMO_TRANSCRIPT)}</pre>
    </div>
    <p class="note">An update added an executable script where the approved version had none, and rewrote the instructions to call it. <code>sigildex diff</code> shows exactly what changed. A human decides whether to approve it.</p>
    <p class="note">The transcript above is run from the repository's <code>examples/version-drift</code> directory; in a real project you store records at <code>.sigildex/approvals/&lt;approval-id&gt;.lock.json</code> and pass <code>--artifact-path</code> when the reviewed copy sits outside the project.</p>
  </div>
</section>

<section id="workflow" class="sec band">
  <div class="wrap">
    <p class="kicker"><span class="idx">02</span> End to end</p>
    <h2>The workflow</h2>
    <p class="sec-desc">Ten stages, from finding a skill to re-approving an update. Sigildex's commands do the work in four of them; the rest is documented.</p>
    <div class="spine reveal"><p>Discover → stage → inspect/scan → human review → record approval → install &amp; verify → detect update → quarantine → diff → re-approve</p></div>
    <ol class="steps">
${steps}
    </ol>
  </div>
</section>

<section id="ecosystem" class="sec">
  <div class="wrap">
    <p class="kicker"><span class="idx">03</span> Neighbours</p>
    <h2>Where Sigildex sits</h2>
    <p class="sec-desc">Each stage is someone else's job. The gap is between them: what you approved is no longer what is installed, and nobody noticed.</p>
    <ul class="eco">
${ecosystem}
    </ul>
  </div>
</section>

<section id="agent" class="sec band">
  <div class="wrap">
    <p class="kicker"><span class="idx">04</span> For agents</p>
    <h2>Use it with your agent</h2>
    <p class="sec-desc">Sigildex ships as an Agent Skill. Drop it into the directory your agent loads skills from and it walks this workflow with you. The skill instructs the agent to stage candidates in quarantine, to run nothing bundled with them, to summarize scanner output, and to stop for an explicit human decision before any baseline is recorded or anything is installed. It is instruction text, followed by a compliant agent: these rules reduce risk; they are not a security boundary.</p>
    <p class="sec-desc">There are two front doors, and both are plain text, need no JavaScript, and mirror the repository copy byte for byte.</p>
    <div class="entries">
      <a class="entry reveal" href="${ORIGIN}/SKILL.md">
        <span class="nm">Agent Skill</span>
        <span class="pa">${ORIGIN}/SKILL.md</span>
        <span class="ds">The workflow itself, as a skill your agent loads and follows.</span>
      </a>
      <a class="entry reveal" href="${ORIGIN}/llms.txt">
        <span class="nm">Machine-readable front door</span>
        <span class="pa">${ORIGIN}/llms.txt</span>
        <span class="ds">Routing and limits. Point an agent here and it can navigate the whole project unaided.</span>
      </a>
    </div>
    <p class="note">The same Agent Skill lives in the repository at <a href="${BLOB}/skills/sigildex/SKILL.md"><code>skills/sigildex/SKILL.md</code></a> and the package metadata is at <a href="https://registry.npmjs.org/sigildex">registry.npmjs.org/sigildex</a>.</p>
  </div>
</section>

<section id="links" class="sec">
  <div class="wrap">
    <p class="kicker"><span class="idx">05</span> Documentation</p>
    <h2>Links</h2>
    <ul class="docs">
${docs}
    </ul>
  </div>
</section>

<section id="status" class="sec band">
  <div class="wrap">
    <p class="kicker"><span class="idx">06</span> Honest limits</p>
    <h2>Where this stands</h2>
    <div class="prose">
      <p>Sigildex is v0.1.1, published to npm and open source under the MIT license. It runs on macOS and Linux, reads only the paths you give it, and makes no network calls. The <a href="${BLOB}/docs/identity-spec.md">identity specification</a> is the normative contract and the implementation follows it; the schemas, the threat model, and the CI workflow are published alongside it.</p>
      <p>There is no hosted index, no discovery API, and no publisher-monitoring service. Update detection is read-only and something you or your CI runs on purpose — never automatic.</p>
      <p>Sigildex does not certify that a skill is safe, and it does not verify where a skill came from. An approval record is a review snapshot: it records the exact bytes you designated as approved, and tells you when they change. Pair it with security scanning and human review appropriate to your environment.</p>
      <p>It also does not police your approvals directory. <code>lock</code> refuses to write a record under any name but <code>&lt;approval-id&gt;.lock.json</code>. <code>check</code> compares one artifact against one record. But nothing in v0.1 scans a folder of approvals for duplicate ids, duplicate artifact paths, or records left behind without their artifact. Code owners and review cover that.</p>
    </div>
  </div>
</section>

</main>

<footer>
  <div class="wrap">
    ${sigilSvg(26, "mark", mark)}
    <p>Sigildex is open source under the MIT license. The repository is the canonical source of truth; this page is a front door, generated from the repository's own files.</p>
    <div class="ends">
      <a href="${REPO}">Repository</a>
      <a href="${BLOB}/README.md">README</a>
      <a href="${BLOB}/SECURITY.md">Security policy</a>
      <a href="${ORIGIN}/llms.txt">llms.txt</a>
    </div>
    <p class="type">Type: ${FONT_NOTICE} — <a href="${ORIGIN}/fonts/GEIST-OFL.txt">license</a>.</p>
  </div>
</footer>

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
  return `Contact: ${REPO}/security/advisories/new
Policy: ${BLOB}/SECURITY.md
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
      repository: REPO,
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
      // `(.*)` spans `/`, so nested documents such as /ci/README.md are covered.
      src: "^/(.*)\\.md$",
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
      continue: true,
    },
    {
      src: "^/(.*)\\.ya?ml$",
      headers: { "Content-Type": "text/yaml; charset=utf-8" },
      continue: true,
    },
    {
      // The font licence is plain text too, and must arrive as text rather than
      // as a download.
      src: "^/(llms\\.txt|robots\\.txt|fonts/GEIST-OFL\\.txt|\\.well-known/security\\.txt)$",
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

/** Entries in `outDir` the builder never touches: local deploy metadata. */
const PRESERVED = new Set([".vercel", ".gitignore"]);

/**
 * The builder empties its output directory before writing, so it refuses any
 * directory it does not recognise as its own: the target must be empty (apart
 * from the preserved entries) or already hold a generated `index.html` and
 * `retired.json`. That keeps a mistyped path from emptying a directory that
 * was never a site.
 */
function assertBuilderOwned(outDir, entries) {
  const contents = entries.filter((entry) => !PRESERVED.has(entry));
  if (contents.length === 0) return;
  if (contents.includes("index.html") && contents.includes("retired.json")) return;
  throw new Error(
    `refusing to build into ${outDir}: it is not empty and does not look like a previous build (no index.html + retired.json)`,
  );
}

/**
 * Builds the whole site into `outDir`, replacing everything there except the
 * preserved local-only entries above. Returns the site-relative paths written,
 * sorted.
 */
export async function buildSite(outDir = join(repositoryRoot, "site")) {
  await mkdir(outDir, { recursive: true });
  assertBuilderOwned(outDir, await readdir(outDir));
  for (const entry of await readdir(outDir)) {
    if (PRESERVED.has(entry)) continue;
    await rm(join(outDir, entry), { recursive: true, force: true });
  }

  const written = [];
  const copies = [...COPIES];
  const schemaFiles = (await readdir(join(repositoryRoot, "schema")))
    .filter((name) => name.endsWith(".schema.json"))
    .sort();
  for (const name of schemaFiles) copies.push([`schema/${name}`, `schema/${name}`]);

  for (const [source, destination] of [...copies, ...ASSET_COPIES]) {
    await emit(outDir, destination, await readFile(join(repositoryRoot, source)));
    written.push(destination);
  }

  const [sansFont, monoFont, sigil, faviconSvg] = await Promise.all([
    fontDataUri("geist-latin.woff2"),
    fontDataUri("geist-mono-latin.woff2"),
    readFile(assetPath("sigil.svg"), "utf8"),
    readFile(assetPath("sigil-favicon.svg"), "utf8"),
  ]);
  const mark = markInner(sigil);

  const generated = [
    ["index.html", indexHtml({ sansFont, monoFont, mark, faviconSvg })],
    ["robots.txt", robotsTxt()],
    // The sitemap lists documents. Binary assets are not documents.
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
export const ASSET_FILES = ASSET_COPIES.map(([source, destination]) => ({ source, destination }));
export const RETIRED_ROUTE_PATHS = RETIRED_PATHS.map(([path]) => path);

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  // `resolve` so an absolute argument is taken as given rather than appended
  // to the working directory.
  const target = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);
  const files = await buildSite(target);
  process.stdout.write(`wrote ${files.length} files\n`);
}
