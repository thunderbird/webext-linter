// Calls the bundled experiment's own API. Because the experiment is a pristine
// upstream copy, "demo" is registered as known, so this is not flagged unknown-api.
browser.demo.doThing().then((r) => console.log(r));
