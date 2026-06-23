"use strict";

// UNSURE experiment (neither a subscript-loader nor a WebExtension <browser>), so
// files it is handed are deferred/exempt - and its own ExtensionAPI usage is exempt.
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
