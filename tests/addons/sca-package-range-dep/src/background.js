// The archive the reviewer installs from: its package.json names a range and ships
// no lock, so `npm ci` cannot reproduce the tree the developer built against. Only a
// source code submission is offered the lock-file route - a lock is a build artifact
// and has no place inside a shipped XPI.
async function run(folder) {
  const result = await browser.messages.list(folder);
  return result.messages;
}
