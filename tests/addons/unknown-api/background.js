async function run() {
  // Firefox-only namespace, not part of the Thunderbird API.
  await browser.contextMenus.create({});
  // Existing namespace, non-existent member.
  await browser.messages.frobnicate();
}
