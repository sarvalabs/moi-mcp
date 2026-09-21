/**
 * Opens an issue in this repo when a MOI upstream publishes a release.
 *
 * Three upstreams move the ground under this server without touching its
 * code: js-moi-sdk (a dependency), go-moi (the chain itself) and cocolang
 * (the logic language). go-moi v0.13.0 shipped on 2026-09-10 and broke asset
 * creation here; nobody noticed for about a week. This turns a release into a
 * tracked item the day it appears.
 *
 * One issue per release, titled "Upstream release: <name> <tag>", labelled
 * upstream-release. Running it twice never duplicates: an issue with that
 * exact title, open or closed, means the release was already reported.
 *
 * Environment:
 *   GITHUB_TOKEN          writes issues here; also reads public upstreams
 *   UPSTREAM_READ_TOKEN   reads the private upstreams (go-moi, cocolang).
 *                         Without it those are skipped with a warning.
 *   GITHUB_REPOSITORY     owner/repo to file issues in (set by Actions)
 *   DRY_RUN=1             report what would be filed, file nothing
 *
 * Local dry run:
 *   GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=sarvalabs/moi-mcp \
 *     DRY_RUN=1 node scripts/upstream-watch.mjs
 */

import { readFileSync } from "node:fs";

const API = "https://api.github.com";
const LABEL = "upstream-release";

const UPSTREAMS = [
  {
    name: "js-moi-sdk",
    repo: "sarvalabs/js-moi-sdk",
    private: false,
    check: [
      "Dependabot opens the upgrade pull request once this version reaches npm. If it does not appear, the release may be on GitHub only (0.9.0-rc3 was).",
      "Read the SDK changelog for changes to participants, asset ids, amount scaling, or the interaction shape: those change what a user signs.",
      "Run the live canary: MOI_E2E=1 npx vitest run test/e2e/chain-canary.test.ts",
    ],
  },
  {
    name: "go-moi",
    repo: "sarvalabs/go-moi",
    private: true,
    check: [
      "This is the chain itself. Nothing in this repo changes, but its validation rules may have.",
      "Run the live canary: MOI_E2E=1 npx vitest run test/e2e/chain-canary.test.ts",
      "Ask when voyage devnet picks this version up. The canary runs nightly and will fail on the first night the upgrade breaks something.",
    ],
  },
  {
    name: "cocolang",
    repo: "sarvalabs/cocolang",
    private: true,
    check: [
      "The logic language. moi_get_logic reads manifests it produces and moi_call_logic encodes calls against them.",
      "Check the release notes for manifest or calldata encoding changes.",
    ],
  },
];

const env = process.env;
const DRY = env.DRY_RUN === "1";
const HERE = env.GITHUB_REPOSITORY;
if (!env.GITHUB_TOKEN || !HERE) {
  console.error("GITHUB_TOKEN and GITHUB_REPOSITORY are required.");
  process.exit(2);
}

async function gh(path, { token = env.GITHUB_TOKEN, method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

/** npm lags GitHub sometimes; say so rather than let it look like Dependabot broke. */
async function onNpm(tag) {
  const res = await fetch("https://registry.npmjs.org/js-moi-sdk");
  if (!res.ok) return undefined;
  const versions = Object.keys((await res.json()).versions ?? {});
  return versions.includes(tag.replace(/^v/, ""));
}

function pinnedSdk() {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).dependencies["js-moi-sdk"];
  } catch {
    return undefined;
  }
}

async function reportedTitles() {
  const titles = new Set();
  for (let page = 1; page <= 10; page++) {
    const { json } = await gh(`/repos/${HERE}/issues?labels=${LABEL}&state=all&per_page=100&page=${page}`);
    if (!Array.isArray(json) || json.length === 0) break;
    for (const i of json) titles.add(i.title);
  }
  return titles;
}

async function ensureLabel() {
  if (DRY) return;
  const { status } = await gh(`/repos/${HERE}/labels`, {
    method: "POST",
    body: { name: LABEL, color: "5319e7", description: "A MOI upstream published a release" },
  });
  // 422 means it already exists; anything else outside 2xx is worth hearing about.
  if (status !== 201 && status !== 422) console.warn(`label create returned ${status}`);
}

const seen = await reportedTitles();
await ensureLabel();
let filed = 0;
let skipped = 0;

for (const up of UPSTREAMS) {
  const token = up.private ? env.UPSTREAM_READ_TOKEN : env.GITHUB_TOKEN;
  if (!token) {
    console.warn(`skip ${up.name}: private repo and UPSTREAM_READ_TOKEN is not set`);
    skipped++;
    continue;
  }
  const { status, json } = await gh(`/repos/${up.repo}/releases?per_page=1`, { token });
  if (status !== 200 || !Array.isArray(json)) {
    console.warn(`skip ${up.name}: releases request returned ${status}`);
    skipped++;
    continue;
  }
  const rel = json[0];
  if (!rel) {
    console.log(`${up.name}: no releases`);
    continue;
  }

  const title = `Upstream release: ${up.name} ${rel.tag_name}`;
  if (seen.has(title)) {
    console.log(`${up.name} ${rel.tag_name}: already reported`);
    continue;
  }

  const lines = [
    `**${up.name} ${rel.tag_name}** was published on ${rel.published_at?.slice(0, 10)}${rel.prerelease ? " as a prerelease" : ""}.`,
    "",
    `Release: ${rel.html_url}`,
  ];
  if (up.name === "js-moi-sdk") {
    const pin = pinnedSdk();
    const npm = await onNpm(rel.tag_name);
    lines.push("", `This repo pins js-moi-sdk to \`${pin ?? "unknown"}\`.`);
    if (npm === false) lines.push("This version is **not on npm yet**, so Dependabot cannot offer it until it is.");
  }
  lines.push("", "What to check:", ...up.check.map((c) => `- ${c}`));
  lines.push("", "_Filed by scripts/upstream-watch.mjs. Close this once the release is checked._");

  if (DRY) {
    console.log(`would file: ${title}\n${lines.join("\n")}\n`);
  } else {
    const { status: s } = await gh(`/repos/${HERE}/issues`, {
      method: "POST",
      body: { title, body: lines.join("\n"), labels: [LABEL] },
    });
    if (s !== 201) {
      console.error(`failed to file "${title}": ${s}`);
      process.exitCode = 1;
      continue;
    }
    console.log(`filed: ${title}`);
  }
  filed++;
}

console.log(`done: ${filed} new, ${skipped} skipped${DRY ? " (dry run)" : ""}`);
