// Shipped in the XPI but referenced by nothing in the manifest, so the input:xpi
// unused-files check flags it - an XPI-anchored recheck that drives the SCA packaging pass.
console.log("orphan - not reachable from the manifest");
