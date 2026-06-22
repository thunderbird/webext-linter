"use strict";

// WebExtension-loading experiment: it loads the registered page into a WebExtension
// <browser> (an extension URL), so files passed to ui.* are WebExtension code and
// stay API-checked.
this.ui = class extends ExtensionAPI {
  getAPI(context) {
    return {
      ui: {
        add(location, page) {
          const browser =
            context.parentWindow.document.createXULElement("browser");
          browser.setAttribute("type", "content");
          browser.src = context.extension.baseURI.resolve(page);
        },
      },
    };
  }
};
