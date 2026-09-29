// The COMPILED output of src/background.ts. Readable, but not byte-identical to any
// file in the archive - a build ran - so sca-xpi-fully-included-in-archive stays silent.
async function run(folder) {
  const result = await browser.messages.list(folder);
  await messenger.messages.move([result.messages[0].id], folder);
  browser.messages.onNewMailReceived.addListener(() => {});
}
