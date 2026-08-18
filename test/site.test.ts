import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error -- the site builder is plain ESM JavaScript with no declarations.
import { ASSET_FILES, COPIED_FILES, RETIRED_ROUTE_PATHS, buildSite } from "../scripts/build-site.mjs";

/**
 * The website is generated from this repository's own files, so the two can
 * never disagree. These tests hold that property from four directions:
 * the committed `site/` is byte-identical to a fresh build, each served
 * document is byte-identical to its source, every documented URL resolves to
 * a file that exists, and the front page ships no scripts and no external
 * requests.
 */

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const committedSite = join(repositoryRoot, "site");

const ORIGIN = "https://sigildex.ai";

let temporaryRoot: string;
let freshSite: string;

/** Local-only deploy metadata the builder preserves and the tests ignore. */
const LOCAL_ONLY = new Set([".vercel", ".gitignore"]);

/** Every file under `root`, as sorted POSIX-style paths relative to it. */
async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (directory === root && LOCAL_ONLY.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else found.push(relative(root, absolute).split(sep).join("/"));
    }
  };
  await walk(root);
  return found.sort();
}

/**
 * Maps a site URL path to the file that must serve it. Nested documents such
 * as `/ci/README.md` map straight through to `ci/README.md`; a fragment or a
 * query string is not part of the file name.
 */
function fileForPath(urlPath: string): string {
  const withoutQuery = urlPath.split(/[?#]/)[0]!;
  if (withoutQuery === "" || withoutQuery === "/") return "index.html";
  return withoutQuery.replace(/^\//, "").replace(/\/$/, "");
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "sigildex-site-"));
  freshSite = join(temporaryRoot, "site");
  await buildSite(freshSite);
});

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("the committed site is a current build", () => {
  it("contains exactly the files a fresh build produces", async () => {
    expect(await listFiles(committedSite)).toEqual(await listFiles(freshSite));
  });

  it("contains byte-identical bytes for every one of them", async () => {
    const mismatched: string[] = [];
    for (const path of await listFiles(freshSite)) {
      const built = await readFile(join(freshSite, path));
      const committed = await readFile(join(committedSite, path));
      if (!built.equals(committed)) mismatched.push(path);
    }
    // A failure here means `npm run build:site` was not re-run after a source
    // document changed — the site would ship stale copies of the docs.
    expect(mismatched).toEqual([]);
  });
});

describe("served documents are copies, not forks", () => {
  it("serves each copied document byte-for-byte from its repository source", async () => {
    for (const { source, destination } of COPIED_FILES as Array<{ source: string; destination: string }>) {
      const original = await readFile(join(repositoryRoot, source));
      const served = await readFile(join(committedSite, destination));
      expect(served.equals(original), `${destination} differs from ${source}`).toBe(true);
    }
  });

  it("serves the CI guide and the workflow file it tells you to copy", async () => {
    // Routing an agent to "configure CI" is useless if the two files behind
    // that intent only exist on the repository host.
    for (const [source, destination] of [
      ["docs/ci/README.md", "ci/README.md"],
      ["docs/ci/approval-check.yml", "ci/approval-check.yml"],
    ]) {
      const original = await readFile(join(repositoryRoot, source!));
      const served = await readFile(join(committedSite, destination!));
      expect(served.equals(original), `${destination} differs from ${source}`).toBe(true);
    }
  });

  it("serves each asset byte-for-byte from its repository source", async () => {
    // The link-preview image is a copy of the committed logo, not a re-encode,
    // and the font licence is the file the fonts ship with, so neither can
    // drift from the copy in the repository.
    expect((ASSET_FILES as Array<unknown>).length).toBeGreaterThan(0);
    for (const { source, destination } of ASSET_FILES as Array<{ source: string; destination: string }>) {
      const original = await readFile(join(repositoryRoot, source));
      const served = await readFile(join(committedSite, destination));
      expect(served.equals(original), `${destination} differs from ${source}`).toBe(true);
    }
  });

  it("serves every published JSON Schema", async () => {
    const schemas = (await readdir(join(repositoryRoot, "schema"))).filter((name) => name.endsWith(".schema.json"));
    expect(schemas.length).toBeGreaterThan(0);
    for (const name of schemas) {
      const original = await readFile(join(repositoryRoot, "schema", name));
      const served = await readFile(join(committedSite, "schema", name));
      expect(served.equals(original), `schema/${name} differs from its source`).toBe(true);
    }
  });
});

describe("every documented site URL resolves to a file", () => {
  const sources = [
    ["llms.txt", join(repositoryRoot, "llms.txt")],
    ["site/index.html", join(committedSite, "index.html")],
  ] as const;

  for (const [label, path] of sources) {
    it(`has no dead ${label} link`, async () => {
      const text = await readFile(path, "utf8");
      const urls = text.match(new RegExp(`${ORIGIN}[^\\s"'<>)\\]]*`, "g")) ?? [];
      expect(urls.length).toBeGreaterThan(0);

      const present = new Set(await listFiles(committedSite));
      const missing: string[] = [];
      for (const url of urls) {
        const target = fileForPath(url.slice(ORIGIN.length));
        if (!present.has(target)) missing.push(url);
      }
      expect(missing).toEqual([]);
    });
  }
});

describe("the builder's output directory guard", () => {
  it("refuses a populated directory that is not a previous build", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sigildex-site-guard-"));
    try {
      await writeFile(join(dir, "precious.txt"), "not a site\n");
      await expect(buildSite(dir)).rejects.toThrow(/refusing to build/);
      expect(await readFile(join(dir, "precious.txt"), "utf8")).toBe("not a site\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts an empty directory and a previous build", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sigildex-site-guard-"));
    try {
      await buildSite(dir);
      await buildSite(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the front page", () => {
  let html: string;

  beforeAll(async () => {
    html = await readFile(join(committedSite, "index.html"), "utf8");
  });

  it("ships no scripts", () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it("loads nothing from the network", () => {
    // Reading the page must cost exactly one request: the document. Nothing
    // that fetches a subresource — no `src`, no embedded media, no CSS import,
    // no remote url(), no meta refresh. Every <link> either points at inline
    // data or only declares a canonical address, which no browser fetches.
    expect(html).not.toMatch(/\ssrc\s*=/i);
    expect(html).not.toMatch(/\ssrcset\s*=/i);
    expect(html).not.toMatch(/<(img|image|use|object|embed|iframe|video|audio|source|track)[\s>]/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/http-equiv=["']?\s*refresh/i);
    // `url(//host/…)` inherits the page's scheme, so it is a remote fetch too.
    expect(html).not.toMatch(/url\(\s*['"]?\/\//i);

    // Every url() argument is either inline bytes or a reference inside this
    // same document.
    const urls = [...html.matchAll(/url\(\s*(['"]?)([^)]*?)\1\s*\)/gi)].map(([, , value]) => value!.trim());
    expect(urls.length).toBeGreaterThan(0);
    for (const value of urls) {
      expect(
        value.startsWith("data:") || value.startsWith("#"),
        `url() fetches something: ${value.slice(0, 40)}`,
      ).toBe(true);
    }

    // An <svg> child can carry its own href, which fetches like any other.
    for (const [svg] of html.matchAll(/<svg\b[\s\S]*?<\/svg>/gi)) {
      for (const [, href] of svg.matchAll(/\s(?:xlink:)?href="([^"]*)"/gi)) {
        expect(href!.startsWith("#"), `an svg child links out: ${href}`).toBe(true);
      }
    }

    const links = html.match(/<link\b[^>]*>/gi) ?? [];
    expect(links.length).toBeGreaterThan(0);
    for (const tag of links) {
      const rel = tag.match(/\srel="([^"]*)"/i)?.[1];
      const href = tag.match(/\shref="([^"]*)"/i)?.[1] ?? "";
      expect(["icon", "canonical"], `unexpected <link rel>: ${tag}`).toContain(rel);
      if (rel === "icon") expect(href.startsWith("data:"), `icon is not inline: ${tag}`).toBe(true);
      else expect(href).toBe(`${ORIGIN}/`);
    }
    expect(html.match(/<link\b[^>]*\brel="canonical"/gi) ?? []).toHaveLength(1);
  });

  it("serves the licence for the typefaces it redistributes", () => {
    // Embedding the fonts as base64 is redistribution, and the OFL requires the
    // licence to travel with them.
    expect(html).toContain(`href="${ORIGIN}/fonts/GEIST-OFL.txt"`);
    expect(html).toContain("SIL Open Font License 1.1");
    expect(html).toContain("copyright 2024 The Geist Project Authors");
    // …and again inside the stylesheet, where the @font-face rules are.
    expect(html).toMatch(/\/\* Geist and Geist Mono, copyright 2024 [^*]*\*\/\n@font-face/);
  });

  it("keeps motion out of the way when the reader asks it to", () => {
    // The staggered reveals carry an animation-delay under `fill-mode: both`,
    // so zeroing durations alone would leave the hero invisible for a third of
    // a second on a machine that asked for no motion.
    const reduce = html.match(/@media \(prefers-reduced-motion:reduce\)\{[\s\S]*?\n\}/)?.[0];
    expect(reduce, "no prefers-reduced-motion block").toBeDefined();
    expect(reduce).toMatch(/animation-duration:\.001ms !important/);
    expect(reduce).toMatch(/animation-delay:0s !important/);
    expect(reduce).toMatch(/transition-delay:0s !important/);
  });

  it("embeds both typefaces inline rather than fetching them", () => {
    const faces = html.match(/@font-face\{[^}]*\}/g) ?? [];
    expect(faces).toHaveLength(2);
    expect(faces.some((face) => face.includes("'Geist'"))).toBe(true);
    expect(faces.some((face) => face.includes("'Geist Mono'"))).toBe(true);
    for (const face of faces) expect(face).toMatch(/src:url\(data:font\/woff2;base64,[A-Za-z0-9+/=]+\)/);
  });

  it("draws the mark inline from the committed vector", async () => {
    const sigil = await readFile(join(repositoryRoot, "scripts", "site-assets", "sigil.svg"), "utf8");
    const path = sigil.match(/\sd="([^"]+)"/)?.[1];
    expect(path, "sigil.svg has no path data").toBeDefined();
    // Inlined, not linked: the same geometry appears in the nav, the hero, and
    // the footer, and the favicon is the same file as an encoded data: URI.
    expect(html.split(path!).length - 1).toBe(3);
    expect(html).toMatch(/rel="icon" href="data:image\/svg\+xml,%3Csvg/);
  });

  it("stays small enough to arrive in one round trip", () => {
    // Two embedded variable fonts dominate the byte count; the ceiling exists
    // so a future addition cannot quietly turn the front page into a download.
    expect(Buffer.byteLength(html, "utf8")).toBeLessThan(200 * 1024);
  });

  it("points link previews at an image the site actually serves", () => {
    expect(html).toContain(`content="${ORIGIN}/logo.png"`);
  });

  it("carries the headline and the description", () => {
    expect(html).toContain("Know what changed in an Agent Skill before you trust the update.");
    // The description says what the tool reports — files, and how they changed.
    // `diff` classifies files; it says nothing about capabilities.
    expect(html).toContain(
      "Sigildex is an open-source, local workflow for recording the exact Agent Skill you reviewed, detecting when the installed bytes drift from it, and showing reviewers exactly which files changed and how.",
    );
    expect(html).not.toMatch(/capabilit/i);
    expect(html).toContain(
      "It runs without an API, account, database, or LLM. Sigildex complements security scanners; it does not certify that a skill is safe.",
    );
  });

  it("carries all eight sections and nothing more", () => {
    const anchors: Array<[string, string]> = [
      ["overview", "Approval records for Agent Skills"],
      ["positioning", "Sigildex does not replace discovery, security scanning, or human review."],
      ["demo", "You approved a skill. Then it changed."],
      ["workflow", "The workflow"],
      ["ecosystem", "Where Sigildex sits"],
      ["agent", "Use it with your agent"],
      ["links", "Links"],
      ["status", "Where this stands"],
    ];
    for (const [id, text] of anchors) {
      expect(html, `missing section #${id}`).toContain(`id="${id}"`);
      expect(html, `missing anchor text for #${id}`).toContain(text);
    }
    expect(html.match(/<section /g) ?? []).toHaveLength(anchors.length);
  });

  it("states the workflow as one line", () => {
    expect(html).toContain(
      "Discover → stage → inspect/scan → human review → record approval → install &amp; verify → detect update → quarantine → diff → re-approve",
    );
  });

  it("shows a real transcript with both verdicts and both exit codes", () => {
    expect(html).toContain("Match: the artifact matches approval record log-summarizer.");
    expect(html).toContain("Drift: the artifact no longer matches the approval record");
    expect(html).toContain("+ scripts/summarize.sh (script)");
  });

  it("names the neighbouring ecosystem tools", () => {
    for (const name of [
      "gh skill",
      "Vercel Skills CLI",
      "NVIDIA SkillSpector",
      "Cisco AI Defense Skill Scanner",
      "Snyk Agent Scan",
    ]) {
      expect(html, `missing ${name}`).toContain(name);
    }
  });

  it("walks all ten stages and marks the four a Sigildex command does the work in", () => {
    // Stage names are stored as plain text and escaped at render, so the one
    // with an ampersand appears here in its escaped form.
    for (const stage of [
      "Discover",
      "Stage",
      "Inspect / scan",
      "Human review",
      "Record approval",
      "Install &amp; verify",
      "Detect update",
      "Quarantine",
      "Diff",
      "Re-approve",
    ]) {
      expect(html, `missing stage ${stage}`).toContain(`<h3>${stage}</h3>`);
    }
    expect(html.match(/<li class="step/g) ?? []).toHaveLength(10);
    expect(html.match(/<li class="step ours"/g) ?? []).toHaveLength(4);
  });

  it("shows how to install the published package", () => {
    expect(html).toContain("npm install -g sigildex@0.1.0");
    expect(html).toContain('href="https://www.npmjs.com/package/sigildex"');
  });

  it("points agents at both machine-readable entry points", () => {
    expect(html).toContain(`href="${ORIGIN}/llms.txt"`);
    expect(html).toContain(`href="${ORIGIN}/SKILL.md"`);
    expect(html).toContain("skills/sigildex/SKILL.md");
  });

  it("links the repository, the guides, and the two long-form documents", () => {
    for (const url of [
      "https://github.com/sigildex/sigildex",
      "https://github.com/sigildex/sigildex/blob/main/README.md",
      "https://github.com/sigildex/sigildex/blob/main/docs/safe-skill-adoption.md",
      "https://github.com/sigildex/sigildex/blob/main/docs/identity-spec.md",
      "https://github.com/sigildex/sigildex/blob/main/docs/case-study.md",
      "https://github.com/sigildex/sigildex/blob/main/docs/postmortem.md",
      // Each neighbouring tool is linked to the page it is named after; every
      // one of these was fetched and resolves to that project.
      "https://cli.github.com/",
      "https://cli.github.com/manual/gh_skill_update",
      "https://github.com/vercel-labs/skills",
      "https://github.com/NVIDIA/SkillSpector",
      "https://github.com/cisco-ai-defense/skill-scanner",
      "https://github.com/snyk/agent-scan",
      "https://github.com/sigildex/sigildex/blob/main/SECURITY.md",
      "https://github.com/sigildex/sigildex/blob/main/docs/threat-model.md",
      "https://registry.npmjs.org/sigildex",
    ]) {
      expect(html, `missing link ${url}`).toContain(`href="${url}"`);
    }
  });

  it("claims nothing the tool does not do", () => {
    expect(html).toContain("it does not certify that a skill is safe");
    expect(html).toContain("There is no hosted index, no discovery API, and no publisher-monitoring service.");
    for (const forbidden of [
      /security layer for all/i,
      /proves\s+(that\s+)?skills\s+are\s+safe/i,
      /\bthe (first|only) tool\b/i,
      /hosted index (is|will)/i,
    ]) {
      expect(html, `front page makes a claim it must not: ${forbidden}`).not.toMatch(forbidden);
    }
  });
});

describe("retired hosted routes", () => {
  let config: { routes: Array<Record<string, unknown>> };

  beforeAll(async () => {
    config = JSON.parse(await readFile(join(committedSite, "vercel.json"), "utf8")) as typeof config;
  });

  it("uses the legacy routes array alone", () => {
    // `routes` cannot be combined with any of these, and only `routes` can
    // answer with a status and a body without a serverless function.
    for (const key of ["rewrites", "redirects", "headers", "cleanUrls", "functions"]) {
      expect(config).not.toHaveProperty(key);
    }
    expect(Array.isArray(config.routes)).toBe(true);
  });

  it("lets real files win before any retirement rule", () => {
    const filesystemIndex = config.routes.findIndex((route) => route["handle"] === "filesystem");
    const firstRetired = config.routes.findIndex((route) => route["status"] === 410);
    expect(filesystemIndex).toBeGreaterThanOrEqual(0);
    expect(firstRetired).toBeGreaterThan(filesystemIndex);
    // Anything before the filesystem handle only decorates and continues.
    for (const route of config.routes.slice(0, filesystemIndex)) {
      expect(route["continue"]).toBe(true);
      expect(route["status"]).toBeUndefined();
    }
  });

  it("answers 410 with the retirement body for every retired path", () => {
    const gone = config.routes.filter((route) => route["status"] === 410);
    expect(gone).toHaveLength((RETIRED_ROUTE_PATHS as string[]).length);
    for (const route of gone) {
      expect(route["dest"]).toBe("/retired.json");
      const headers = route["headers"] as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["Cache-Control"]).toBe("no-store");
      expect(headers["X-Robots-Tag"]).toBe("noindex");
    }
  });

  it("matches each retired path against exactly one 410 rule", async () => {
    const gone = config.routes.filter((route) => route["status"] === 410);
    const patterns = gone.map((route) => new RegExp(route["src"] as string));
    // The literal request paths behind the documented patterns.
    const requests = [
      "/discover",
      "/inspect",
      "/verify",
      "/mcp",
      "/health",
      "/prices",
      "/openapi.json",
      "/llms-full.txt",
      "/.well-known/x402.json",
      "/.well-known/mcp.json",
      "/.well-known/agent-pricing.json",
      "/api",
      "/api/v1/discover",
      "/v1",
      "/v1/discover",
    ];
    for (const request of requests) {
      const matches = patterns.filter((pattern) => pattern.test(request));
      expect(matches, `${request} is not retired exactly once`).toHaveLength(1);
    }
  });

  it("serves a retirement body that says the tool is now local and open source", async () => {
    const body = JSON.parse(await readFile(join(committedSite, "retired.json"), "utf8")) as Record<string, unknown>;
    expect(body["status"]).toBe(410);
    expect(body["message"]).toBe(
      "This hosted endpoint has been retired. Sigildex is now an open-source local tool.",
    );
    expect(body["see"]).toBe(`${ORIGIN}/llms.txt`);
    expect(body["repository"]).toBe("https://github.com/sigildex/sigildex");
  });

  it("folds the legacy human pages into the front page with a permanent redirect", () => {
    const moved = config.routes.filter((route) => route["status"] === 308);
    expect(moved.map((route) => route["src"])).toEqual(["^/about/?$", "^/docs(/.*)?$", "^/legal(/.*)?$"]);
    for (const route of moved) expect((route["headers"] as Record<string, string>)["Location"]).toBe("/");
    // The front page's own /docs links point at the repository, not at the
    // retired site paths, so nothing on the page hits this redirect.
    for (const pattern of moved.map((route) => new RegExp(route["src"] as string))) {
      expect(pattern.test("/llms.txt")).toBe(false);
    }
  });
});

describe("content-type routes", () => {
  let config: { routes: Array<Record<string, unknown>> };

  beforeAll(async () => {
    config = JSON.parse(await readFile(join(committedSite, "vercel.json"), "utf8")) as typeof config;
  });

  /** The content type the header routes assign to a request path, if any. */
  function contentTypeFor(requestPath: string): string | undefined {
    const filesystemIndex = config.routes.findIndex((route) => route["handle"] === "filesystem");
    for (const route of config.routes.slice(0, filesystemIndex)) {
      if (new RegExp(route["src"] as string).test(requestPath)) {
        return (route["headers"] as Record<string, string>)["Content-Type"];
      }
    }
    return undefined;
  }

  it("labels every served document, at the root and nested", () => {
    // An agent fetching a raw document gets the wrong type — or a download —
    // when the header route misses the path it lives at.
    const expected: Array<[string, string]> = [
      ["/safe-skill-adoption.md", "text/markdown; charset=utf-8"],
      ["/SKILL.md", "text/markdown; charset=utf-8"],
      ["/ci/README.md", "text/markdown; charset=utf-8"],
      ["/ci/approval-check.yml", "text/yaml; charset=utf-8"],
      ["/llms.txt", "text/plain; charset=utf-8"],
      ["/robots.txt", "text/plain; charset=utf-8"],
      ["/fonts/GEIST-OFL.txt", "text/plain; charset=utf-8"],
      ["/.well-known/security.txt", "text/plain; charset=utf-8"],
    ];
    for (const [requestPath, contentType] of expected) {
      expect(contentTypeFor(requestPath), `wrong content type for ${requestPath}`).toBe(contentType);
    }
  });

  it("covers every copied document with a content-type route", async () => {
    const unlabelled: string[] = [];
    for (const { destination } of COPIED_FILES as Array<{ destination: string }>) {
      if (contentTypeFor(`/${destination}`) === undefined) unlabelled.push(destination);
    }
    expect(unlabelled).toEqual([]);
  });
});

describe("the machine-readable root files", () => {
  it("publishes a sitemap covering the front page and every agent file", async () => {
    const sitemap = await readFile(join(committedSite, "sitemap.xml"), "utf8");
    expect(sitemap).toContain(`<loc>${ORIGIN}/</loc>`);
    for (const { destination } of COPIED_FILES as Array<{ destination: string }>) {
      expect(sitemap, `sitemap omits /${destination}`).toContain(`<loc>${ORIGIN}/${destination}</loc>`);
    }
    // Assets are served at stable URLs but are not documents to index.
    for (const { destination } of ASSET_FILES as Array<{ destination: string }>) {
      expect(sitemap, `sitemap lists the asset /${destination}`).not.toContain(`<loc>${ORIGIN}/${destination}</loc>`);
    }
  });

  it("allows crawlers and points them at the sitemap", async () => {
    const robots = await readFile(join(committedSite, "robots.txt"), "utf8");
    expect(robots).toContain("User-agent: *");
    expect(robots).toContain("Allow: /");
    expect(robots).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  });

  it("publishes a security.txt with a contact, a policy, and an unexpired date", async () => {
    const securityTxt = await readFile(join(committedSite, ".well-known", "security.txt"), "utf8");
    expect(securityTxt).toContain("Contact: https://github.com/sigildex/sigildex/security/advisories/new");
    expect(securityTxt).toContain("Policy: https://github.com/sigildex/sigildex/blob/main/SECURITY.md");
    expect(securityTxt).toContain(`Canonical: ${ORIGIN}/.well-known/security.txt`);
    const expires = securityTxt.match(/^Expires: (.+)$/m)?.[1];
    expect(expires).toBeDefined();
    expect(Date.parse(expires!)).toBeGreaterThan(Date.now());
  });
});
