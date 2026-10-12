// Unit tests for the run's popularity cache (src/vendor/popularity-cache.js): every invocation
// of one review run asks npm and GitHub through it, so a package one of them asked about is
// answered from the run's cache folder. No network: a counting fake answers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  popularityKey,
  withPopularityCache,
} from "../../src/vendor/popularity-cache.js";
import {
  VENDOR_GITHUB_REPOS_API,
  VENDOR_NPM_DOWNLOADS_API,
} from "../../src/config.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const npm = (name) => `${VENDOR_NPM_DOWNLOADS_API}${name}`;
const gh = (repo) => `${VENDOR_GITHUB_REPOS_API}${repo}`;
const notFound = () => Object.assign(new Error("HTTP 404"), { status: 404 });

/** A fake host that records every request it is sent. */
function counting() {
  const sent = [];
  return {
    sent,
    async fetchJson(url) {
      sent.push(url);
      if (url.endsWith("gone")) {
        throw notFound();
      }
      if (url.endsWith("down")) {
        throw new Error("no answer");
      }
      return url.startsWith(VENDOR_GITHUB_REPOS_API)
        ? { stargazers_count: 7 }
        : { downloads: 7 };
    },
  };
}

/** A fresh cache file of the test's own. */
function cacheFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-popularity-cache-"));
  return path.join(dir, ".cache", "popularity.json");
}

test("an answer is kept, and a repeat in another invocation sends nothing", async () => {
  const file = cacheFile();
  const host = counting();
  for (let run = 0; run < 2; run++) {
    const net = withPopularityCache(host, file);
    assert.deepEqual(await net.fetchJson(npm("@scope/pkg")), { downloads: 7 });
    assert.deepEqual(await net.fetchJson(gh("owner/repo")), {
      stargazers_count: 7,
    });
  }
  assert.deepEqual(host.sent, [npm("@scope/pkg"), gh("owner/repo")]);
});

// A failure is never kept: the run ends on it and is handed back in the same work folder once
// the host answers, so a kept failure would be replayed on every retry. A 404 is not kept
// either: no lookup writes one.
test("a 404 and a failure are not kept", async () => {
  const file = cacheFile();
  const host = counting();
  for (let run = 0; run < 2; run++) {
    const net = withPopularityCache(host, file);
    for (const url of [npm("gone"), gh("owner/gone")]) {
      await assert.rejects(net.fetchJson(url), (err) => err.status === 404);
    }
    for (const url of [npm("down"), gh("owner/down")]) {
      await assert.rejects(net.fetchJson(url), /no answer/);
    }
  }
  assert.equal(host.sent.length, 8, "asked each time");
  assert.equal(fs.existsSync(file), false, "nothing kept");
});

test("a GitHub repository is kept without case, an npm name as it is", async () => {
  const file = cacheFile();
  const host = counting();
  const net = withPopularityCache(host, file);
  await net.fetchJson(gh("Owner/Repo"));
  await net.fetchJson(gh("owner/REPO"));
  await net.fetchJson(npm("Pkg"));
  await net.fetchJson(npm("pkg"));
  assert.deepEqual(host.sent, [gh("Owner/Repo"), npm("Pkg"), npm("pkg")]);
  assert.equal(popularityKey(gh("Owner/Repo")), "gh:owner/repo");
  assert.equal(popularityKey(npm("@Scope/Pkg")), "npm:@Scope/Pkg");
  assert.equal(popularityKey("https://registry.npmjs.org/x"), null);
});

test("every other request goes to the network untouched", async () => {
  const file = cacheFile();
  const sent = [];
  const other = {
    fetchJson: async (url) => (sent.push(url), { url }),
    postJson: async (url) => (sent.push(url), { url }),
  };
  const net = withPopularityCache(other, file);
  for (let i = 0; i < 2; i++) {
    await net.fetchJson("https://registry.npmjs.org/x/1.0.0");
    await net.postJson("https://example.invalid/post", {});
  }
  assert.equal(sent.length, 4);
  assert.equal(fs.existsSync(file), false, "nothing kept");
});

test("an unreadable cache file reads as empty", async () => {
  const file = cacheFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not json");
  const host = counting();
  await withPopularityCache(host, file).fetchJson(npm("a"));
  assert.equal(host.sent.length, 1);
});

// A pre-filled 404 (`{notFound: true}`) answers only while the network is switched off: no
// lookup writes one, so it is a test's offline stand-in for the host's 404, and a real run
// asks the host instead. The switch is read once per process, so the real-run half is asked
// of a child process started without it, with a fake network that records each request and
// makes none, and the same child with the switch on is the control.
test("a pre-filled 404 answers only with the network switched off", () => {
  const module = JSON.stringify(
    path.join(ROOT, "src", "vendor", "popularity-cache.js")
  );
  const script = `
    import fs from "node:fs";
    import os from "node:os";
    import path from "node:path";
    import { withPopularityCache } from ${module};
    import { VENDOR_NPM_DOWNLOADS_API, VENDOR_GITHUB_REPOS_API } from ${JSON.stringify(
      path.join(ROOT, "src", "config.js")
    )};
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wl-404-")), "p.json");
    fs.writeFileSync(file, JSON.stringify({
      "npm:gone": { notFound: true }, "gh:owner/gone": { notFound: true } }));
    const asked = [];
    const net = withPopularityCache({ fetchJson: async (url) => {
      asked.push(url);
      return { downloads: 1 };
    } }, file);
    const statuses = [];
    for (const url of [VENDOR_NPM_DOWNLOADS_API + "gone", VENDOR_GITHUB_REPOS_API + "Owner/Gone"]) {
      try { await net.fetchJson(url); statuses.push("answer"); }
      catch (err) { statuses.push(err.status); }
    }
    console.log(JSON.stringify({ asked: asked.length, statuses }));
  `;
  const run = (switchedOff) => {
    const env = { ...process.env };
    if (switchedOff) {
      env.WEBEXT_LINTER_NO_NETWORK = "1";
    } else {
      delete env.WEBEXT_LINTER_NO_NETWORK;
    }
    const r = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { encoding: "utf8", env }
    );
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split("\n").pop());
  };
  assert.deepEqual(
    run(false),
    { asked: 2, statuses: ["answer", "answer"] },
    "a real run asks"
  );
  assert.deepEqual(
    run(true),
    { asked: 0, statuses: [404, 404] },
    "a test reads it"
  );
});
