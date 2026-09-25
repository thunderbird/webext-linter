// Unit tests for resolveLocalPackageFiles (src/vendor/package-file.js): the file:/link: local
// package walk, isolated from classification (resolve.js) and lock resolution (locks.js).
// Pure path arithmetic and store lookups - no network, no lock file involved.

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveLocalPackageFiles } from "../../src/vendor/package-file.js";
import { LOCAL_PACKAGE_FILE_MAX_DEPTH } from "../../src/config.js";

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

test("resolveLocalPackageFiles: no root package.json, or no file:/link: deps, yields nothing", () => {
  assert.deepEqual(resolveLocalPackageFiles(fakeAddon({})), {
    targets: [],
    packageFiles: [],
  });
  assert.deepEqual(
    resolveLocalPackageFiles(
      fakeAddon({
        "package.json": JSON.stringify({ dependencies: { react: "18.0.0" } }),
      })
    ),
    { targets: [], packageFiles: [] }
  );
});

test("resolveLocalPackageFiles: a file: target with its own package.json is in both lists", () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { helper: "file:./helper" },
    }),
    "helper/package.json": JSON.stringify({ dependencies: {} }),
    "helper/index.js": "export {};\n",
  });
  const { targets, packageFiles } = resolveLocalPackageFiles(addon);
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
    packageFiles.map((m) => m.dir),
    ["helper"]
  );
  assert.equal(packageFiles[0].file, "helper/package.json");
});

// link: is resolved identically to file: - both are npm's local-path protocols.
test("resolveLocalPackageFiles: link: resolves the same way file: does", () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { helper: "link:./helper" },
    }),
    "helper/package.json": JSON.stringify({ dependencies: {} }),
  });
  const { targets } = resolveLocalPackageFiles(addon);
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
test("resolveLocalPackageFiles: a file: target with no package.json is a target but not a package file", () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { assets: "file:./assets" },
    }),
    "assets/logo.png": "x",
  });
  const { targets, packageFiles } = resolveLocalPackageFiles(addon);
  assert.deepEqual(targets, [
    {
      declaringFile: "package.json",
      map: "dependencies",
      name: "assets",
      dir: "assets",
    },
  ]);
  assert.deepEqual(packageFiles, []);
});

// npm's own docs say what a local path may name: "a path to a local directory that
// contains a package". Anything else is a source nobody can verify - a tarball is bytes
// this review never unpacks, and a stray file is not a package at all - so neither is a
// target, and the caller goes on to report each as unsupported.
test("resolveLocalPackageFiles: a spec naming a file is not a directory target", () => {
  for (const [spec, key] of [
    ["file:./libs/payload.tgz", "libs/payload.tgz"],
    ["file:./libs/helper.js", "libs/helper.js"],
    ["file:./README.md", "README.md"],
  ]) {
    const addon = fakeAddon({
      "package.json": JSON.stringify({ dependencies: { d: spec } }),
      [key]: "x",
    });
    const { targets, packageFiles } = resolveLocalPackageFiles(addon);
    assert.deepEqual(targets, [], spec);
    assert.deepEqual(packageFiles, [], spec);
  }
});

// An EMPTY directory is still a directory, which is the whole question: npm will fail the
// install for the missing package.json, but that is the developer's problem and not an
// unverifiable source. Only the loader can report this one - a key set names files, so an
// empty directory leaves no trace in it.
test("resolveLocalPackageFiles: an empty directory is a target", () => {
  const addon = fakeAddon(
    { "package.json": JSON.stringify({ dependencies: { d: "file:./empty" } }) },
    ["empty"]
  );
  const { targets, packageFiles } = resolveLocalPackageFiles(addon);
  assert.deepEqual(targets, [
    {
      declaringFile: "package.json",
      map: "dependencies",
      name: "d",
      dir: "empty",
    },
  ]);
  assert.deepEqual(packageFiles, []);
});

// "./x", "x" and "a/../x" all normalize to the same store-relative directory.
test("resolveLocalPackageFiles: '.' and '..' segments normalize", () => {
  for (const spec of ["file:./x", "file:x", "file:a/../x", "file:./a/../x/"]) {
    const addon = fakeAddon({
      "package.json": JSON.stringify({ dependencies: { d: spec } }),
      "x/package.json": JSON.stringify({ dependencies: {} }),
    });
    const { targets } = resolveLocalPackageFiles(addon);
    assert.deepEqual(
      targets.map((t) => t.dir),
      ["x"],
      spec
    );
  }
});

// A leading "/" is rejected outright - a store has no filesystem root of its own to
// collide with, so there is nothing a "/"-rooted spec could legitimately mean here.
test("resolveLocalPackageFiles: an absolute-looking target never resolves", () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { d: "file:/etc/passwd" },
    }),
    "etc/passwd": "x", // even if a same-named relative path exists in the store
  });
  assert.deepEqual(resolveLocalPackageFiles(addon), {
    targets: [],
    packageFiles: [],
  });
});

// A ".." with nothing left to pop escapes the store - left out of both lists entirely, so
// the caller's classifyDeps still rejects it as unsupported (nothing here resolved it).
test("resolveLocalPackageFiles: '..' past the store root does not resolve", () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { d: "file:../outside" },
    }),
  });
  assert.deepEqual(resolveLocalPackageFiles(addon), {
    targets: [],
    packageFiles: [],
  });
});

// workspace: is deliberately not path-based here (see package-file.js LOCAL_SPEC) - a real
// workspace: value is normally a bare range, not a path, and resolving it needs matching
// against the root's own "workspaces" globs, which this does not implement.
test("resolveLocalPackageFiles: workspace: specs are left unresolved", () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { d: "workspace:*" },
    }),
  });
  assert.deepEqual(resolveLocalPackageFiles(addon), {
    targets: [],
    packageFiles: [],
  });
});

// A chain that loops back on an ancestor (including the root) is not re-walked, but the
// declaration that closes the loop is still a satisfied target.
test("resolveLocalPackageFiles: a cycle back to the root terminates without recursing forever", () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { nested: "file:./nested" },
    }),
    "nested/package.json": JSON.stringify({
      dependencies: { back: "file:.." },
    }),
  });
  const { targets, packageFiles } = resolveLocalPackageFiles(addon);
  assert.deepEqual(
    targets.map((t) => `${t.declaringFile}:${t.name}:${t.dir}`),
    ["package.json:nested:nested", "nested/package.json:back:"]
  );
  // Only "nested" has its own package.json recorded - the root is not re-entered as one.
  assert.deepEqual(
    packageFiles.map((m) => m.dir),
    ["nested"]
  );
});

// A self-referencing directory (a package.json linking back to itself) is the same case: one
// satisfied target, no re-walk, no infinite loop.
test("resolveLocalPackageFiles: a directory linking to itself terminates", () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { nested: "file:./nested" },
    }),
    "nested/package.json": JSON.stringify({
      dependencies: { self: "file:../nested" },
    }),
  });
  const { targets, packageFiles } = resolveLocalPackageFiles(addon);
  assert.deepEqual(
    targets.map((t) => `${t.declaringFile}:${t.name}:${t.dir}`),
    ["package.json:nested:nested", "nested/package.json:self:nested"]
  );
  assert.deepEqual(
    packageFiles.map((m) => m.dir),
    ["nested"]
  );
});

// A long CHAIN of distinct directories (not a cycle - each one is new) is bounded by
// LOCAL_PACKAGE_FILE_MAX_DEPTH, a runaway guard rather than a policy: real submissions never
// nest this deep, so the cap only ever stops a pathological one.
test("resolveLocalPackageFiles: a long chain of distinct directories is depth-capped", () => {
  const files = {
    "package.json": JSON.stringify({
      dependencies: { d0: "file:./d0" },
    }),
  };
  const chainLength = LOCAL_PACKAGE_FILE_MAX_DEPTH + 5;
  for (let i = 0; i < chainLength; i++) {
    files[`d${i}/package.json`] = JSON.stringify({
      dependencies: { [`d${i + 1}`]: `file:../d${i + 1}` },
    });
  }
  const addon = fakeAddon(files);
  const { packageFiles } = resolveLocalPackageFiles(addon);
  // The walk stops recursing past the cap - strictly fewer package files than the chain
  // offers, and it terminates at all (no hang/stack overflow) rather than any exact count.
  assert.ok(
    packageFiles.length < chainLength,
    `${packageFiles.length} < ${chainLength}`
  );
  assert.ok(
    packageFiles.length >= LOCAL_PACKAGE_FILE_MAX_DEPTH - 1,
    packageFiles.length
  );
});
