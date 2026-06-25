// Unit tests for the allowed-Experiments machinery: manifest helpers, the
// content-hash verifier, the schema experiment-namespace registration, and the
// experiment-overrides-api check.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  experimentApiPaths,
  experimentApiNamespaces,
  experimentGroups,
} from "../../src/checks/lib/experiments.js";
import {
  verifyExperiments,
  loadAllowList,
  normalizedSha256,
} from "../../src/experiments/verify.js";
import { buildSchemaIndex } from "../../src/schema/index.js";
import { loadSchemaFiles } from "../../src/schema/load.js";
import experimentOverridesApi from "../../src/checks/rules/experiment-overrides-api.js";
import experimentNotAllowed from "../../src/checks/rules/experiment-not-allowed.js";
import experimentModified from "../../src/checks/rules/experiment-modified.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXPERIMENTS_FIXTURE = path.join(here, "..", "experiments-fixture");
const schema = buildSchemaIndex(
  loadSchemaFiles(path.join(here, "..", "schema-fixture"))
);

const IMPL_DIR = path.join(EXPERIMENTS_FIXTURE, "demo/experiments/demo");
const fixtureBytes = (rel) => fs.readFileSync(path.join(IMPL_DIR, rel));

// The manifest a bundled "demo" experiment declares (the verify tests build the
// add-on file map around it).
const DEMO_MANIFEST = {
  experiment_apis: {
    demo: {
      schema: "experiments/demo/schema/demo.json",
      parent: {
        scopes: ["addon_parent"],
        script: "experiments/demo/parent/ext-demo.js",
        paths: [["demo"]],
      },
    },
  },
};

const demoFiles = () =>
  new Map([
    ["experiments/demo/schema/demo.json", fixtureBytes("schema/demo.json")],
    ["experiments/demo/parent/ext-demo.js", fixtureBytes("parent/ext-demo.js")],
    [
      "experiments/demo/ext-demo-utils.sys.mjs",
      fixtureBytes("ext-demo-utils.sys.mjs"),
    ],
  ]);

// ---- manifest helpers ----
test("experiment helpers read paths, file refs and the subtree root", () => {
  assert.deepEqual(experimentApiPaths(DEMO_MANIFEST), ["demo"]);
  // A multi-segment path joins with dots; an entry without paths falls back to key.
  assert.deepEqual(
    experimentApiPaths({
      experiment_apis: {
        a: { parent: { paths: [["calendar", "items"]] } },
        weatherKey: {},
      },
    }),
    ["calendar.items", "weatherKey"]
  );
});

// experimentApiNamespaces reads the exposed namespace from each entry's bundled
// schema.json `namespace` (the manifest key and the binding path are arbitrary and
// often differ), excluding the schema-only `manifest` block. Falls back to the
// declared paths/key only when no schema file is readable.
test("experimentApiNamespaces reads the schema.json namespace, not the key/path", () => {
  // key 'qapp' + path 'qapp', but the schema exposes 'qnote' (real qnote case).
  const manifest = {
    experiment_apis: {
      qapp: { schema: "api/qapp/schema.json", parent: { paths: [["qapp"]] } },
    },
  };
  const files = new Map([
    [
      "api/qapp/schema.json",
      Buffer.from('[{"namespace":"manifest"},{"namespace":"qnote"}]'),
    ],
  ]);
  assert.deepEqual([...experimentApiNamespaces(manifest, files)], ["qnote"]);
  // A dotted namespace registers its top segment (calendar.provider -> calendar).
  const cal = {
    experiment_apis: {
      calProv: { schema: "s.json", parent: { paths: [["x"]] } },
    },
  };
  const calFiles = new Map([
    ["s.json", Buffer.from('[{"namespace":"calendar.provider"}]')],
  ]);
  assert.deepEqual([...experimentApiNamespaces(cal, calFiles)], ["calendar"]);
});

test("experimentApiNamespaces falls back to paths/key without a readable schema", () => {
  const manifest = {
    experiment_apis: {
      Foo: { schema: "missing.json", parent: { paths: [["Bar"]] } }, // file absent -> path
      Baz: {}, // no paths, no schema -> key
    },
  };
  assert.deepEqual([...experimentApiNamespaces(manifest)].sort(), [
    "Bar",
    "Baz",
  ]); // no files
  assert.deepEqual([...experimentApiNamespaces(manifest, new Map())].sort(), [
    "Bar",
    "Baz",
  ]); // schema not in the file map -> still falls back
});

// ---- normalizedSha256 is EOL-tolerant ----
test("normalizedSha256 ignores CRLF/LF and trailing newlines", () => {
  assert.equal(
    normalizedSha256(Buffer.from("a\r\nb\n")),
    normalizedSha256(Buffer.from("a\nb"))
  );
});

// ---- experimentGroups ----
test("experimentGroups groups entries by their experiments/<seg>/ subtree", () => {
  const groups = experimentGroups({
    experiment_apis: {
      cal1: {
        schema: "x/experiments/calendar/schema/a.json",
        parent: {
          script: "x/experiments/calendar/parent/a.js",
          paths: [["calendar", "items"]],
        },
      },
      cal2: {
        parent: {
          script: "x/experiments/calendar/parent/b.js",
          paths: [["calendar", "calendars"]],
        },
      },
      note: {
        parent: {
          script: "x/experiments/notify/parent/n.js",
          paths: [["notify"]],
        },
      },
    },
  });
  assert.equal(groups.length, 2); // calendar (cal1+cal2) + notify
  const cal = groups.find((g) => g.name === "calendar");
  assert.equal(cal.entries.length, 2);
  assert.deepEqual([...cal.apiNamespaces], ["calendar"]);
});

// ---- loadAllowList ----
test("loadAllowList collects file hashes and upstream API namespaces", () => {
  const { fileHashes, apiNamespaces } = loadAllowList(EXPERIMENTS_FIXTURE);
  assert.equal(fileHashes.size, 3); // demo.json, ext-demo.js, ext-demo-utils.sys.mjs
  assert.ok(fileHashes.has(normalizedSha256(fixtureBytes("schema/demo.json"))));
  assert.ok(apiNamespaces.has("demo")); // parsed from the demo schema's namespace
});

// ---- verifyExperiments ----
const addon = (files) => ({ manifest: DEMO_MANIFEST, files });
const opts = { experimentsZip: EXPERIMENTS_FIXTURE };
const status0 = (res) => res.groups[0]?.status;

test("verifyExperiments: pristine bundle is recognised and fully matched", async () => {
  const res = await verifyExperiments(addon(demoFiles()), opts);
  assert.equal(res.pristine, true);
  assert.equal(res.trustedFiles.size, 3);
  assert.equal(res.groups[0].name, "demo");
  assert.equal(status0(res), "pristine");
});

test("verifyExperiments: recognised but modified -> modified (not aborted)", async () => {
  const files = demoFiles();
  files.set(
    "experiments/demo/parent/ext-demo.js",
    Buffer.concat([fixtureBytes("parent/ext-demo.js"), Buffer.from("\nx;\n")])
  );
  const res = await verifyExperiments(addon(files), opts);
  assert.equal(res.pristine, false);
  assert.equal(status0(res), "modified");
  assert.equal(res.trustedFiles.size, 3); // modified files are still trusted (continue path)
});

test("verifyExperiments: an extra file in the subtree -> modified", async () => {
  const files = demoFiles();
  files.set("experiments/demo/sneaky.js", Buffer.from("evil();\n"));
  assert.equal(
    status0(await verifyExperiments(addon(files), opts)),
    "modified"
  );
});

test("verifyExperiments: a missing referenced file -> modified", async () => {
  const files = demoFiles();
  files.delete("experiments/demo/schema/demo.json");
  assert.equal(
    status0(await verifyExperiments(addon(files), opts)),
    "modified"
  );
});

test("verifyExperiments: an unknown API name -> unsupported", async () => {
  const manifest = {
    experiment_apis: {
      weather: {
        schema: "experiments/weather/schema/w.json",
        parent: {
          script: "experiments/weather/parent/w.js",
          paths: [["weather"]],
        },
      },
    },
  };
  const files = new Map([
    [
      "experiments/weather/schema/w.json",
      Buffer.from('[{"namespace":"weather"}]\n'),
    ],
    ["experiments/weather/parent/w.js", Buffer.from('"use strict";\n')],
  ]);
  const res = await verifyExperiments({ manifest, files }, opts);
  assert.equal(res.pristine, false);
  assert.equal(res.groups[0].name, "weather");
  assert.equal(status0(res), "unsupported");
});

test("verifyExperiments: no locatable experiment files -> not pristine, no fetch", async () => {
  const res = await verifyExperiments(
    { manifest: { experiment_apis: { myapi: {} } }, files: new Map() },
    { experimentsZip: "/does/not/exist" } // would throw if it tried to fetch
  );
  assert.equal(res.pristine, false);
});

test("verifyExperiments: an unfetchable allow-list throws (hard fail)", async () => {
  await assert.rejects(
    () =>
      verifyExperiments(addon(demoFiles()), {
        experimentsZip: "/no/such/repo",
      }),
    /experiments-zip not found/
  );
});

// ---- schema experiment-namespace registration ----
test("resolveApi marks a registered new prefix as experiment; real APIs still win", () => {
  const s = buildSchemaIndex(
    loadSchemaFiles(path.join(here, "..", "schema-fixture"))
  );
  s.registerExperimentNamespaces(["demo", "calendar.items", "messages.evil"]);
  assert.equal(s.resolveApi(["demo", "doThing"]).kind, "experiment");
  assert.equal(
    s.resolveApi(["calendar", "items", "create"]).kind,
    "experiment"
  );
  // The real "messages" namespace wins over an experiment grafting onto it.
  assert.equal(s.resolveApi(["messages", "list"]).kind, "function");
  assert.equal(s.resolveApi(["messages", "evil"]).kind, "unknown-member");
});

// ---- experiment-overrides-api ----
test("experiment-overrides-api flags a path that grafts onto a built-in", () => {
  const s = buildSchemaIndex(
    loadSchemaFiles(path.join(here, "..", "schema-fixture"))
  );
  const manifest = {
    experiment_apis: {
      ok: { parent: { paths: [["brandnew"]] } },
      bad: { parent: { paths: [["messages", "evil"]] } },
    },
  };
  s.registerExperimentNamespaces(experimentApiPaths(manifest));
  const ctx = {
    schema: s,
    addon: {
      manifest,
      files: new Map([
        ["manifest.json", Buffer.from('{\n  "experiment_apis": {}\n}\n')],
      ]),
    },
  };
  const out = experimentOverridesApi.run(ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].item, "messages.evil");
  assert.deepEqual(out[0].loc, { line: 2, column: 0 });
});

// ---- experiment-not-allowed: per-group abort reasons ----
test("experiment-not-allowed reports shadowing vs unsupported per unsupported group", () => {
  const ctx = {
    schema,
    options: {},
    addon: {
      manifest: { experiment_apis: { a: {} } },
      experiments: {
        groups: [
          {
            name: "weather",
            line: 5,
            status: "unsupported",
            apiPaths: ["weather"],
          },
          {
            name: "messages",
            line: 6,
            status: "unsupported",
            apiPaths: ["messages.evil"],
          },
          { name: "demo", line: 7, status: "modified", apiPaths: ["demo"] },
        ],
      },
      files: new Map([["manifest.json", Buffer.from("{}\n")]]),
    },
  };
  const out = experimentNotAllowed.run(ctx);
  assert.equal(out.length, 2); // only the two unsupported groups (not the modified one)
  const weather = out.find((f) => f.loc.line === 5);
  assert.match(weather.hint, /not a published Thunderbird API draft/);
  const msgs = out.find((f) => f.loc.line === 6);
  assert.match(msgs.hint, /shadows the built-in messages API/);
});

// ---- experiment-modified: continue-path flag ----
test("experiment-modified flags only modified groups", () => {
  const ctx = {
    addon: {
      manifest: { experiment_apis: { a: {} } },
      experiments: {
        groups: [
          {
            name: "calendar",
            line: 8,
            status: "modified",
            apiPaths: ["calendar.items"],
          },
          { name: "demo", line: 12, status: "pristine", apiPaths: ["demo"] },
        ],
      },
      files: new Map(),
    },
  };
  const out = experimentModified.run(ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].item, "calendar");
  assert.deepEqual(out[0].loc, { line: 8, column: 0 });
});
