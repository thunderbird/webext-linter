// Modeled on a real submission (markdown_here): the too-new API is feature-detected
// by a guard clause that bails out before reaching it, so the call is a SIBLING of
// the `if` rather than inside it. strict-min-version-api raises the site for a
// reader, who settles it by reading the guard.
async function listTags() {
  if (browser.messages.tags === undefined) {
    return [];
  }
  return await browser.messages.tags.list();
}
