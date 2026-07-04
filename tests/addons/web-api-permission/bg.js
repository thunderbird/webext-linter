// clipboardRead, clipboardWrite and geolocation are gated by Web/DOM APIs
// (navigator.*) the browser.* schema cannot express. Each is grounded from the
// `web_api` schema annotation (merged in at setup) when a matching navigator.*
// call is reachable, so none is reported as declared-but-unused. "notifications"
// is declared but never used, so only it is flagged.
async function run(text) {
  const pasted = await navigator.clipboard.readText();
  await navigator.clipboard.writeText(text || pasted);
  navigator.geolocation.getCurrentPosition((pos) => pos);
}
