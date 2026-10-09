// Switches the network off for every test process: loaded first (`node --import`, see
// package.json), before any module reads the switch, and inherited by every verify.js a test
// spawns. src/util/net.js then refuses any request that would reach a real host, so a test
// is answered by a seeded cache or by an answer it supplies, or fails naming the request.
process.env.WEBEXT_LINTER_NO_NETWORK = "1";
