#!/usr/bin/env node
// Belongs here: the thin process entry point - call cli.main(argv), then exit
// with its code, or with 2 on a failure, whether main threw it or something outside
// main did. Every one goes through exitWith, the one place the process ends, so
// whatever stderr messages a run held back are written first however it ended.
//
// Does NOT belong here: argv parsing, validation, and report routing (those
// live in cli.js main). The schema review itself lives in pipeline.js
// runPipeline.
import { main } from "./src/cli.js";
import { exitWith, writeToStderr } from "./src/util/log.js";

/** A failure nothing caught: its trace goes the way of every other tool message, and the
 *  run ends like any failed one. */
function crash(err) {
  writeToStderr(`${err?.stack || String(err)}\n`);
  exitWith(2);
}

// Also for a failure OUTSIDE main's promise - a throw in a timer, a rejection nobody
// awaits. Node's own handler would end the process past exitWith and lose whatever
// messages the run was holding back.
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

main(process.argv.slice(2)).then((code) => exitWith(code), crash);
