// The tests run with the network switched off (tests/offline.js): a request that would reach
// another machine fails the run, named, rather than quietly answering. These pin that the
// switch holds - in this process, and in a verify.js a test spawns - and that no caller that
// tolerates a failed request can swallow it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchWithTimeout } from "../../src/util/net.js";
import { addonOutsideRepo, seedFixtureCache } from "../seed-caches.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");

test("the tests run with the network switched off", () => {
  assert.equal(process.env.WEBEXT_LINTER_NO_NETWORK, "1");
});

test("a request to another machine is refused, in this process", async () => {
  await assert.rejects(
    () => fetchWithTimeout("https://example.com/", (r) => r.text()),
    /network request in a test: https:\/\/example\.com\//
  );
});

// A loopback host is refused like any other: no test opens a socket, so none is let through.
test("a request to this machine is refused too", async () => {
  await assert.rejects(
    () => fetchWithTimeout("http://127.0.0.1:9/", (r) => r.text()),
    /network request in a test: http:\/\/127\.0\.0\.1:9\//
  );
});

// The CDN lookup tolerates one failed lookup, so a refusal it could swallow would let the
// review finish on a request it was never allowed to make. Given a cache with no answer for
// the shipped file, the lookup has to ask, and the run has to fail naming the request.
test("a request a spawned review makes is refused, and ends the run", () => {
  const fixture = addonOutsideRepo(
    path.join(ROOT, "tests", "addons", "build-hygiene-sca")
  );
  const cache = seedFixtureCache();
  const emptyCdn = fs.mkdtempSync(path.join(path.dirname(fixture), "cdn-"));
  const r = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "verify.js"),
      path.join(fixture, "xpi"),
      "--sca-root",
      path.join(fixture, "src"),
      "--cache-schema-dir",
      cache,
      "--cache-hash-db-dir",
      cache,
      "--cache-experiments-dir",
      cache,
      "--cache-npm-registry-dir",
      cache,
      "--cache-sources-dir",
      cache,
      "--cache-cdn-lookup-dir",
      emptyCdn,
      "--cdn-lib-lookup",
      "true",
    ],
    { encoding: "utf8" }
  );
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(
    r.stderr,
    /network request in a test: https:\/\/data\.jsdelivr\.com\//
  );
});

// A seeded response (`{fake: ...}`) is read from a cache entry only while the network is
// switched off: no cache writes one, so it is a test's stand-in for what the host does, and a
// real run asks the host with nothing seeded. The switch is read once per process, so the
// real-run half is asked of a child process started without it, and the same child with the
// switch on is the control.
test("a seeded response is read only with the network switched off", () => {
  const src = (rel) => JSON.stringify(path.join(ROOT, "src", rel));
  const script = `
    import fs from "node:fs";
    import os from "node:os";
    import path from "node:path";
    import { seededResponse } from ${src("util/net.js")};
    import { seededDownload } from ${src("util/download.js")};
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wl-404-")), "x.zip");
    fs.writeFileSync(file, JSON.stringify({ fake: { status: 404 } }));
    console.log(JSON.stringify({
      response: seededResponse({ fake: { status: 404 } }) ?? null,
      download: seededDownload(file) ?? null,
    }));
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
    { response: null, download: null },
    "a real run asks the host"
  );
  assert.deepEqual(
    run(true),
    { response: { status: 404 }, download: { status: 404 } },
    "a test plays it"
  );
});

// --cache-work-dir lets a test seed the answers a run reads, so a real run, with the network
// on, does not know it: refused exactly as a flag that does not exist, and named on no help
// screen. Asked of a child process started without the switch, and with it as the control.
test("--cache-work-dir is an unknown option with the network on", () => {
  const run = (switchedOff, args) => {
    const env = { ...process.env };
    if (switchedOff) {
      env.WEBEXT_LINTER_NO_NETWORK = "1";
    } else {
      delete env.WEBEXT_LINTER_NO_NETWORK;
    }
    return spawnSync(
      process.execPath,
      [path.join(ROOT, "verify.js"), ...args],
      {
        encoding: "utf8",
        env,
      }
    );
  };
  const given = run(false, ["--cache-work-dir", "x", "--help"]);
  const unknown = run(false, ["--no-such-dir", "x", "--help"]);
  assert.equal(given.status, 2);
  assert.match(given.stderr, /Unknown option '--cache-work-dir'/);
  assert.equal(
    given.stdout + given.stderr,
    (unknown.stdout + unknown.stderr).replaceAll(
      "--no-such-dir",
      "--cache-work-dir"
    )
  );
  const offline = run(true, ["--cache-work-dir", "x", "--help"]);
  assert.equal(offline.status, 0, offline.stderr);
  const help = offline.stdout.slice(offline.stdout.indexOf("Usage:"));
  assert.match(help, /--cache-schema-dir/);
  assert.doesNotMatch(help, /cache-work-dir/);
});
