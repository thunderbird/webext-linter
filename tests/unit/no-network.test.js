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

// A cache answers with a pre-filled 404 (`{fake404: true}`) only while the network is switched
// off: no cache writes one, so it is a test's offline stand-in for the host's 404, and a real
// run must ask the host instead. The switch is read once per process, so the real-run half is
// asked of a child process started without it - with a fake network that records each request
// and makes none - and the same child with the switch on is the control.
test("a pre-filled 404 answers a cache only with the network switched off", () => {
  const src = (rel) => JSON.stringify(path.join(ROOT, "src", rel));
  const script = `
    import fs from "node:fs";
    import os from "node:os";
    import path from "node:path";
    import { createHash } from "node:crypto";
    import { resolveCdnLibraries } from ${src("lib/cdn-lookup.js")};
    import { classifyBundled } from ${src("lib/bundled.js")};
    import { findLockInjections } from ${src("vendor/locks.js")};
    const fake404 = () => Object.assign(new Error("HTTP 404"), { status: 404 });
    const recording = () => {
      const asked = [];
      return { asked, fetchJson: async (url) => { asked.push(url); throw fake404(); } };
    };
    const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wl-404-"));

    const bytes = Buffer.from("var a=0;" + "a=a+1;".repeat(250));
    const cdn = { files: new Map([["x.min.js", bytes]]) };
    cdn.bundled = classifyBundled(cdn);
    const cdnDir = tmp();
    const hash = createHash("sha256").update(bytes).digest("hex");
    fs.writeFileSync(path.join(cdnDir, "jsdelivr-hash-lookup.json"),
      JSON.stringify({ [hash]: { fake404: true } }));
    const cdnNet = recording();
    await resolveCdnLibraries(cdn, { net: cdnNet, cacheDir: cdnDir });

    const lock = { lockfileVersion: 3, packages: { "": { name: "x" },
      "node_modules/gone": { version: "1.0.0",
        resolved: "https://registry.npmjs.org/gone/-/elsewhere.tgz" } } };
    const reg = { files: new Map([
      ["package.json", Buffer.from(JSON.stringify({ name: "x" }))],
      ["package-lock.json", Buffer.from(JSON.stringify(lock))]]), directories: [] };
    const regDir = tmp();
    fs.writeFileSync(path.join(regDir, "npm-registry.json"),
      JSON.stringify({ "gone@1.0.0": { fake404: true } }));
    const regNet = recording();
    await findLockInjections(reg, { net: regNet, cacheDir: regDir });

    console.log(JSON.stringify({ cdn: cdnNet.asked.length, registry: regNet.asked.length }));
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
  assert.deepEqual(run(false), { cdn: 1, registry: 1 }, "a real run asks");
  assert.deepEqual(run(true), { cdn: 0, registry: 0 }, "a test reads it");
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
