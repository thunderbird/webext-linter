// The declared dependency is shipped, so the lock's pin names a release the packaged
// bytes can be matched against.
async function run(folder) {
  const result = await browser.messages.list(folder);
  return globalThis._.identity(result.messages);
}
