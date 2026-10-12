// Unit tests for the run's OSV cache (src/vendor/osv-cache.js): every invocation of one review
// run asks OSV through it, so a question one of them asked is answered from the run's work
// folder. Kept by what was asked, not by a request's body. Each test seeds OSV's answers as the
// cache's content, or OSV's response as a `{fake: ...}` entry, and runs the cache over the
// real transport, which refuses any request nothing was seeded for.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  osvBatchKey,
  osvQueryKey,
  osvVulnKey,
  withOsvCache,
} from "../../src/vendor/osv-cache.js";
import { defaultNet } from "../../src/vendor/verify.js";
import { NoAnswerError } from "../../src/util/net.js";
import { observed } from "../seed-caches.js";
import {
  VENDOR_OSV_API,
  VENDOR_OSV_BATCH_API,
  VENDOR_OSV_VULN_API,
} from "../../src/config.js";

const query = (name) => ({
  version: "1.0.0",
  package: { name, ecosystem: "npm" },
});

/** The refusal of a request no cache entry seeded anything for. */
const refused = (url) => (err) =>
  err.message.includes(`network request in a test: ${url}`);

/**
 * A cache file of the test's own, holding `entries`, or none when not given.
 * @param {object} [entries]
 * @returns {string}
 */
function cacheFile(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-osv-cache-"));
  const file = path.join(dir, ".cache", "osv.json");
  if (entries !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(entries));
  }
  return file;
}

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("a batch over packages already asked sends nothing, in any order", async () => {
  const file = cacheFile({
    [osvBatchKey(query("a"))]: { answer: { vulns: [{ id: "ID-a" }] } },
    [osvBatchKey(query("b"))]: { answer: {} },
  });
  const { net, sent } = observed(defaultNet);
  for (const [order, results] of [
    [
      ["a", "b"],
      [{ vulns: [{ id: "ID-a" }] }, {}],
    ],
    [
      ["b", "a"],
      [{}, { vulns: [{ id: "ID-a" }] }],
    ],
  ]) {
    const res = await withOsvCache(net, file).postJson(VENDOR_OSV_BATCH_API, {
      queries: order.map(query),
    });
    assert.deepEqual(res.results, results);
  }
  assert.deepEqual(sent, []);
});

// A batch is played with the response any of its queries seeds.
test("a partly asked batch sends only the new queries, and answers in order", async () => {
  const file = cacheFile({
    [osvBatchKey(query("a"))]: {
      fake: {
        status: 200,
        json: {
          results: [{ vulns: [{ id: "ID-a" }] }, { vulns: [{ id: "ID-c" }] }],
        },
      },
    },
    [osvBatchKey(query("b"))]: { answer: { vulns: [{ id: "ID-b" }] } },
  });
  const { net, sent } = observed(defaultNet);
  const res = await withOsvCache(net, file).postJson(VENDOR_OSV_BATCH_API, {
    queries: [query("a"), query("b"), query("c")],
  });
  assert.deepEqual(
    sent[0].body.queries.map((q) => q.package.name),
    ["a", "c"]
  );
  assert.deepEqual(
    res.results.map((r) => r.vulns[0].id),
    ["ID-a", "ID-b", "ID-c"]
  );
  // Kept, so the same batch again sends nothing.
  const again = await withOsvCache(net, file).postJson(VENDOR_OSV_BATCH_API, {
    queries: [query("c"), query("a")],
  });
  assert.deepEqual(
    again.results.map((r) => r.vulns[0].id),
    ["ID-c", "ID-a"]
  );
  assert.equal(sent.length, 1);
});

// A batch reply that leaves a query without a result is no answer: it ends the review,
// and nothing of it is kept, so the next ask goes to OSV again.
test("a short batch reply is no answer, and nothing of it is kept", async () => {
  for (const reply of [{ results: [{}] }, {}, { results: [{}, null] }]) {
    const entries = {
      [osvBatchKey(query("a"))]: { fake: { status: 200, json: reply } },
    };
    const file = cacheFile(entries);
    const { net, sent } = observed(defaultNet);
    for (let run = 0; run < 2; run++) {
      await assert.rejects(
        withOsvCache(net, file).postJson(VENDOR_OSV_BATCH_API, {
          queries: [query("a"), query("b")],
        }),
        NoAnswerError,
        JSON.stringify(reply)
      );
    }
    assert.equal(sent.length, 2, "asked again");
    assert.deepEqual(
      sent.map((s) => s.body.queries.length),
      [2, 2],
      "both asked again"
    );
    assert.deepEqual(read(file), entries, "nothing kept");
  }
});

// A failure is never kept: the run ends on it and is handed back in the same work folder once
// OSV answers, so a kept failure would be replayed on every retry.
test("a batch OSV answers 404 is not kept", async () => {
  const entries = { [osvBatchKey(query("a"))]: { fake: { status: 404 } } };
  const file = cacheFile(entries);
  const { net, sent } = observed(defaultNet);
  for (let run = 0; run < 2; run++) {
    await assert.rejects(
      withOsvCache(net, file).postJson(VENDOR_OSV_BATCH_API, {
        queries: [query("a")],
      }),
      (err) => err.status === 404
    );
  }
  assert.equal(sent.length, 2, "asked each time");
  assert.deepEqual(read(file), entries, "nothing kept");
});

test("advisories and single queries are kept; a 404 is not", async () => {
  const entries = {
    [osvVulnKey("GHSA-1")]: { answer: { id: "GHSA-1" } },
    [osvVulnKey("MISSING")]: { fake: { status: 404 } },
    [osvQueryKey(query("a"))]: { answer: { vulns: [{ id: "ID-a" }] } },
    [osvQueryKey(query("gone"))]: { fake: { status: 404 } },
  };
  const file = cacheFile(entries);
  const { net: host, sent } = observed(defaultNet);
  for (let run = 0; run < 2; run++) {
    const net = withOsvCache(host, file);
    assert.deepEqual(await net.fetchJson(`${VENDOR_OSV_VULN_API}GHSA-1`), {
      id: "GHSA-1",
    });
    await assert.rejects(
      net.fetchJson(`${VENDOR_OSV_VULN_API}MISSING`),
      (err) => err.status === 404
    );
    assert.deepEqual(await net.postJson(VENDOR_OSV_API, query("a")), {
      vulns: [{ id: "ID-a" }],
    });
    await assert.rejects(
      net.postJson(VENDOR_OSV_API, query("gone")),
      (err) => err.status === 404
    );
  }
  // The two answers never sent, the two 404s sent each time.
  assert.deepEqual(
    sent.map((s) => s.url),
    [
      `${VENDOR_OSV_VULN_API}MISSING`,
      VENDOR_OSV_API,
      `${VENDOR_OSV_VULN_API}MISSING`,
      VENDOR_OSV_API,
    ]
  );
  assert.deepEqual(read(file), entries, "nothing kept");
});

test("every other request goes to the network untouched", async () => {
  const file = cacheFile();
  const { net: host, sent } = observed(defaultNet);
  const net = withOsvCache(host, file);
  const npm = "https://registry.npmjs.org/x/1.0.0";
  const post = "https://example.invalid/post";
  await assert.rejects(net.fetchJson(npm), refused(npm));
  await assert.rejects(net.postJson(post, {}), refused(post));
  assert.deepEqual(
    sent.map((s) => s.url),
    [npm, post]
  );
  assert.equal(fs.existsSync(file), false, "nothing kept");
});

test("an unreadable cache file reads as empty", async () => {
  const file = cacheFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not json");
  const url = `${VENDOR_OSV_VULN_API}GHSA-1`;
  await assert.rejects(
    withOsvCache(defaultNet, file).fetchJson(url),
    refused(url)
  );
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json", "nothing kept");
});

// The whole cycle for each of OSV's three endpoints: a seeded success is played through the
// transport and kept as OSV's answer, which the next invocation reads without a request. A
// seeded failure is played on every ask and never written.
test("OSV: a played success is kept and read back, a played failure is never kept", async () => {
  const ask = (net, name, id) =>
    Promise.all([
      net.postJson(VENDOR_OSV_API, query(`${name}-single`)),
      net.postJson(VENDOR_OSV_BATCH_API, { queries: [query(`${name}-batch`)] }),
      net.fetchJson(`${VENDOR_OSV_VULN_API}${id}`),
    ]);
  const single = { vulns: [{ id: "ID-s" }] };
  const batched = { vulns: [{ id: "ID-b" }] };
  const record = { id: "ID-b", summary: "advisory" };
  const file = cacheFile({
    [osvQueryKey(query("ok-single"))]: { fake: { status: 200, json: single } },
    [osvBatchKey(query("ok-batch"))]: {
      fake: { status: 200, json: { results: [batched] } },
    },
    [osvVulnKey("ID-b")]: { fake: { status: 200, json: record } },
  });
  const answers = [single, { results: [batched] }, record];
  assert.deepEqual(
    await ask(withOsvCache(defaultNet, file), "ok", "ID-b"),
    answers
  );
  assert.deepEqual(read(file), {
    [osvQueryKey(query("ok-single"))]: { answer: single },
    [osvBatchKey(query("ok-batch"))]: { answer: batched },
    [osvVulnKey("ID-b")]: { answer: record },
  });
  const { net: host, sent } = observed(defaultNet);
  assert.deepEqual(await ask(withOsvCache(host, file), "ok", "ID-b"), answers);
  assert.deepEqual(sent, [], "read back without a request");

  const down = { fake: { status: 503 } };
  const failing = {
    [osvQueryKey(query("down-single"))]: down,
    [osvBatchKey(query("down-batch"))]: down,
    [osvVulnKey("ID-down")]: down,
  };
  const failed = cacheFile(failing);
  const { net: again, sent: asked } = observed(defaultNet);
  for (let run = 0; run < 2; run++) {
    const net = withOsvCache(again, failed);
    for (const request of [
      () => net.postJson(VENDOR_OSV_API, query("down-single")),
      () =>
        net.postJson(VENDOR_OSV_BATCH_API, { queries: [query("down-batch")] }),
      () => net.fetchJson(`${VENDOR_OSV_VULN_API}ID-down`),
    ]) {
      await assert.rejects(
        request,
        (err) => err instanceof NoAnswerError && /HTTP 503/.test(err.message)
      );
    }
    assert.deepEqual(read(failed), failing, "nothing written");
  }
  assert.equal(asked.length, 6, "played on every ask");
});
