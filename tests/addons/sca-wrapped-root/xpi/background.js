// The shipped script, built from the source in the archive's own directory.
async function run(folder) {
  const result = await browser.messages.list(folder);
  return result.messages;
}
