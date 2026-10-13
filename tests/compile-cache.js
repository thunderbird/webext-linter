// Keeps the compiled code of every module between test processes: loaded first (`node
// --import`, see package.json), and inherited through NODE_COMPILE_CACHE by every verify.js a
// test spawns. Each start of the linter compiles every module it loads, and the tests start
// it hundreds of times. Node checks each cached entry against its source, so an edited module
// is compiled again. A real run writes no cache: verify.js and src/ never ask for one.

import module from "node:module";
import os from "node:os";
import path from "node:path";

process.env.NODE_COMPILE_CACHE ??= path.join(
  os.tmpdir(),
  "webext-linter-test-compile-cache"
);
module.enableCompileCache(process.env.NODE_COMPILE_CACHE);
