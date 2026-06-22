// Unit tests for the core-loader scanner (src/parse/core-loaders.js) and its
// integration into the Experiment dependency closure (reachability.js).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  scanCoreLoaderRefs,
  scanExperimentInjectedRefs,
} from "../../src/parse/core-loaders.js";
import { buildReachability } from "../../src/checks/lib/reachability.js";
import { classifyExperimentNamespaces } from "../../src/checks/lib/experiments.js";
import { buildRunContext } from "../../src/checks/context.js";
import { loadSchemaFiles } from "../../src/schema/load.js";
import { buildSchemaIndex } from "../../src/schema/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = buildSchemaIndex(
  loadSchemaFiles(path.join(here, "..", "schema-fixture"))
);

const refs = (code) =>
  scanCoreLoaderRefs(code)
    .refs.map((r) => `${r.kind}:${r.value}`)
    .sort();

// ---- scanCoreLoaderRefs ----
// rootURI/baseURI.resolve("path") is a precise root-relative reference, found
// bare or wrapped in a loader, under any object prefix.
test("rootURI.resolve yields a root-relative path", () => {
  assert.deepEqual(refs(`x.rootURI.resolve("content/helper.js")`), [
    "path:content/helper.js",
  ]);
  assert.deepEqual(
    refs(`loadSubScript(this.extension.rootURI.resolve("a/b.js"), {})`),
    ["path:a/b.js"]
  );
  assert.deepEqual(refs(`u.baseURI.resolve("c.js")`), ["path:c.js"]);
});

// A scheme-bearing URL (resource://, chrome://) the add-on registered for a file
// is matched by NAME, in importESModule / defineESModuleGetters / loadSubScript and
// static imports.
test("registered resource://chrome:// URLs are basename references", () => {
  assert.deepEqual(
    refs(`ChromeUtils.importESModule("resource:///m/Foo.sys.mjs")`),
    ["basename:Foo.sys.mjs"]
  );
  assert.deepEqual(
    refs(
      `ChromeUtils.defineESModuleGetters(this, { A: "resource:///x/Bar.sys.mjs", B: "chrome://m/Baz.js" })`
    ),
    ["basename:Bar.sys.mjs", "basename:Baz.js"]
  );
  assert.deepEqual(refs(`L.loadSubScript("resource:///q/Qux.js")`), [
    "basename:Qux.js",
  ]);
  assert.deepEqual(
    refs(`import { cal } from "resource:///m/calUtils.sys.mjs";`),
    ["basename:calUtils.sys.mjs"]
  );
});

// Dynamic args, remote/data URLs, and relative paths (the WebExtension loaders'
// job) yield no core-loader reference.
test("dynamic, remote, and relative arguments are ignored", () => {
  assert.deepEqual(
    scanCoreLoaderRefs(`L.loadSubScript(__SCRIPT_URI_SPEC__)`).refs,
    []
  );
  assert.deepEqual(
    scanCoreLoaderRefs(`ChromeUtils.importESModule(someVar)`).refs,
    []
  );
  assert.deepEqual(
    scanCoreLoaderRefs(`import x from "https://cdn/lib.js";`).refs,
    []
  );
  assert.deepEqual(scanCoreLoaderRefs(`import x from "./local.js";`).refs, []);
});

// ---- integration: the Experiment closure ----
// A parent script reaches add-on files two ways - rootURI.resolve (root-relative)
// and a registered resource:// URL (by name). Both land in experimentReachable AND
// reachable (so they are not flagged unused). A name that collides with a file the
// WebExtension tracer already reached is NOT re-matched (that file stays a normal
// WebExtension file), and an unmatched core module adds nothing.
test("the Experiment closure follows rootURI.resolve + registered URL names", () => {
  const manifest = {
    manifest_version: 3,
    experiment_apis: {
      demo: {
        parent: { script: "experiments/demo/parent.js", paths: [["demo"]] },
      },
    },
    content_scripts: [{ matches: ["*://*/*"], js: ["content/lib.js"] }],
  };
  const parent = `
    this.demo = class extends ExtensionAPI {
      getAPI(context) {
        ChromeUtils.importESModule("resource:///modules/MyMod.sys.mjs");
        ChromeUtils.importESModule("resource:///modules/lib.js");
        ChromeUtils.importESModule("resource:///modules/NoSuch.sys.mjs");
        Services.scriptloader.loadSubScript(
          context.extension.rootURI.resolve("content/y.js")
        );
        return { demo: {} };
      }
    };`;
  const files = new Map(
    Object.entries({
      "manifest.json": JSON.stringify(manifest),
      "experiments/demo/parent.js": parent,
      "modules/MyMod.sys.mjs": "export const value = 1;",
      "content/y.js": "globalThis.y = 1;",
      "content/lib.js": "globalThis.lib = 1;",
    }).map(([k, v]) => [k, Buffer.from(v)])
  );
  const ctx = buildRunContext({
    addon: { files, manifest },
    schema,
    options: {},
    invalidExperiment: false,
  });
  const reach = buildReachability(ctx);

  // The two referenced add-on files are in the Experiment tree...
  assert.ok(reach.experimentReachable.has("modules/MyMod.sys.mjs")); // by name
  assert.ok(reach.experimentReachable.has("content/y.js")); // rootURI.resolve
  assert.ok(reach.experimentReachable.has("experiments/demo/parent.js"));
  // ...and therefore reachable (not unused).
  assert.ok(reach.reachable.has("modules/MyMod.sys.mjs"));
  assert.ok(reach.reachable.has("content/y.js"));
  // The name "lib.js" collides with a tracked content script: NOT re-matched, so
  // the content script stays a normal WebExtension file (subject to the API checks).
  assert.ok(!reach.experimentReachable.has("content/lib.js"));
});

// ---- scanExperimentInjectedRefs ----
// File arguments (top level + one level inside an array) of a call into an
// Experiment namespace, via any WebExtension root (browser/messenger/chrome).
// A relative path is root-relative; a scheme URL is by name; a call into a
// non-experiment namespace is ignored.
test("scanExperimentInjectedRefs extracts file args of experiment-namespace calls", () => {
  const ns = new Set(["wl", "ui"]);
  const code = `
    messenger.wl.registerWindow("chrome://x/win.xhtml", "content/entry.js");
    browser.ui.add("content/page.js");
    chrome.wl.list(["a/b.js", "chrome://m/C.js"]);
    messenger.other.run("content/skip.js");
    messenger.wl.noFileArg(42);
  `;
  const got = scanExperimentInjectedRefs(code, ns)
    .refs.map((r) => `${r.ns}:${r.kind}:${r.value}`)
    .sort();
  assert.deepEqual(got, [
    "ui:path:content/page.js",
    "wl:basename:C.js",
    "wl:basename:win.xhtml",
    "wl:path:a/b.js",
    "wl:path:content/entry.js",
  ]);
});

// ---- classifyExperimentNamespaces ----
// A namespace is classified by what its parent.script does: subscript-load -> core,
// a WebExtension <browser> at an extension URL -> webext, neither/both -> unsure.
test("classifyExperimentNamespaces buckets by what the parent.script does", () => {
  const addonWith = (script) => ({
    manifest: {
      experiment_apis: {
        a: { parent: { script: "experiments/a/p.js", paths: [["a"]] } },
      },
    },
    files: new Map([["experiments/a/p.js", Buffer.from(script)]]),
  });
  const cls = (script) =>
    classifyExperimentNamespaces(addonWith(script)).get("a");
  assert.equal(cls(`Services.scriptloader.loadSubScript(x, {})`), "core");
  assert.equal(
    cls(`d.createXULElement("browser"); b.src = e.baseURI.resolve(p)`),
    "webext"
  );
  assert.equal(cls(`somethingElse(p)`), "unsure"); // neither
  assert.equal(
    cls(`loadSubScript(x); createXULElement("browser"); e.baseURI.resolve(p)`),
    "unsure" // both
  );
});

// ---- integration: the three mixed-file outcomes ----
// A parameter to a CORE namespace (and the file IT loadSubScripts) is exempt; a
// parameter to a WEBEXT namespace is NOT exempt but is reachable (not unused); a
// parameter to an UNSURE namespace is deferred (exempt now) with an `unsure` note.
test("experiment parameters are exempt/checked/deferred by namespace class", () => {
  const manifest = {
    manifest_version: 3,
    background: { scripts: ["background.js"] },
    experiment_apis: {
      wl: { parent: { script: "experiments/wl/p.js", paths: [["wl"]] } },
      ui: { parent: { script: "experiments/ui/p.js", paths: [["ui"]] } },
      mystery: {
        parent: { script: "experiments/mystery/p.js", paths: [["mystery"]] },
      },
    },
  };
  const files = new Map(
    Object.entries({
      "manifest.json": JSON.stringify(manifest),
      "background.js": `messenger.wl.registerWindow("x.xhtml","content/entry.js");browser.ui.add("content/page.js");messenger.mystery.run("content/maybe.js");`,
      "experiments/wl/p.js": `Services.scriptloader.loadSubScript(s, {})`,
      "experiments/ui/p.js": `d.createXULElement("browser"); b.src = e.baseURI.resolve(p)`,
      "experiments/mystery/p.js": `magic(p)`,
      "content/entry.js": `Services.scriptloader.loadSubScript("chrome://x/content/core.js", w)`,
      "content/core.js": `messenger.msgHdrFromURI("x")`,
      "content/page.js": `browser.bogusApi()`,
      "content/maybe.js": `messenger.bogusThing()`,
    }).map(([k, v]) => [k, Buffer.from(v)])
  );
  const notes = [];
  const ctx = buildRunContext({
    addon: { files, manifest },
    schema,
    options: {},
    invalidExperiment: false,
  });
  ctx.note = (file, loc, item, verdict) => notes.push({ item, verdict });
  const reach = buildReachability(ctx);

  // CORE: the passed entry + the file it loadSubScripts are exempt.
  assert.ok(reach.experimentReachable.has("content/entry.js"));
  assert.ok(reach.experimentReachable.has("content/core.js"));
  // UNSURE: deferred (exempt) and an `unsure` note was emitted for it.
  assert.ok(reach.experimentReachable.has("content/maybe.js"));
  assert.deepEqual(
    notes.filter((n) => n.verdict === "unsure").map((n) => n.item),
    ["content/maybe.js"]
  );
  // WEBEXT: NOT exempt, but reachable (not flagged unused).
  assert.ok(!reach.experimentReachable.has("content/page.js"));
  assert.ok(reach.reachable.has("content/page.js"));
});
