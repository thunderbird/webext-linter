// Unit tests for the unsanitized-HTML scanner.

import { test } from "node:test";
import { VERDICT } from "../../src/lib/enum.js";
import assert from "node:assert/strict";
import { parsed } from "./manifest-ctx.js";

import { scanUnsafeHtml } from "../../src/parse/unsafe-html.js";
import unsafeHtml from "../../src/checks/rules/unsafe-html.js";

const sinks = (code) => scanUnsafeHtml(code).hits.map((h) => h.sink);

// Assignments fed by identifiers, calls, or string concatenation are reported
// for each HTML sink, including the method form insertAdjacentHTML.
test("flags dynamic innerHTML / outerHTML / insertAdjacentHTML", () => {
  assert.deepEqual(sinks(`el.innerHTML = userInput;`), ["innerHTML"]);
  assert.deepEqual(sinks(`el.outerHTML = build();`), ["outerHTML"]);
  assert.deepEqual(sinks(`el.innerHTML = "<a>" + name + "</a>";`), [
    "innerHTML",
  ]);
  assert.deepEqual(sinks(`n.insertAdjacentHTML("beforeend", "<i>" + x);`), [
    "insertAdjacentHTML",
  ]);
});

// Static content is now flagged too - the only sanctioned insertion method is
// Element.setHTML(), so a non-empty static string, a static concatenation, and a
// fully-static ternary all produce a hit, just like dynamic content.
test("flags static (non-empty) HTML content too", () => {
  assert.deepEqual(sinks(`el.innerHTML = "<b>ok</b>";`), ["innerHTML"]);
  assert.deepEqual(sinks(`el.innerHTML = "<a>" + "<b>";`), ["innerHTML"]);
  assert.deepEqual(sinks(`el.innerHTML = cond ? "<b>A</b>" : "<i>B</i>";`), [
    "innerHTML",
  ]);
});

// The ONLY exempt writes are an empty-string / null clear (no content) and
// insertAdjacentHTML with an empty argument; textContent is never a sink.
test("exempts only an empty/null clear and textContent", () => {
  assert.equal(scanUnsafeHtml(`el.innerHTML = "";`).hits.length, 0);
  assert.equal(scanUnsafeHtml("el.innerHTML = ``;").hits.length, 0);
  assert.equal(scanUnsafeHtml(`el.innerHTML = null;`).hits.length, 0);
  assert.equal(
    scanUnsafeHtml(`n.insertAdjacentHTML("beforeend", "");`).hits.length,
    0 // empty insert - nothing written
  );
  assert.equal(
    scanUnsafeHtml(`el.textContent = userInput;`).hits.length,
    0 // textContent is safe, not an HTML sink
  );
});

// Bracket-style property writes, the srcdoc sink, and ternaries with even one
// dynamic arm are all detected, so static-only detection cannot be bypassed.
test("flags computed access, srcdoc, and dynamic ternary arms", () => {
  assert.deepEqual(sinks(`el["innerHTML"] = userInput;`), ["innerHTML"]);
  assert.deepEqual(sinks(`frame.srcdoc = build();`), ["srcdoc"]);
  assert.deepEqual(sinks(`el.innerHTML = cond ? "<b>ok</b>" : userInput;`), [
    "innerHTML",
  ]);
});

// The check narrates each sink it flags to the feed via ctx.note (verdict fail),
// so the reviewer gets the HTML-sink trail alongside the findings.
test("unsafe-html notes each sink site (verdict fail)", () => {
  const code = "el.innerHTML = userInput;";
  const ctx = {
    addon: { files: new Map([["render.js", Buffer.from(code)]]), manifest: {} },
    jsSources: parsed([
      { file: "render.js", code, lineOffset: 0, inline: false },
    ]),
  };
  const notes = [];
  ctx.note = (file, loc, item, verdict) => notes.push({ file, item, verdict });
  const out = unsafeHtml.run(ctx);
  assert.equal(out.length, 1); // still one finding
  assert.deepEqual(notes, [
    { file: "render.js", item: ".innerHTML", verdict: VERDICT.FAIL },
  ]);
});
