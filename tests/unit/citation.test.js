// The cited-evidence verifier (src/lib/citation.js): a post-summary pass must point
// at a real, locatable usage. Covers the structural checks (file in corpus, line in
// range), the token checks (accepted vocabulary, present in real code, at the cited
// line), the comment-exclusion, the manifest's token-presence-only path, and the
// no-vocabulary structural-only path.

import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyCitation } from "../../src/lib/citation.js";
import { canonicalJson } from "../../src/util/json.js";
import { parsed } from "./manifest-ctx.js";

// A ctx exposing exactly what verifyCitation reads: addon.files (Buffers), the parsed
// jsSources (for comment-free codeTextOf), and the manifest. Every .js file becomes a
// parsed source so codeText is available; the manifest is rendered as the model saw it.
function makeCtx(files, manifest) {
  const fileMap = new Map(
    Object.entries(files).map(([f, c]) => [f, Buffer.from(c, "utf8")])
  );
  const jsSources = parsed(
    Object.entries(files)
      .filter(([f]) => f.endsWith(".js"))
      .map(([f, c]) => ({ file: f, code: c, lineOffset: 0, inline: false }))
  );
  return {
    addon: { files: fileMap },
    jsSources,
    manifest: manifest ?? null,
    manifestText: files["manifest.json"] ?? "",
  };
}

const VOCAB = ["executeScript", "insertCSS"];

test("verifyCitation accepts a token present in real code at the cited line", () => {
  const ctx = makeCtx({
    "bg.js": "const a = 1;\ntabs.executeScript(tabId);\nconst b = 2;\n",
  });
  const cited = verifyCitation(
    [{ file: "bg.js", lines: "2", token: "executeScript" }],
    VOCAB,
    ctx
  );
  assert.ok(cited);
  assert.equal(cited.token, "executeScript");
  assert.equal(cited.lines, "2");
});

test("verifyCitation accepts a line RANGE that contains the token", () => {
  const ctx = makeCtx({
    "bg.js": "line1\nline2\ntabs.executeScript(x);\nline4\n",
  });
  assert.ok(
    verifyCitation(
      [{ file: "bg.js", lines: "2-4", token: "executeScript" }],
      VOCAB,
      ctx
    )
  );
});

test("verifyCitation rejects when there are no usages", () => {
  const ctx = makeCtx({ "bg.js": "tabs.executeScript(x);\n" });
  assert.equal(verifyCitation([], VOCAB, ctx), null);
  assert.equal(verifyCitation(undefined, VOCAB, ctx), null);
});

test("verifyCitation rejects a token outside the accepted vocabulary", () => {
  const ctx = makeCtx({ "bg.js": "tabs.query(x);\n" });
  assert.equal(
    verifyCitation([{ file: "bg.js", lines: "1", token: "query" }], VOCAB, ctx),
    null
  );
});

test("verifyCitation rejects a token absent from the cited file", () => {
  const ctx = makeCtx({ "bg.js": "const a = 1;\n" });
  assert.equal(
    verifyCitation(
      [{ file: "bg.js", lines: "1", token: "executeScript" }],
      VOCAB,
      ctx
    ),
    null
  );
});

test("verifyCitation rejects a token that appears only in a comment", () => {
  const ctx = makeCtx({
    "bg.js": "const a = 1;\n// call tabs.executeScript later\nconst b = 2;\n",
  });
  assert.equal(
    verifyCitation(
      [{ file: "bg.js", lines: "2", token: "executeScript" }],
      VOCAB,
      ctx
    ),
    null
  );
});

test("verifyCitation rejects a token present but at the wrong line", () => {
  const ctx = makeCtx({
    "bg.js": "tabs.executeScript(x);\nconst b = 2;\n",
  });
  assert.equal(
    verifyCitation(
      [{ file: "bg.js", lines: "2", token: "executeScript" }],
      VOCAB,
      ctx
    ),
    null
  );
});

test("verifyCitation rejects an out-of-range line", () => {
  const ctx = makeCtx({ "bg.js": "tabs.executeScript(x);\n" });
  assert.equal(
    verifyCitation(
      [{ file: "bg.js", lines: "99", token: "executeScript" }],
      VOCAB,
      ctx
    ),
    null
  );
});

test("verifyCitation rejects a nonexistent file", () => {
  const ctx = makeCtx({ "bg.js": "tabs.executeScript(x);\n" });
  assert.equal(
    verifyCitation(
      [{ file: "gone.js", lines: "1", token: "executeScript" }],
      VOCAB,
      ctx
    ),
    null
  );
});

test("verifyCitation rejects a malformed lines string", () => {
  const ctx = makeCtx({ "bg.js": "tabs.executeScript(x);\n" });
  for (const lines of ["", "abc", "5-2", "0"]) {
    assert.equal(
      verifyCitation(
        [{ file: "bg.js", lines, token: "executeScript" }],
        VOCAB,
        ctx
      ),
      null,
      `lines=${JSON.stringify(lines)} must not verify`
    );
  }
});

test("verifyCitation with no vocabulary verifies structurally only", () => {
  const ctx = makeCtx({ "notes.js": "line1\nline2\nline3\n" });
  // Empty accepted set: the cited file + an in-range line suffice; no token needed.
  assert.ok(verifyCitation([{ file: "notes.js", lines: "2" }], [], ctx));
  assert.ok(verifyCitation([{ file: "notes.js", lines: "2" }], null, ctx));
  // ...but the structural checks still bite.
  assert.equal(
    verifyCitation([{ file: "notes.js", lines: "9" }], [], ctx),
    null
  );
  assert.equal(
    verifyCitation([{ file: "gone.js", lines: "1" }], [], ctx),
    null
  );
});

test("verifyCitation verifies a manifest-key token by presence (no line)", () => {
  const manifest = {
    permissions: ["compose"],
    compose_scripts: [{ js: ["cs.js"] }],
  };
  const ctx = makeCtx({ "manifest.json": canonicalJson(manifest) }, manifest);
  // The manifest is one block, so any line is accepted; the token must be present.
  assert.ok(
    verifyCitation(
      [{ file: "manifest.json", lines: "1", token: "compose_scripts" }],
      ["compose_scripts"],
      ctx
    )
  );
  // A manifest-key token that is NOT in the manifest fails.
  assert.equal(
    verifyCitation(
      [{ file: "manifest.json", lines: "1", token: "message_display_scripts" }],
      ["message_display_scripts"],
      ctx
    ),
    null
  );
});

test("verifyCitation rejects a token grounded only in a non-JS file", () => {
  // A generic token word in prose/markup/CSS must NOT ground a permission: only real
  // code (a parsed JS source) or the manifest counts, matching presentTokens. Otherwise
  // an author could bait a false pass with `url` in a stylesheet or `title` in a readme.
  const ctx = makeCtx({
    "styles.css": ".x { background: url(a.png); }\n",
    "readme.md": "The title of the page.\n",
  });
  assert.equal(
    verifyCitation(
      [{ file: "styles.css", lines: "1", token: "url" }],
      ["url"],
      ctx
    ),
    null
  );
  assert.equal(
    verifyCitation(
      [{ file: "readme.md", lines: "1", token: "title" }],
      ["title"],
      ctx
    ),
    null
  );
  // ...but a structural-only (no-vocabulary) citation into the same file still verifies.
  assert.ok(verifyCitation([{ file: "styles.css", lines: "1" }], [], ctx));
});

test("verifyCitation returns the first usage that verifies", () => {
  const ctx = makeCtx({
    "a.js": "nothing here\n",
    "b.js": "tabs.insertCSS(x);\n",
  });
  const cited = verifyCitation(
    [
      { file: "a.js", lines: "1", token: "executeScript" }, // fails
      { file: "b.js", lines: "1", token: "insertCSS" }, // verifies
    ],
    VOCAB,
    ctx
  );
  assert.equal(cited?.file, "b.js");
});
