"use strict";

// Privileged Experiment (core) code. It uses Thunderbird internals and core
// loaders, NOT the WebExtension schema - so the API/permission checks must skip
// it, and the files it pulls in must not be flagged unused.
this.demo = class extends ExtensionAPI {
  getAPI(context) {
    // A core API absent from the WebExtension schema: must NOT be flagged
    // unknown-api (this file is exempt), and must not count toward permissions.
    messenger.reloadMessage();

    // An add-on file referenced via the privileged resolver (root-relative path):
    // content/helper.js is reachable, not unused.
    Services.scriptloader.loadSubScript(
      context.extension.rootURI.resolve("content/helper.js"),
      {}
    );

    // A chrome://resource:// URL the add-on registered for a bundled module:
    // matched by file name -> modules/MyMod.sys.mjs is reachable, not unused.
    ChromeUtils.importESModule("resource:///modules/MyMod.sys.mjs");

    // A real core module with no bundled counterpart: ignored, never flagged.
    ChromeUtils.importESModule("resource:///modules/MailUtils.sys.mjs");

    return {
      demo: {
        async doThing() {
          return "done";
        },
      },
    };
  }
};
