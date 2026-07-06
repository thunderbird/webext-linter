// parseJs picks Babel plugins from a filename/extension hint so authored
// TypeScript and JSX source parses instead of degrading. .ts and .tsx differ
// deliberately (TSX mode disables `<T>` type assertions), and a missing hint
// keeps the plain-JS base set so non-authored callers are unaffected.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseJs } from "../../src/parse/ast.js";

const clean = (code, hint) => {
  const { ast, parseError } = parseJs(code, hint);
  assert.equal(parseError, null, `unexpected parse error: ${parseError}`);
  assert.ok(ast, "an AST is produced");
};

test(".ts parses type syntax and angle-bracket assertions", () => {
  clean(
    "const x: number = 1;\nfunction id<T>(a: T): T { return <T>a; }",
    "m.ts"
  );
});

test(".tsx parses JSX plus `as` assertions", () => {
  clean(
    "const n = value as string;\nconst el = <div className={n}>{n}</div>;",
    "c.tsx"
  );
});

test(".jsx parses JSX", () => {
  clean("const el = <App onClick={() => fetch(u)} />;", "c.jsx");
});

test(".mjs and .js enable JSX (React authored in .js)", () => {
  clean("export const el = <div/>;", "a.mjs");
  clean("const el = <span/>; export default el;", "a.js");
});

test("no hint keeps the plain-JS base set (plain JS still parses)", () => {
  clean("const a = 1 < 2 > 0;\nexport default a;");
});
