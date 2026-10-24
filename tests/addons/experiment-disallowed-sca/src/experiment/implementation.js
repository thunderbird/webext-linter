// The Experiment's implementation, named by --sca-experiments. The review stops at
// experiment-not-allowed before anything reads it.
this.myapi = class extends ExtensionCommon.ExtensionAPI {
  getAPI() {
    return { myapi: {} };
  }
};
