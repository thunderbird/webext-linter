// Readable, non-minified authored code: hasUnreviewableCode is false, so the
// pipeline downgrades the SCA submission to a plain XPI review and sets
// scaNotRequired (see resolveReviewMode in src/pipeline.js).
async function run(folder) {
  const result = await browser.messages.list(folder);
  await messenger.messages.move([result.messages[0].id], folder);
  browser.messages.onNewMailReceived.addListener(() => {});
}
