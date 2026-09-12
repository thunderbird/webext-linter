// Modeled on a real submission (mboxsleuth): strict_min_version 115.0 but the
// messages.tags.* API was only added in Thunderbird 121, so installs on 115-120
// break. strict-min-version-api lists every call site.
async function listAndTag() {
  const tags = await browser.messages.tags.list();
  await browser.messages.tags.create("$label6", "Reviewed", "blue");
  return tags;
}

// A second use of the SAME too-new API, in another function. It is listed on its own
// line: whatever protects the call above need not reach here, so a reader has to see it.
async function refresh() {
  return browser.messages.tags.list();
}
