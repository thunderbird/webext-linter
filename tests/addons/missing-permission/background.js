async function run(folder) {
  // move() requires accountsRead + messagesMove, neither of which is declared.
  await browser.messages.move([1], folder);
}
