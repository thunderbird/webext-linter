"use strict";

// CORE-loading experiment (subscript-loads its registered script). Privileged code,
// so its own Services / ExtensionAPI usage is exempt from the core-symbol check.
this.wl = class extends ExtensionAPI {
  getAPI(context) {
    return {
      wl: {
        registerWindow(windowUrl, script) {
          Services.scriptloader.loadSubScript(script, {}, "UTF-8");
        },
      },
    };
  }
};
