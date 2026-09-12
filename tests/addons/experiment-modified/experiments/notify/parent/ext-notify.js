"use strict";

this.notify = class extends ExtensionAPI {
  getAPI(context) {
    return {
      notify: {
        async show() {
          // Locally modified: the published draft returns "shown".
          return "shown, with a local change";
        },
      },
    };
  }
};
