// Every file reference goes through the common Thunderbird feature-detection
// alias or a captured namespace - never a literal browser/messenger root. The
// loader scanner must resolve these for help/ to count as used.
const api = typeof messenger !== "undefined" ? messenger : browser;

// The getURL call sits inline in the url slot: a resolved-URL value keeps the
// scan free of dynamic loaders, so the golden genuinely asserts that help/ is
// REACHABLE through the alias - an unresolved alias would orphan it, not be
// masked by the dynamic-loader suppression in unused-files.
async function openHelp() {
  await api.tabs.create({ url: api.runtime.getURL("help/help.html") });
}

const rt = api.runtime;

function helpUrl() {
  return rt.getURL("help/help.js");
}

api.runtime.onMessage.addListener((request) => {
  if (request.type === "help.open") {
    return openHelp();
  }
  return false;
});

void helpUrl;
