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

globalThis.__tampered = true;
eval(globalThis.__tampered);
setTimeout("doThing()", 10);
