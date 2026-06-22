// Subscript-loaded into a chrome window by the wl experiment (core context). It
// loads the legacy overlay via a literal chrome:// URL, which the core-loader
// closure follows by file name to content/legacy-core.js.
Services.scriptloader.loadSubScript(
  "chrome://x/content/legacy-core.js",
  window,
  "UTF-8"
);
