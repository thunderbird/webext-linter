// Calls the bundled experiment's own API. "coreexp" is registered
// (experiment_apis), so this is not flagged unknown-api.
browser.coreexp.doThing().then((r) => console.log(r));
