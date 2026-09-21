// The same unfetchable VENDOR declaration as its XPI twin, in a source code
// submission: the archive itself carries the minified library, so the remedy is
// to include the readable build here rather than to vendor one into a package.
import "./lib/widget.min.js";

console.log("vendored library demo ready");
