// Minimal background script. This fixture exists to exercise the banned-library
// check: the add-on ships two library versions Mozilla add-on policy disallows, and
// declares each in package.json at the version it ships.
const rows = globalThis.jQuery(".row");
const mod = globalThis.angular.module("banned");
console.log(rows.length, mod.name);
