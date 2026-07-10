// A commented-out injection must not ground "compose": the token scan reads the
// LIVE code only, so this executeScript / insertCSS mention stays invisible:
// browser.tabs.executeScript(tabId, { file: "style.js" }); insertCSS too.
async function run(folder) {
  await browser.messages.list(folder);
}
run();
