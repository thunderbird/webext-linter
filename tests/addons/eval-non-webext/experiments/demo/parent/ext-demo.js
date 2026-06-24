"use strict";

// Privileged Experiment (core) code - OUTSIDE the pure WebExtension tree, so it
// runs with chrome privileges and has no CSP gate. Dynamic code execution here
// CAN run, so eval-call / function-constructor / string-timer must flag it.
this.demo = class extends ExtensionAPI {
  getAPI() {
    eval("doSomething()");
    const fn = new Function("return 1");
    setTimeout("doSomething()", 0);
    return {
      demo: {
        async doThing() {
          return fn();
        },
      },
    };
  }
};
