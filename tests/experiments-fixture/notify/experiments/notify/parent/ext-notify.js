"use strict";

this.notify = class extends ExtensionAPI {
  getAPI(context) {
    return {
      notify: {
        async show() {
          return "shown";
        },
      },
    };
  }
};
