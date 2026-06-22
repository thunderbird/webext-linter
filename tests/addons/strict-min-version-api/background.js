// Modeled on a real submission (mboxsleuth): strict_min_version 115.0 but the
// messages.tags.* API was only added in Thunderbird 121, so installs on 115-120
// break. strict-min-version-api flags both calls.
async function listAndTag() {
  const tags = await browser.messages.tags.list();
  await browser.messages.tags.create("$label6", "Reviewed", "blue");
  return tags;
}
