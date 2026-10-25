// "load the .xpi" (src/review/start.js loadTheXpi): every review starts there, in a work
// folder it creates, and the review reads the add-on's copy the load left in its xpi/.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";

import { loadTheXpi } from "../../src/review/start.js";
import { runPipeline } from "../../src/pipeline.js";
import { workPaths } from "../../src/util/dest.js";
import { fixtureCacheOpts, freshWorkFolder } from "../seed-caches.js";

const OFFLINE = fixtureCacheOpts();
const MANIFEST = '{"manifest_version":3,"name":"x","version":"1"}';

/** A packed add-on holding `files`, in a fresh folder of its own. */
function packed(files) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content));
  }
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "wl-start-")),
    "addon.xpi"
  );
  zip.writeZip(file);
  return file;
}

// The load creates the folder and extracts the add-on into its xpi/, and answers from that
// copy: what it declares, and no verdict for an add-on without Experiments.
test("the load creates the work folder and extracts the add-on into xpi/", async () => {
  const xpi = packed({ "manifest.json": MANIFEST, "bg.js": "1;\n" });
  const work = freshWorkFolder();
  const loaded = await loadTheXpi(xpi, work, OFFLINE);
  assert.deepEqual(fs.readdirSync(workPaths(work).xpi).sort(), [
    "bg.js",
    "manifest.json",
  ]);
  assert.equal(loaded.manifest.json.name, "x");
  assert.equal(loaded.experiments, false);
  assert.equal(loaded.verification, null);
  assert.equal(loaded.rejected, false);
});

// A folder already there belongs to another review, and is refused rather than shared.
test("the load refuses a work folder that is already there", async () => {
  const xpi = packed({ "manifest.json": MANIFEST });
  const work = freshWorkFolder();
  fs.mkdirSync(work);
  await assert.rejects(loadTheXpi(xpi, work, OFFLINE), (err) => {
    assert.match(err.message, /is already there/);
    assert.ok(err.message.includes(work), "names the folder");
    return true;
  });
  assert.deepEqual(fs.readdirSync(work), [], "nothing written into it");
});

// A broken add-on fails in the load, before any review runs: a link in it, here.
test("a broken add-on fails in the load", async () => {
  const zip = new AdmZip();
  zip.addFile("manifest.json", Buffer.from(MANIFEST));
  zip.addFile("lib/a.js", Buffer.from("../../etc/passwd"));
  zip.getEntry("lib/a.js").attr = (0o120777 << 16) >>> 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-start-"));
  const xpi = path.join(dir, "addon.xpi");
  zip.writeZip(xpi);
  await assert.rejects(
    loadTheXpi(xpi, freshWorkFolder(), OFFLINE),
    /Invalid XPI: lib\/a\.js is a symbolic link/
  );
});

// The review reads the copy the load left, and never extracts the add-on itself: a work folder
// without one is a caller that skipped the load.
test("a review in a work folder without xpi/ is a wiring error", async () => {
  const xpi = packed({ "manifest.json": MANIFEST });
  const work = freshWorkFolder();
  fs.mkdirSync(work);
  await assert.rejects(
    runPipeline({ addonPath: xpi, workFolder: work, ...OFFLINE }),
    /the work folder holds no xpi\//
  );
});
