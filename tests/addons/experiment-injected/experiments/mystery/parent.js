"use strict";

// UNSURE experiment: it loads the registered file by some mechanism we do not
// recognize (neither loadSubScript nor a WebExtension <browser>), so files passed
// to mystery.* are deferred - exempt for now, with an `unsure` note a later
// summary-prompt can resolve.
this.mystery = class extends ExtensionAPI {
  getAPI(context) {
    return {
      mystery: {
        run(path) {
          context.magicLoad(path);
        },
      },
    };
  }
};
