// Unit tests for resolveLocalManifests (src/vendor/manifest.js): the file:/link: local
// package walk, isolated from classification (resolve.js) and lock resolution (locks.js).
// Pure path arithmetic and store lookups - no network, no lock file involved.

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveLocalManifests } from "../../src/vendor/manifest.js";
import { LOCAL_MANIFEST_MAX_DEPTH } from "../../src/config.js";

// The loader records every directory it walks into, so a fake addon has to carry the same
// fact - derived here from the keys, which is what a real walk of exactly these files would
// have recorded. A directory a Map cannot express (an empty one) is passed explicitly.
function impliedDirectories(keys) {
  const dirs = new Set();
  for (const key of keys) {
    const segs = key.split("/");
    for (let i = 1; i < segs.length; i += 1) {
      dirs.add(segs.slice(0, i).join("/"));
    }
  }
  return [...dirs];
}

function fakeAddon(files, extraDirs = []) {
  const map = new Map();
  for (const [k, v] of Object.entries(files)) {
    map.set(k, Buffer.from(v));
  }
  return {
    files: map,
    directories: [...impliedDirectories(map.keys()), ...extraDirs],
  };
}

test("resolveLocalManifests: no root manifest, or no file:/link: deps, yields nothing", () => {
  assert.deepEqual(resolveLocalManifests(fakeAddon({})), {
    targets: [],
    manifests: [],
  });
  assert.deepEqual(
    resolveLocalManifests(
      fakeAddon({
        "package.json": JSON.stringify({ dependencies: { react: "18.0.0" } }),
      })
    ),
    { targets: [], manifests: [] }
  );
});

test("resolveLocalManifests: a file: target with its own manifest is in both lists", () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { helper: "file:./helper" },
    }),
    "helper/package.json": JSON.stringify({ dependencies: {} }),
    "helper/index.js": "export {};\n",
  });
  const { targets, manifests } = resolveLocalManifests(addon);
  // The MAP is carried, not only the name: a name may be written in several maps with
  // different specs, so what resolved has to say which declaration it was.
  assert.deepEqual(targets, [
    {
      declaringFile: "package.json",
      map: "dependencies",
      name: "helper",
      dir: "helper",
    },
  ]);
  assert.deepEqual(
    manifests.map((m) => m.dir),
    ["helper"]
  );
  assert.equal(manifests[0].file, "helper/package.json");
});

// link: is resolved identically to file: - both are npm's local-path protocols.
test("resolveLocalManifests: link: resolves the same way file: does", () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { helper: "link:./helper" },
    }),
    "helper/package.json": JSON.stringify({ dependencies: {} }),
  });
  const { targets } = resolveLocalManifests(addon);
  assert.deepEqual(targets, [
    {
      declaringFile: "package.json",
      map: "dependencies",
      name: "helper",
      dir: "helper",
    },
  ]);
});

// A directory that exists but carries no readable package.json is still a real target
// (authored code, reviewed wherever it sits) - it just has nothing to recurse into.
test("resolveLocalManifests: a file: target with no manifest is a target but not a manifest", () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { assets: "file:./assets" },
    }),
    "assets/logo.png": "x",
  });
  const { targets, manifests } = resolveLocalManifests(addon);
  assert.deepEqual(targets, [
    {
      declaringFile: "package.json",
      map: "dependencies",
      name: "assets",
      dir: "assets",
    },
  ]);
  assert.deepEqual(manifests, []);
});

// npm's own docs say what a local path may name: "a path to a local directory that
// contains a package". Anything else is a source nobody can verify - a tarball is bytes
// this review never unpacks, and a stray file is not a package at all - so neither is a
// target, and the caller goes on to report each as unsupported.
test("resolveLocalManifests: a spec naming a file is not a directory target", () => {
  for (const [spec, key] of [
    ["file:./libs/payload.tgz", "libs/payload.tgz"],
    ["file:./libs/helper.js", "libs/helper.js"],
    ["file:./README.md", "README.md"],
  ]) {
    const addon = fakeAddon({
      "package.json": JSON.stringify({ dependencies: { d: spec } }),
      [key]: "x",
    });
    const { targets, manifests } = resolveLocalManifests(addon);
    assert.deepEqual(targets, [], spec);
    assert.deepEqual(manifests, [], spec);
  }
});

// An EMPTY directory is still a directory, which is the whole question: npm will fail the
// install for the missing package.json, but that is the developer's problem and not an
// unverifiable source. Only the loader can report this one - a key set names files, so an
// empty directory leaves no trace in it.
test("resolveLocalManifests: an empty directory is a target", () => {
  const addon = fakeAddon(
    { "package.json": JSON.stringify({ dependencies: { d: "file:./empty" } }) },
    ["empty"]
  );
  const { targets, manifests } = resolveLocalManifests(addon);
  assert.deepEqual(targets, [
    {
      declaringFile: "package.json",
      map: "dependencies",
      name: "d",
      dir: "empty",
    },
  ]);
  assert.deepEqual(manifests, []);
});

// "./x", "x" and "a/../x" all normalize to the same store-relative directory.
test("resolveLocalManifests: '.' and '..' segments normalize", () => {
  for (const spec of ["file:./x", "file:x", "file:a/../x", "file:./a/../x/"]) {
    const addon = fakeAddon({
      "package.json": JSON.stringify({ dependencies: { d: spec } }),
      "x/package.json": JSON.stringify({ dependencies: {} }),
    });
    const { targets } = resolveLocalManifests(addon);
    assert.deepEqual(
      targets.map((t) => t.dir),
      ["x"],
      spec
    );
  }
});

// A leading "/" is rejected outright - a store has no filesystem root of its own to
// collide with, so there is nothing a "/"-rooted spec could legitimately mean here.
test("resolveLocalManifests: an absolute-looking target never resolves", () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { d: "file:/etc/passwd" },
    }),
    "etc/passwd": "x", // even if a same-named relative path exists in the store
  });
  assert.deepEqual(resolveLocalManifests(addon), {
    targets: [],
    manifests: [],
  });
});

// A ".." with nothing left to pop escapes the store - left out of both lists entirely, so
// the caller's classifyDeps still rejects it as unsupported (nothing here resolved it).
test("resolveLocalManifests: '..' past the store root does not resolve", () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { d: "file:../outside" },
    }),
  });
  assert.deepEqual(resolveLocalManifests(addon), {
    targets: [],
    manifests: [],
  });
});

// workspace: is deliberately not path-based here (see manifest.js LOCAL_SPEC) - a real
// workspace: value is normally a bare range, not a path, and resolving it needs matching
// against the root's own "workspaces" globs, which this does not implement.
test("resolveLocalManifests: workspace: specs are left unresolved", () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { d: "workspace:*" },
    }),
  });
  assert.deepEqual(resolveLocalManifests(addon), {
    targets: [],
    manifests: [],
  });
});

// A chain that loops back on an ancestor (including the root) is not re-walked, but the
// declaration that closes the loop is still a satisfied target.
test("resolveLocalManifests: a cycle back to the root terminates without recursing forever", () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { nested: "file:./nested" },
    }),
    "nested/package.json": JSON.stringify({
      dependencies: { back: "file:.." },
    }),
  });
  const { targets, manifests } = resolveLocalManifests(addon);
  assert.deepEqual(
    targets.map((t) => `${t.declaringFile}:${t.name}:${t.dir}`),
    ["package.json:nested:nested", "nested/package.json:back:"]
  );
  // Only "nested" has its own manifest recorded - the root is not re-entered as one.
  assert.deepEqual(
    manifests.map((m) => m.dir),
    ["nested"]
  );
});

// A self-referencing directory (a manifest linking back to itself) is the same case: one
// satisfied target, no re-walk, no infinite loop.
test("resolveLocalManifests: a directory linking to itself terminates", () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { nested: "file:./nested" },
    }),
    "nested/package.json": JSON.stringify({
      dependencies: { self: "file:../nested" },
    }),
  });
  const { targets, manifests } = resolveLocalManifests(addon);
  assert.deepEqual(
    targets.map((t) => `${t.declaringFile}:${t.name}:${t.dir}`),
    ["package.json:nested:nested", "nested/package.json:self:nested"]
  );
  assert.deepEqual(
    manifests.map((m) => m.dir),
    ["nested"]
  );
});

// A long CHAIN of distinct directories (not a cycle - each one is new) is bounded by
// LOCAL_MANIFEST_MAX_DEPTH, a runaway guard rather than a policy: real submissions never
// nest this deep, so the cap only ever stops a pathological one.
test("resolveLocalManifests: a long chain of distinct directories is depth-capped", () => {
  const files = {
    "package.json": JSON.stringify({
      dependencies: { d0: "file:./d0" },
    }),
  };
  const chainLength = LOCAL_MANIFEST_MAX_DEPTH + 5;
  for (let i = 0; i < chainLength; i++) {
    files[`d${i}/package.json`] = JSON.stringify({
      dependencies: { [`d${i + 1}`]: `file:../d${i + 1}` },
    });
  }
  const addon = fakeAddon(files);
  const { manifests } = resolveLocalManifests(addon);
  // The walk stops recursing past the cap - strictly fewer manifests than the chain
  // offers, and it terminates at all (no hang/stack overflow) rather than any exact count.
  assert.ok(
    manifests.length < chainLength,
    `${manifests.length} < ${chainLength}`
  );
  assert.ok(manifests.length >= LOCAL_MANIFEST_MAX_DEPTH - 1, manifests.length);
});
