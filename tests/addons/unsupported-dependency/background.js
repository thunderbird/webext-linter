// The shipped package.json names a dependency by a file: path. Neither the npm
// registry nor GitHub can be asked about it, so nothing identifies or verifies what
// was bundled and unsupported-dependency rejects the declaration.
async function run(folder) {
  const result = await browser.messages.list(folder);
  return result.messages;
}
