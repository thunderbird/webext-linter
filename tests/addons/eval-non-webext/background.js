// WebExtension background script - inside the pure WebExtension tree. A
// WebExtension sandbox cannot run eval / the Function constructor / a code-string
// timer without a permissive CSP (which csp-unsafe-* would report), so these are
// deliberately NOT flagged by eval-call / function-constructor / string-timer.
browser.evalexp.doThing().then((r) => console.log(r));

eval("doSomething()");
const fn = new Function("return 1");
setTimeout("doSomething()", 0);
console.log(fn);
