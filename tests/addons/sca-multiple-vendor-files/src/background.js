// Two VENDOR manifests in one archive, each naming the same file with a different
// source, so which one the review reads is decided by archive order.
async function run(folder) {
  const result = await browser.messages.list(folder);
  return result.messages;
}
