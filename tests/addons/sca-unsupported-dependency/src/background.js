// The archive the reviewer builds from declares a dependency by a file: path. Neither
// the npm registry nor GitHub can be asked about it, so nothing identifies what the
// build would pull in and unsupported-dependency rejects the declaration.
async function run(folder) {
  const result = await browser.messages.list(folder);
  return result.messages;
}
