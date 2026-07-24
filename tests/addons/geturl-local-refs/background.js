// Every resource here is loaded through runtime.getURL with a RELATIVE path, which
// resolves against the extension's own moz-extension:// base - a local resource.
// The remote-code and outbound-sink classifiers must resolve the getURL argument
// and treat each as LOCAL - no remote-resources, data-exfiltration or disguised-*
// findings. Relative literal paths keep the assertion on the getURL recognition.

// Dynamic import() of a packaged module.
async function loadPopup() {
  const mod = await import(browser.runtime.getURL("popup.js"));
  return mod;
}

// fetch() of a packaged data file - a local read, not an outbound transmission.
async function loadData() {
  const res = await fetch(browser.runtime.getURL("data.json"));
  return res.json();
}

// A script element pointed at a packaged script - a local load, not remote code.
function injectScript() {
  const s = document.createElement("script");
  s.src = browser.runtime.getURL("inject.js");
  document.head.append(s);
}

browser.runtime.onMessage.addListener((request) => {
  switch (request.type) {
    case "popup":
      return loadPopup();
    case "data":
      return loadData();
    case "inject":
      injectScript();
      return false;
    default:
      return false;
  }
});
