// A second, authored background script (the minified background.js keeps the XPI
// non-directly-reviewable, so the review stays in SCA mode). It loads a feature module
// whose path is built at runtime, so the linter cannot statically prove which shipped
// files are dead - orphan.js escalates to a person rather than becoming a deterministic
// unused-files finding.
const feature = globalThis.FEATURE || "main";
import(browser.runtime.getURL(feature + ".js"));
