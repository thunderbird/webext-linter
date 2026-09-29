// Readable authored code, byte-identical to its copy in the other tree - which is what
// sca-xpi-fully-included-in-archive compares (every file the XPI ships against every file
// the archive holds, by content). This comment is part of those bytes, so the two copies
// must stay identical.
// The review itself stays SCA either way.
async function run(folder) {
  const result = await browser.messages.list(folder);
  await messenger.messages.move([result.messages[0].id], folder);
  browser.messages.onNewMailReceived.addListener(() => {});
}
