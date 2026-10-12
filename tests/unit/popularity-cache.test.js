// Unit tests for the run's popularity cache (src/vendor/popularity-cache.js): every invocation
// of one review run asks npm and GitHub through it, so a package one of them asked about is
// answered from the run's cache folder. Each test seeds the hosts' answers as the cache's
// content, or a host's response as a `{fake: ...}` entry, and runs the cache over the real
// transport, which refuses any request nothing was seeded for.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  popularityKey,
  withPopularityCache,
} from "../../src/vendor/popularity-cache.js";
import { defaultNet } from "../../src/vendor/verify.js";
import { NoAnswerError } from "../../src/util/net.js";
import { observed } from "../seed-caches.js";
import {
  VENDOR_GITHUB_REPOS_API,
  VENDOR_NPM_DOWNLOADS_API,
} from "../../src/config.js";

const npm = (name) => `${VENDOR_NPM_DOWNLOADS_API}${name}`;
const gh = (repo) => `${VENDOR_GITHUB_REPOS_API}${repo}`;

/** The refusal of a request no cache entry seeded anything for. */
const refused = (url) => (err) =>
  err.message.includes(`network request in a test: ${url}`);

/**
 * A cache file of the test's own, holding `entries`, or none when not given.
 * @param {object} [entries]
 * @returns {string}
 */
function cacheFile(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-popularity-cache-"));
  const file = path.join(dir, ".cache", "popularity.json");
  if (entries !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(entries));
  }
  return file;
}

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("an answer is kept, and a repeat in another invocation sends nothing", async () => {
  const file = cacheFile({
    "npm:@scope/pkg": { answer: { downloads: 7 } },
    "gh:owner/repo": { answer: { stargazers_count: 7 } },
  });
  const { net: host, sent } = observed(defaultNet);
  for (let run = 0; run < 2; run++) {
    const net = withPopularityCache(host, file);
    assert.deepEqual(await net.fetchJson(npm("@scope/pkg")), { downloads: 7 });
    assert.deepEqual(await net.fetchJson(gh("owner/repo")), {
      stargazers_count: 7,
    });
  }
  assert.deepEqual(sent, []);
});

// A failure is never kept: the run ends on it and is handed back in the same work folder once
// the host answers, so a kept failure would be replayed on every retry. A 404 is not kept
// either: no lookup writes one.
test("a 404 and a failure are not kept", async () => {
  const entries = {
    "npm:gone": { fake: { status: 404 } },
    "gh:owner/gone": { fake: { status: 404 } },
    "npm:down": { fake: { status: 503 } },
    "gh:owner/down": { fake: { status: 503 } },
  };
  const file = cacheFile(entries);
  const { net: host, sent } = observed(defaultNet);
  for (let run = 0; run < 2; run++) {
    const net = withPopularityCache(host, file);
    for (const url of [npm("gone"), gh("owner/gone")]) {
      await assert.rejects(net.fetchJson(url), (err) => err.status === 404);
    }
    for (const url of [npm("down"), gh("owner/down")]) {
      await assert.rejects(
        net.fetchJson(url),
        (err) => err instanceof NoAnswerError && /HTTP 503/.test(err.message)
      );
    }
  }
  assert.equal(sent.length, 8, "asked each time");
  assert.deepEqual(read(file), entries, "nothing kept");
});

test("a GitHub repository is kept without case, an npm name as it is", async () => {
  const file = cacheFile({
    "gh:owner/repo": { answer: { stargazers_count: 7 } },
    "npm:Pkg": { answer: { downloads: 7 } },
  });
  const { net: host, sent } = observed(defaultNet);
  const net = withPopularityCache(host, file);
  for (const url of [gh("Owner/Repo"), gh("owner/REPO")]) {
    assert.deepEqual(await net.fetchJson(url), { stargazers_count: 7 });
  }
  assert.deepEqual(await net.fetchJson(npm("Pkg")), { downloads: 7 });
  await assert.rejects(net.fetchJson(npm("pkg")), refused(npm("pkg")));
  assert.deepEqual(
    sent.map((s) => s.url),
    [npm("pkg")]
  );
  assert.equal(popularityKey(gh("Owner/Repo")), "gh:owner/repo");
  assert.equal(popularityKey(npm("@Scope/Pkg")), "npm:@Scope/Pkg");
  assert.equal(popularityKey("https://registry.npmjs.org/x"), null);
});

test("every other request goes to the network untouched", async () => {
  const file = cacheFile();
  const { net: host, sent } = observed(defaultNet);
  const net = withPopularityCache(host, file);
  const registry = "https://registry.npmjs.org/x/1.0.0";
  const post = "https://example.invalid/post";
  await assert.rejects(net.fetchJson(registry), refused(registry));
  await assert.rejects(net.postJson(post, {}), refused(post));
  assert.deepEqual(
    sent.map((s) => s.url),
    [registry, post]
  );
  assert.equal(fs.existsSync(file), false, "nothing kept");
});

test("an unreadable cache file reads as empty", async () => {
  const file = cacheFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not json");
  await assert.rejects(
    withPopularityCache(defaultNet, file).fetchJson(npm("a")),
    refused(npm("a"))
  );
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json", "nothing kept");
});

// A seeded response is played by the real transport in place of the host, and what it gives
// is the host's answer: kept like any other, while the seeded entry itself is never written.
test("a seeded answer is played through the transport and kept as an answer", async () => {
  const file = cacheFile({
    "npm:pkg": { fake: { status: 200, json: { downloads: 7 } } },
  });
  const net = withPopularityCache(defaultNet, file);
  assert.deepEqual(await net.fetchJson(npm("pkg")), { downloads: 7 });
  assert.deepEqual(read(file), { "npm:pkg": { answer: { downloads: 7 } } });
  // Kept, so it is read back without the transport.
  const { net: host, sent } = observed(defaultNet);
  assert.deepEqual(
    await withPopularityCache(host, file).fetchJson(npm("pkg")),
    {
      downloads: 7,
    }
  );
  assert.deepEqual(sent, []);
});

// The whole cycle for both hosts: a seeded success is played through the transport and kept
// as the host's answer, which the next invocation reads without a request. A seeded failure,
// or a 404, is played on every ask and never written.
test("popularity: a played success is kept and read back, a played failure is never kept", async () => {
  const file = cacheFile({
    "npm:pkg": { fake: { status: 200, json: { downloads: 7 } } },
    "gh:owner/repo": { fake: { status: 200, json: { stargazers_count: 7 } } },
  });
  const ask = async (net) => [
    await net.fetchJson(npm("pkg")),
    await net.fetchJson(gh("owner/repo")),
  ];
  const answers = [{ downloads: 7 }, { stargazers_count: 7 }];
  assert.deepEqual(await ask(withPopularityCache(defaultNet, file)), answers);
  assert.deepEqual(read(file), {
    "npm:pkg": { answer: { downloads: 7 } },
    "gh:owner/repo": { answer: { stargazers_count: 7 } },
  });
  const { net: host, sent } = observed(defaultNet);
  assert.deepEqual(await ask(withPopularityCache(host, file)), answers);
  assert.deepEqual(sent, [], "read back without a request");

  const failing = {
    "npm:down": { fake: { status: 503 } },
    "gh:owner/down": { fake: { status: 503 } },
    "npm:gone": { fake: { status: 404 } },
    "gh:owner/gone": { fake: { status: 404 } },
  };
  const failed = cacheFile(failing);
  const { net: again, sent: asked } = observed(defaultNet);
  for (let run = 0; run < 2; run++) {
    const net = withPopularityCache(again, failed);
    for (const url of [npm("down"), gh("owner/down")]) {
      await assert.rejects(
        net.fetchJson(url),
        (err) => err instanceof NoAnswerError && /HTTP 503/.test(err.message)
      );
    }
    for (const url of [npm("gone"), gh("owner/gone")]) {
      await assert.rejects(net.fetchJson(url), (err) => err.status === 404);
    }
    assert.deepEqual(read(failed), failing, "nothing written");
  }
  assert.equal(asked.length, 8, "played on every ask");
});
