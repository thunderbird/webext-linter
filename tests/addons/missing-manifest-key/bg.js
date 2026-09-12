// Two namespaces whose APIs each require a manifest key this add-on never declares.
// The findings interpolate the required key alongside the API, so they never share a
// message and stay separate entries.
browser.action.onClicked.addListener(() => {});

browser.messageDisplayScripts.register({ js: [{ file: "display.js" }] });
