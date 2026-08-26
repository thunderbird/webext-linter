// Modeled on a real submission (markdown_here): the too-new API is feature-detected
// by a guard clause that bails out before reaching it, so the call is a SIBLING of
// the `if` rather than inside it. strict-min-version-api sees the guard signal and
// hands the site to judgement instead of rejecting it outright.
async function listTags() {
  if (browser.messages.tags === undefined) {
    return [];
  }
  return await browser.messages.tags.list();
}
