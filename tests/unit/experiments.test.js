// Unit tests for the allowed-Experiments machinery: manifest.json helpers, the
// content-hash verifier, the schema experiment-namespace registration, and the
// experiment-overrides-api check.

import { withManifest, manifestOf } from "./manifest-ctx.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  experimentApiPaths,
  experimentApiNamespaces,
  experimentApiMembers,
  experimentManifestKeys,
  experimentGroups,
} from "../../src/lib/experiments.js";
import {
  experimentVerdict,
  verifyExperiments,
  loadAllowList,
  normalizedSha256,
} from "../../src/experiments/verify.js";
import { extractXpiToTemp } from "../../src/addon/load.js";
import AdmZip from "adm-zip";
import { buildSchemaIndex } from "../../src/schema/index.js";
import { loadSchemaFiles } from "../../src/schema/load.js";
import experimentOverridesApi from "../../src/checks/rules/experiment-overrides-api.js";
import experimentNotAllowed from "../../src/checks/rules/experiment-not-allowed.js";
import experimentModified from "../../src/checks/rules/experiment-modified.js";
import { seedDownload, seedFixtureCache } from "../seed-caches.js";
import {
  resolveExperimentsZip,
  cachedExperimentsPath,
} from "../../src/experiments/fetch.js";
import { DAY_MS } from "../../src/util/cache-age.js";
import { codeloadZipUrl } from "../../src/util/download.js";
import { EXPERIMENTS_REPO } from "../../src/config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXPERIMENTS_FIXTURE = path.join(here, "..", "experiments-fixture");
const schema = buildSchemaIndex(
  loadSchemaFiles(path.join(here, "..", "schema-fixture"))
);

const IMPL_DIR = path.join(EXPERIMENTS_FIXTURE, "demo/experiments/demo");
const fixtureBytes = (rel) => fs.readFileSync(path.join(IMPL_DIR, rel));

// The manifest.json a bundled "demo" experiment declares (the verify tests build the
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

// ---- manifest.json helpers ----
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
// schema.json `namespace` (the manifest.json key and the binding path are arbitrary and
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

// An Experiment schema carrying a BOM declares the same namespaces. Read through the one
// parser (src/util/json.js): a raw JSON.parse throws on the BOM, and the catch here answers
// "declares nothing" - so the add-on's own API surface would go unrecognised with no sign
// that a file had failed to read.
test("an Experiment schema carrying a BOM is still read", () => {
  const manifest = {
    experiment_apis: { qapp: { schema: "api/qapp/schema.json", parent: {} } },
  };
  const schema = '[{"namespace":"manifest"},{"namespace":"qnote"}]';
  for (const text of [schema, `\uFEFF${schema}`]) {
    const files = new Map([["api/qapp/schema.json", Buffer.from(text)]]);
    assert.deepEqual(
      [...experimentApiNamespaces(manifest, files)],
      ["qnote"],
      text.startsWith("\uFEFF") ? "with BOM" : "without BOM"
    );
  }
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

// experimentManifestKeys reads the manifest.json keys an experiment's schema DECLARES
// via a `manifest` $extend block (the calendar-tools shape: calendar_item_action),
// so unrecognized-manifest-key does not flag the developer's own keys.
test("experimentManifestKeys reads $extend-declared manifest keys from the schema", () => {
  const manifest = {
    experiment_apis: {
      cal: { schema: "exp/calendar/schema.json", parent: { paths: [["cal"]] } },
    },
  };
  const files = new Map([
    [
      "exp/calendar/schema.json",
      Buffer.from(
        JSON.stringify([
          {
            namespace: "manifest",
            types: [
              {
                $extend: "WebExtensionManifest",
                properties: {
                  calendar_item_action: {},
                  calendar_item_details: {},
                },
              },
            ],
          },
          { namespace: "calendarItemAction" }, // the callable API, not a manifest key
        ])
      ),
    ],
  ]);
  assert.deepEqual([...experimentManifestKeys(manifest, files)].sort(), [
    "calendar_item_action",
    "calendar_item_details",
  ]);
});

// No experiment / no files / a schema without a manifest.json $extend block -> no keys.
test("experimentManifestKeys is empty without a manifest $extend block", () => {
  assert.deepEqual([...experimentManifestKeys({}, new Map())], []);
  const absent = { experiment_apis: { x: { schema: "missing.json" } } };
  assert.deepEqual([...experimentManifestKeys(absent, new Map())], []);
  const noBlock = { experiment_apis: { x: { schema: "s.json" } } };
  const files = new Map([["s.json", Buffer.from('[{"namespace":"x"}]')]]);
  assert.deepEqual([...experimentManifestKeys(noBlock, files)], []);
});

// An Experiment schema is read as Thunderbird reads it: `//` comments (a licence header, a
// note after a value) leave its namespaces, members and manifest keys declared - and one
// Thunderbird would refuse (a trailing comma) declares nothing.
test("an Experiment schema with // comments declares what it declares", () => {
  const manifest = {
    experiment_apis: {
      widget: { schema: "api/schema.json", parent: { paths: [["widget"]] } },
    },
  };
  const schemaText = `// This Source Code Form is subject to the terms of the MPL.
[
  {
    "namespace": "manifest", // the manifest.json keys this declares
    "types": [
      { "$extend": "WebExtensionManifest", "properties": { "widget_action": {} } }
    ]
  },
  { "namespace": "widget", "functions": [{ "name": "doThing", "type": "function" }] }
]`;
  const files = new Map([["api/schema.json", Buffer.from(schemaText)]]);
  assert.deepEqual(
    [...experimentManifestKeys(manifest, files)],
    ["widget_action"]
  );
  assert.deepEqual([...experimentApiNamespaces(manifest, files)], ["widget"]);
  assert.ok(experimentApiMembers(manifest, files).get("widget").has("doThing"));

  const refused = new Map([
    ["api/schema.json", Buffer.from(schemaText.replace("{} }", "{}, }"))],
  ]);
  assert.deepEqual([...experimentManifestKeys(manifest, refused)], []);
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
  // Both drafts the fixture publishes: demo (demo.json, ext-demo.js,
  // ext-demo-utils.sys.mjs) and notify (notify.json, ext-notify.js).
  assert.equal(fileHashes.size, 5);
  assert.ok(fileHashes.has(normalizedSha256(fixtureBytes("schema/demo.json"))));
  // Parsed from each schema's own `namespace`, which is how an add-on's
  // experiment is recognised by name.
  assert.ok(apiNamespaces.has("demo"));
  assert.ok(apiNamespaces.has("notify"));
});

// ---- verifyExperiments ----
// The artifact carries content; what the add-on DECLARES is the record, passed beside it -
// the same split production makes (src/pipeline.js reads it once off the shipped XPI).
const addon = (files) => ({ files });
const demoRecord = manifestOf(DEMO_MANIFEST);
// The allow-list read from a pre-seeded cache (built from the experiments fixture),
// so verifyExperiments resolves it offline.
const opts = { experimentsCache: seedFixtureCache() };
const status0 = (res) => res.groups[0]?.status;

test("verifyExperiments: pristine bundle is recognised and fully matched", async () => {
  const res = await verifyExperiments(addon(demoFiles()), demoRecord, opts);
  assert.equal(res.pristine, true);
  assert.equal(res.groups[0].name, "demo");
  assert.equal(status0(res), "pristine");
});

test("verifyExperiments: recognised but modified -> modified (not aborted)", async () => {
  const files = demoFiles();
  files.set(
    "experiments/demo/parent/ext-demo.js",
    Buffer.concat([fixtureBytes("parent/ext-demo.js"), Buffer.from("\nx;\n")])
  );
  const res = await verifyExperiments(addon(files), demoRecord, opts);
  assert.equal(res.pristine, false);
  assert.equal(status0(res), "modified");
});

test("verifyExperiments: an extra file in the subtree -> modified", async () => {
  const files = demoFiles();
  files.set("experiments/demo/sneaky.js", Buffer.from("evil();\n"));
  assert.equal(
    status0(await verifyExperiments(addon(files), demoRecord, opts)),
    "modified"
  );
});

test("verifyExperiments: a missing referenced file -> modified", async () => {
  const files = demoFiles();
  files.delete("experiments/demo/schema/demo.json");
  assert.equal(
    status0(await verifyExperiments(addon(files), demoRecord, opts)),
    "modified"
  );
});

// A known API name is not an implementation: a declaration that ships no files of its own
// has nothing that matched upstream, so it is never pristine, beside a group that is.
test("verifyExperiments: a known API name with no files -> unsupported", async () => {
  const manifest = {
    experiment_apis: {
      ...DEMO_MANIFEST.experiment_apis,
      notify: { parent: { paths: [["notify"]] } },
    },
  };
  const res = await verifyExperiments(
    addon(demoFiles()),
    manifestOf(manifest),
    opts
  );
  const status = Object.fromEntries(res.groups.map((g) => [g.name, g.status]));
  assert.deepEqual(status, { demo: "pristine", notify: "unsupported" });
  assert.equal(res.pristine, false);
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
  const res = await verifyExperiments({ files }, manifestOf(manifest), opts);
  assert.equal(res.pristine, false);
  assert.equal(res.groups[0].name, "weather");
  assert.equal(status0(res), "unsupported");
});

// Run `fn` with an empty experiments cache: resolving the allow-list then asks for its
// download, which the switched-off network refuses, proving whether a code path resolves it.
async function withoutNetwork(fn) {
  const emptyCache = fs.mkdtempSync(path.join(os.tmpdir(), "exp-nonet-"));
  try {
    return await fn(emptyCache);
  } finally {
    fs.rmSync(emptyCache, { recursive: true, force: true });
  }
}

test("verifyExperiments: no locatable experiment files -> not pristine, allow-list never resolved", async () => {
  // With no locatable experiment files, the allow-list is never resolved: its download
  // would be refused here if it were, so a plain pristine=false proves the short-circuit.
  await withoutNetwork(async (experimentsCache) => {
    const res = await verifyExperiments(
      { files: new Map() },
      manifestOf({ experiment_apis: { myapi: {} } }),
      { experimentsCache }
    );
    assert.equal(res.groups.length, 1); // the group IS declared - it has no files to verify
    assert.equal(res.pristine, false);
  });
});

test("verifyExperiments: an unfetchable allow-list is a hard fail (throws)", async () => {
  // Files to verify but an empty cache and no network -> resolveExperimentsZip's
  // download fails, and verifyExperiments propagates it (never a review verdict).
  await withoutNetwork((experimentsCache) =>
    assert.rejects(
      () =>
        verifyExperiments(addon(demoFiles()), demoRecord, { experimentsCache }),
      /network request in a test/
    )
  );
});

// ---- schema experiment-namespace registration ----
test("resolveApi marks a registered new prefix as experiment; real APIs still win", () => {
  const s = buildSchemaIndex(
    loadSchemaFiles(path.join(here, "..", "schema-fixture"))
  );
  s.registerExperimentApis([
    ["demo", null],
    ["calendar.items", null],
    ["messages.evil", null],
  ]);
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
  s.registerExperimentApis(experimentApiPaths(manifest).map((p) => [p, null]));
  const ctx = {
    schema: s,
    artifact: {
      manifest: manifestOf(manifest, '{\n  "experiment_apis": {}\n}\n'),
      files: new Map([
        ["manifest.json", Buffer.from('{\n  "experiment_apis": {}\n}\n')],
      ]),
    },
  };
  const out = experimentOverridesApi.run(withManifest(ctx)).findings;
  assert.equal(out.length, 1);
  assert.equal(out[0].item, "messages.evil");
  assert.deepEqual(out[0].loc, { line: 2 });
});

// One key per group, each on its own line, so a locus can tell them apart.
const EXP_MANIFEST_TEXT = `{
  "experiment_apis": {
    "weather": {},
    "messages": {},
    "demo": {}
  }
}
`;

// ---- experiment-not-allowed: per-group abort reasons ----
test("experiment-not-allowed reports shadowing vs unsupported per rejected group", () => {
  const ctx = {
    schema,
    artifact: {
      // Real bytes, so each group's locus resolves to the line its own key sits on -
      // which is what the per-group anchoring below is checking.
      manifest: manifestOf(
        { experiment_apis: { weather: {}, messages: {}, demo: {} } },
        EXP_MANIFEST_TEXT
      ),
      experiments: {
        groups: [
          {
            name: "weather",
            key: "weather",
            status: "unsupported",
            rejected: true,
            apiPaths: ["weather"],
          },
          {
            name: "messages",
            key: "messages",
            status: "unsupported",
            rejected: true,
            apiPaths: ["messages.evil"],
          },
          { name: "demo", key: "demo", status: "modified", apiPaths: ["demo"] },
        ],
      },
      files: new Map([["manifest.json", Buffer.from(EXP_MANIFEST_TEXT)]]),
    },
  };
  const out = experimentNotAllowed.run(withManifest(ctx)).findings;
  assert.equal(out.length, 2); // only the two rejected groups (not the modified one)
  // Each finding anchors on its OWN experiment_apis key, not on the block they share.
  const weather = out.find((f) => f.loc.line === 3);
  assert.match(weather.hint, /not a published Thunderbird API draft/);
  const msgs = out.find((f) => f.loc.line === 4);
  assert.match(msgs.hint, /shadows the built-in messages API/);
});

const MODIFIED_MANIFEST_TEXT = `{
  "experiment_apis": {
    "calendar": {},
    "demo": {}
  }
}
`;

// ---- experiment-modified: continue-path flag ----
test("experiment-modified flags only modified groups", () => {
  const ctx = {
    artifact: {
      manifest: manifestOf(
        { experiment_apis: { calendar: {}, demo: {} } },
        MODIFIED_MANIFEST_TEXT
      ),
      experiments: {
        groups: [
          {
            name: "calendar",
            key: "calendar",
            status: "modified",
            apiPaths: ["calendar.items"],
          },
          { name: "demo", key: "demo", status: "pristine", apiPaths: ["demo"] },
        ],
      },
      files: new Map([["manifest.json", Buffer.from(MODIFIED_MANIFEST_TEXT)]]),
    },
  };
  const out = experimentModified.run(withManifest(ctx)).findings;
  assert.equal(out.length, 1);
  assert.equal(out[0].item, "calendar");
  // The group's own key, not the block it sits in.
  assert.deepEqual(out[0].loc, { line: 3 });
});

// The allowed list moves upstream - an Experiment approved, one withdrawn - so a cached copy
// older than a day is downloaded again before it is used, and a fresh one is used as is.
test("resolveExperimentsZip downloads a list older than a day again", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-age-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cached = cachedExperimentsPath(dir, "main");
  fs.writeFileSync(cached, "old zip");

  // Nothing seeded yet: the switched-off network refuses a request for the fresh copy.
  const fresh = await resolveExperimentsZip({ branch: "main", cacheDir: dir });
  assert.equal(
    fresh.source,
    "cache:main",
    "a fresh copy is used without a request"
  );

  // Once older than a day it is downloaded again, which the switched-off network refuses,
  // naming the request.
  const old = new Date(Date.now() - 2 * DAY_MS);
  fs.utimesSync(cached, old, old);
  await assert.rejects(
    resolveExperimentsZip({ branch: "main", cacheDir: dir }),
    (err) =>
      err.message.includes(
        `network request in a test: ${codeloadZipUrl(EXPERIMENTS_REPO, "main")}`
      )
  );

  // With the host's 200 seeded in the cached file, the download replaces it, and the new
  // copy is what the next run reads.
  seedDownload(cached, { status: 200, body: "new zip" });
  const stale = await resolveExperimentsZip({ branch: "main", cacheDir: dir });
  assert.equal(stale.source, "download:main");
  assert.equal(fs.readFileSync(cached, "utf8"), "new zip", "cache rewritten");
  const again = await resolveExperimentsZip({ branch: "main", cacheDir: dir });
  assert.equal(again.source, "cache:main");
});

// The verdict --llm-sca-review asks before it prepares a review, by the rule the review's own
// step asks it by, of the .xpi extracted to a temporary folder.
test("experimentVerdict reads an extracted .xpi as the review would", async () => {
  const fixtures = path.join(here, "..", "addons");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-verdict-"));
  const verdictOf = async (name, extra = {}) => {
    const zip = new AdmZip();
    zip.addLocalFolder(path.join(fixtures, name));
    const xpi = path.join(dir, `${name}.xpi`);
    zip.writeZip(xpi);
    const folder = extractXpiToTemp(xpi);
    try {
      assert.deepEqual(
        fs.readdirSync(folder).sort(),
        fs.readdirSync(path.join(fixtures, name)).sort()
      );
      const { verification, invalid } = await experimentVerdict(folder, {
        ...opts,
        ...extra,
      });
      return {
        invalid,
        groups: verification.groups.map((g) => [g.status, g.rejected]),
      };
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  };
  // The verdict is the one reader of --allow-experiments: it marks each group it rejects,
  // and `invalid` is whether any is. Allowed, the unsupported group is still classified
  // as one, and rejected by nobody.
  assert.deepEqual(await verdictOf("experiment-disallowed"), {
    invalid: true,
    groups: [["unsupported", true]],
  });
  assert.deepEqual(await verdictOf("experiment-pristine"), {
    invalid: false,
    groups: [["pristine", false]],
  });
  assert.deepEqual(
    await verdictOf("experiment-disallowed", { allowExperiments: true }),
    { invalid: false, groups: [["unsupported", false]] }
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
