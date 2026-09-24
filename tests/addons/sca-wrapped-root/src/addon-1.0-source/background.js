// The readable source. It sits one level below --sca-root, because the archive packs
// everything under a directory of its own - the shape a repository download produces.
// The review finds the root by its package.json rather than reading the folder it was
// handed, so the build files below are the ones it audits.
async function run(folder) {
  const result = await browser.messages.list(folder);
  return result.messages;
}
