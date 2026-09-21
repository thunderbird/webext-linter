// Two identified-but-undeclared libraries, committed to the ARCHIVE: one the
// Mozilla hash DB knows (missing-library), one only jsDelivr does
// (find-lib-on-cdn). Both checks word their response per review mode, and a
// source code submission is told something an XPI submission cannot be.
import "./lib/undeclared.min.js";
