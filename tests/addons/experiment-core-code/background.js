// Calls the bundled experiment's own API. "demo" is registered (experiment_apis),
// so this is not flagged unknown-api.
browser.demo.doThing().then((r) => console.log(r));
