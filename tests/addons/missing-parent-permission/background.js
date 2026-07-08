async function run() {
  // messages.tags.list is gated by the parent messages namespace's messagesRead
  // (which exposes browser.messages) on top of its own messagesTagsList; only
  // messagesTagsList is declared, so messagesRead is the missing permission.
  await browser.messages.tags.list();
}
