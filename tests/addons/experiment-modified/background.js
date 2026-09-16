// Calls the bundled experiment's own API. The experiment is a recognised published
// draft, so "demo" is registered as known and this is not flagged unknown-api.
browser.demo.doThing().then((r) => console.log(r));
