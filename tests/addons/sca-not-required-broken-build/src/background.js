// Readable, non-minified authored code that is ALSO byte-identical to src/background.js,
// so all three XPI-only-advice questions pass and sca-not-required fires (see
// resolveXpiOnlyAdvice in src/pipeline.js). The review itself stays SCA either way.
async function run(folder) {
  const result = await browser.messages.list(folder);
  await messenger.messages.move([result.messages[0].id], folder);
  browser.messages.onNewMailReceived.addListener(() => {});
}
