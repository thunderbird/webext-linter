async function run(folder) {
  const result = await browser.messages.list(folder);
  return result.messages;
}
