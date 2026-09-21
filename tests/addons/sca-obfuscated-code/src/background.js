// The archive carries an obfuscated file of its own. Obfuscation is banned outright,
// so the diagnosis matches the XPI's - but the XPI response ends by asking for a
// source code submission, which this developer has already made.
async function run(folder) {
  const result = await browser.messages.list(folder);
  return result.messages;
}
