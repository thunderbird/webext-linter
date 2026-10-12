// Unit tests for the sources cache (src/vendor/source-cache.js): every review downloads a
// pinned library source through it, so a source one review downloaded is read from the cache
// folder by the next. No network: a counting fake answers, since what is tested is what the
// cache keeps of a live answer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  bytesKey,
  listingKey,
  withSourceCache,
} from "../../src/vendor/source-cache.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const FILE = "https://unpkg.com/leftpad@1.0.0/dist/leftpad.js";
const META = "https://unpkg.com/leftpad@1.0.0/?meta";
const fake404 = () => Object.assign(new Error("HTTP 404"), { status: 404 });

/** A fake host that records every request it is sent. */
function counting() {
  const sent = [];
  return {
    sent,
    async fetchBytes(url) {
      sent.push(url);
      if (url.endsWith("gone.js")) {
        throw fake404();
      }
      if (url.endsWith("down.js")) {
        throw new Error("no answer");
      }
      return Buffer.from(`bytes of ${url}`);
    },
    async fetchJson(url) {
      sent.push(url);
      return { type: "directory", files: [], url };
    },
  };
}

/** A fresh cache folder of the test's own. */
const cacheDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "wl-source-cache-"));

test("a download and a listing are kept, and a repeat in another review sends nothing", async () => {
  const dir = cacheDir();
  const host = counting();
  for (let review = 0; review < 2; review++) {
    const net = withSourceCache(host, dir);
    assert.equal((await net.fetchBytes(FILE)).toString(), `bytes of ${FILE}`);
    assert.deepEqual(await net.fetchJson(META), {
      type: "directory",
      files: [],
      url: META,
    });
  }
  assert.deepEqual(host.sent, [FILE, META]);
});

// A failure is never kept, and neither is a 404: no download writes one.
test("a 404 and a failure are not kept", async () => {
  const dir = cacheDir();
  const host = counting();
  for (let review = 0; review < 2; review++) {
    const net = withSourceCache(host, dir);
    await assert.rejects(
      net.fetchBytes("https://unpkg.com/x@1.0.0/gone.js"),
      (err) => err.status === 404
    );
    await assert.rejects(
      net.fetchBytes("https://unpkg.com/x@1.0.0/down.js"),
      /no answer/
    );
  }
  assert.equal(host.sent.length, 4, "asked each time");
  assert.deepEqual(fs.readdirSync(dir), [], "nothing kept");
});

// A body is read back only while its bytes still hash to the name the index gives it: one
// changed or lost on disk is downloaded again, never served.
test("a kept body that no longer matches its hash is downloaded again", async () => {
  const dir = cacheDir();
  const host = counting();
  await withSourceCache(host, dir).fetchBytes(FILE);
  const index = JSON.parse(
    fs.readFileSync(path.join(dir, "sources.json"), "utf8")
  );
  const body = path.join(dir, index[bytesKey(FILE)].sha256);
  fs.writeFileSync(body, "tampered");
  assert.equal(
    (await withSourceCache(host, dir).fetchBytes(FILE)).toString(),
    `bytes of ${FILE}`
  );
  fs.rmSync(body);
  await withSourceCache(host, dir).fetchBytes(FILE);
  assert.equal(host.sent.length, 3);
});

// The index names a body by its hash and nothing else, so an entry naming any other file is
// not read.
test("an index entry that names no hash is not read", async () => {
  const dir = cacheDir();
  const outside = path.join(cacheDir(), "secret");
  fs.writeFileSync(outside, "secret");
  fs.writeFileSync(
    path.join(dir, "sources.json"),
    JSON.stringify({ [bytesKey(FILE)]: { sha256: outside } })
  );
  const host = counting();
  assert.equal(
    (await withSourceCache(host, dir).fetchBytes(FILE)).toString(),
    `bytes of ${FILE}`
  );
  assert.deepEqual(host.sent, [FILE]);
});

test("every other request goes to the network untouched", async () => {
  const dir = cacheDir();
  const sent = [];
  const other = {
    fetchJson: async (url) => (sent.push(url), { url }),
    postJson: async (url) => (sent.push(url), { url }),
  };
  const net = withSourceCache(other, dir);
  for (let i = 0; i < 2; i++) {
    await net.fetchJson("https://registry.npmjs.org/x/1.0.0");
    await net.fetchJson("https://unpkg.com/x@1.0.0/package.json");
    await net.postJson("https://example.invalid/post", {});
  }
  assert.equal(sent.length, 6);
  assert.deepEqual(fs.readdirSync(dir), [], "nothing kept");
  assert.equal(listingKey("https://unpkg.com/x@1.0.0/package.json"), null);
  assert.equal(listingKey(META), `meta:${META}`);
});

test("an unreadable index reads as empty", async () => {
  const dir = cacheDir();
  fs.writeFileSync(path.join(dir, "sources.json"), "{ not json");
  const host = counting();
  await withSourceCache(host, dir).fetchBytes(FILE);
  assert.equal(host.sent.length, 1);
});

// A pre-filled 404 (`{fake404: true}`) answers only while the network is switched off: no
// download writes one, so it is a test's offline stand-in for the host's 404, and a real
// review asks the host instead. The switch is read once per process, so the real-review half
// is asked of a child process started without it, with a fake network that records each
// request and makes none, and the same child with the switch on is the control.
test("a pre-filled 404 answers only with the network switched off", () => {
  const module = JSON.stringify(
    path.join(ROOT, "src", "vendor", "source-cache.js")
  );
  const script = `
    import fs from "node:fs";
    import os from "node:os";
    import path from "node:path";
    import { withSourceCache } from ${module};
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-404-"));
    fs.writeFileSync(path.join(dir, "sources.json"), JSON.stringify({
      ${JSON.stringify(`bytes:${FILE}`)}: { fake404: true },
      ${JSON.stringify(`meta:${META}`)}: { fake404: true } }));
    const asked = [];
    const net = withSourceCache({
      fetchBytes: async (url) => { asked.push(url); return Buffer.from("x"); },
      fetchJson: async (url) => { asked.push(url); return {}; },
    }, dir);
    const statuses = [];
    for (const ask of [() => net.fetchBytes(${JSON.stringify(FILE)}),
                       () => net.fetchJson(${JSON.stringify(META)})]) {
      try { await ask(); statuses.push("answer"); }
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
    "a real review asks"
  );
  assert.deepEqual(
    run(true),
    { asked: 0, statuses: [404, 404] },
    "a test reads it"
  );
});

// The body is kept under its sha256, so the same bytes named by two URLs are kept once.
test("the same bytes from two sources are kept once", async () => {
  const dir = cacheDir();
  const same = {
    fetchBytes: async () => Buffer.from("same"),
  };
  const net = withSourceCache(same, dir);
  await net.fetchBytes("https://unpkg.com/a@1.0.0/x.js");
  await net.fetchBytes("https://unpkg.com/b@1.0.0/x.js");
  const sha = createHash("sha256").update("same").digest("hex");
  assert.deepEqual(fs.readdirSync(dir).sort(), [sha, "sources.json"].sort());
});
