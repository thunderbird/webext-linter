// Declared by the experiment's own schema, each through a different member block:
// a function, an event, and a property.
browser.widgetTools.build().then((r) => console.log(r));
browser.widgetTools.onBuilt.addListener(() => {});
console.log(browser.widgetTools.MAX_WIDGETS);

// A sub-namespace declares its own members, so the longest registered prefix decides.
browser.widgetTools.panels.open();

// Not declared anywhere in the schema: at run time this is undefined.
browser.widgetTools.teardown();
