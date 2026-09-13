// untwinnedShippedJs: which shipped scripts have no byte-identical same-named file in the
// source archive. Pure, so the paths the end-to-end harness cannot reach - many candidates
// sharing a basename, case-folding, the exempt set - are pinned here.

import test from "node:test";
import assert from "node:assert/strict";

import { untwinnedShippedJs } from "../../src/lib/source-twins.js";

/** @param {Record<string,string>} spec */
const files = (spec) =>
  new Map(Object.entries(spec).map(([f, t]) => [f, Buffer.from(t, "utf8")]));

test("a shipped script byte-identical in the archive is twinned", () => {
  assert.deepEqual(
    untwinnedShippedJs(
      files({ "background.js": "a\n" }),
      files({ "background.js": "a\n" })
    ),
    []
  );
});

test("absent and differs are told apart", () => {
  assert.deepEqual(
    untwinnedShippedJs(
      files({ "gone.js": "a\n", "changed.js": "a\n" }),
      files({ "changed.js": "b\n" })
    ),
    [
      { file: "gone.js", reason: "absent" },
      { file: "changed.js", reason: "differs" },
    ]
  );
});

test("the twin may sit at any path - the name only selects candidates", () => {
  // A build that RELOCATES a file it copied verbatim, and a wrapper directory (GitHub's
  // "Download ZIP"), both change the path and neither changes the bytes.
  assert.deepEqual(
    untwinnedShippedJs(
      files({ "extlib/widget.js": "w\n" }),
      files({ "submodules/widget-lib/widget.js": "w\n" })
    ),
    []
  );
});

test("several candidates share a basename; any one match is enough", () => {
  assert.deepEqual(
    untwinnedShippedJs(
      files({ "background.js": "real\n" }),
      files({
        "a/background.js": "decoy\n",
        "b/background.js": "real\n",
        "c/background.js": "another\n",
      })
    ),
    []
  );
  // ...and when none of them match, it is `differs`, not `absent`.
  assert.deepEqual(
    untwinnedShippedJs(
      files({ "background.js": "real\n" }),
      files({ "a/background.js": "decoy\n", "b/background.js": "other\n" })
    ),
    [{ file: "background.js", reason: "differs" }]
  );
});

test("basenames are matched case-insensitively", () => {
  // A source checked out on a case-insensitive filesystem can present Background.js for a
  // stored background.js. Widening candidates cannot create a false match on its own -
  // the bytes still decide.
  assert.deepEqual(
    untwinnedShippedJs(
      files({ "background.js": "a\n" }),
      files({ "Background.JS": "a\n" })
    ),
    []
  );
});

test("bytes are compared raw - a line-ending difference is NOT a twin", () => {
  // Normalizing would produce MORE matches, and a false match claims the shipped code is
  // the source when it is not. A false mismatch only withholds advice.
  assert.deepEqual(
    untwinnedShippedJs(
      files({ "background.js": "a\r\nb\r\n" }),
      files({ "background.js": "a\nb\n" })
    ),
    [{ file: "background.js", reason: "differs" }]
  );
});

test("only JS is compared, and every JS extension is", () => {
  // Non-JS never needs a twin...
  assert.deepEqual(
    untwinnedShippedJs(
      files({ "icon.png": "x", "popup.html": "y", "style.css": "z" }),
      files({})
    ),
    []
  );
  // ...but .cjs/.mjs/.jsm/.es6 do: Gecko loads background.scripts by path, so an add-on
  // whose code is all .cjs must not pass for free.
  assert.deepEqual(
    untwinnedShippedJs(
      files({ "a.cjs": "1", "b.mjs": "2", "c.jsm": "3", "d.es6": "4" }),
      files({})
    ).map((u) => u.file),
    ["a.cjs", "b.mjs", "c.jsm", "d.es6"]
  );
});

test("exempt files need no twin", () => {
  assert.deepEqual(
    untwinnedShippedJs(files({ "lib/jquery.js": "q\n" }), files({}), {
      exempt: new Set(["lib/jquery.js"]),
    }),
    []
  );
  // exempt is keyed by the SHIPPED path, not the basename.
  assert.deepEqual(
    untwinnedShippedJs(files({ "lib/jquery.js": "q\n" }), files({}), {
      exempt: new Set(["jquery.js"]),
    }),
    [{ file: "lib/jquery.js", reason: "absent" }]
  );
});

test("an empty or missing archive leaves every shipped script untwinned", () => {
  assert.deepEqual(untwinnedShippedJs(files({ "a.js": "x" }), files({})), [
    { file: "a.js", reason: "absent" },
  ]);
  assert.deepEqual(untwinnedShippedJs(files({ "a.js": "x" }), undefined), [
    { file: "a.js", reason: "absent" },
  ]);
  assert.deepEqual(untwinnedShippedJs(undefined, undefined), []);
});
