// The archive's VENDOR file is prose and a bare repository link, so no block pairs a
// library file with a source URL and nothing parses out of it.
async function run(folder) {
  const result = await browser.messages.list(folder);
  return result.messages;
}
