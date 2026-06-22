"use strict";

// CORE-loading experiment: it subscript-loads the registered script into a chrome
// window, so files passed to wl.* run as privileged core code (exempt).
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
