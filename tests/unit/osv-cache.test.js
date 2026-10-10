// Unit tests for the run's OSV cache (src/vendor/osv-cache.js): every invocation of one review
// run asks OSV through it, so a question one of them asked is answered from the run's work
// folder. Kept by what was asked, not by a request's body. No network: a counting fake answers.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { withOsvCache } from "../../src/vendor/osv-cache.js";
import {
  VENDOR_OSV_API,
  VENDOR_OSV_BATCH_API,
  VENDOR_OSV_VULN_API,
} from "../../src/config.js";

const notFound = () => Object.assign(new Error("HTTP 404"), { status: 404 });

/** A fake OSV that records every request it is sent. */
function counting({ batch404 = false } = {}) {
  const sent = [];
  return {
    sent,
    async postJson(url, body) {
      sent.push({ url, body });
      if (url === VENDOR_OSV_BATCH_API) {
        if (batch404) {
          throw notFound();
        }
        return {
          results: body.queries.map((q) => ({
            vulns: [{ id: `ID-${q.package.name}` }],
          })),
        };
      }
      if (body.package.name === "gone") {
        throw notFound();
      }
      return { vulns: [{ id: `ID-${body.package.name}` }] };
    },
    async fetchJson(url) {
      sent.push({ url });
      if (url.endsWith("MISSING")) {
        throw notFound();
      }
      return { id: url.slice(url.lastIndexOf("/") + 1) };
    },
  };
}

const query = (name) => ({
  version: "1.0.0",
  package: { name, ecosystem: "npm" },
});

/** A fresh cache file of the test's own. */
function cacheFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-osv-cache-"));
  return path.join(dir, ".cache", "osv.json");
}

test("a batch over packages already asked sends nothing, in any order", async () => {
  const file = cacheFile();
  const osv = counting();
  const first = await withOsvCache(osv, file).postJson(VENDOR_OSV_BATCH_API, {
    queries: [query("a"), query("b")],
  });
  // Another invocation of the run, putting the same packages together the other way.
  const again = await withOsvCache(osv, file).postJson(VENDOR_OSV_BATCH_API, {
    queries: [query("b"), query("a")],
  });
  assert.equal(osv.sent.length, 1);
  assert.deepEqual(again.results, [...first.results].reverse());
});

test("a partly asked batch sends only the new queries, and answers in order", async () => {
  const file = cacheFile();
  const osv = counting();
  await withOsvCache(osv, file).postJson(VENDOR_OSV_BATCH_API, {
    queries: [query("b")],
  });
  const res = await withOsvCache(osv, file).postJson(VENDOR_OSV_BATCH_API, {
    queries: [query("a"), query("b"), query("c")],
  });
  assert.deepEqual(
    osv.sent[1].body.queries.map((q) => q.package.name),
    ["a", "c"]
  );
  assert.deepEqual(
    res.results.map((r) => r.vulns[0].id),
    ["ID-a", "ID-b", "ID-c"]
  );
});

// A failure is never kept: the run ends on it and is handed back in the same work folder once
// OSV answers, so a kept failure would be replayed on every retry.
test("a batch OSV answers 404 is not kept", async () => {
  const file = cacheFile();
  const down = counting({ batch404: true });
  await assert.rejects(
    withOsvCache(down, file).postJson(VENDOR_OSV_BATCH_API, {
      queries: [query("a")],
    }),
    (err) => err.status === 404
  );
  const up = counting();
  await withOsvCache(up, file).postJson(VENDOR_OSV_BATCH_API, {
    queries: [query("a")],
  });
  assert.equal(up.sent.length, 1, "asked again");
});

test("advisories and single queries are kept; a 404 is not", async () => {
  const file = cacheFile();
  const osv = counting();
  for (let run = 0; run < 2; run++) {
    const net = withOsvCache(osv, file);
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
  // The two answers once across both invocations; the two 404s asked each time.
  assert.equal(osv.sent.length, 6);
});

test("every other request goes to the network untouched", async () => {
  const file = cacheFile();
  const sent = [];
  const other = {
    fetchJson: async (url) => (sent.push(url), { url }),
    postJson: async (url) => (sent.push(url), { url }),
  };
  const net = withOsvCache(other, file);
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
  const osv = counting();
  await withOsvCache(osv, file).fetchJson(`${VENDOR_OSV_VULN_API}GHSA-1`);
  assert.equal(osv.sent.length, 1);
});
