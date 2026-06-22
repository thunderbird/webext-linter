"use strict";

this.demo = class extends ExtensionAPI {
  getAPI(context) {
    return {
      demo: {
        async doThing() {
          return "done";
        },
      },
    };
  }
};
