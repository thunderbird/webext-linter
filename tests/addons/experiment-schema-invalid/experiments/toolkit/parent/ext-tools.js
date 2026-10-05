// The privileged half. Outside the pure WebExtension tree, so it is not validated -
// the fixture is about what the SCHEMA declares, not about this file.
var widgetTools = class extends ExtensionCommon.ExtensionAPI {
  getAPI() {
    return { widgetTools: { build: async () => 1 } };
  }
};
