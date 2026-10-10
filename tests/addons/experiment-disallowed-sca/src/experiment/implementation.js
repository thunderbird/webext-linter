// The Experiment's implementation, named by --sca-exp-source. The review stops at
// experiment-not-allowed before anything reads it.
this.myapi = class extends ExtensionCommon.ExtensionAPI {
  getAPI() {
    return { myapi: {} };
  }
};
