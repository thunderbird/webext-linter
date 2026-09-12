// Two static-analysis coverage gaps of the two kinds api-usage.js records, so
// api-coverage reports one finding each: a computed member the resolver cannot
// follow, and an API object destructured into a binding it cannot track. Both
// use permission-free namespaces, so nothing else fires on them.

const which = Math.random() > 0.5 ? "getManifest" : "getURL";
browser.runtime[which]("page.html");

const { tabs } = browser;
tabs.create({ url: "page.html" });
