// This add-on intentionally triggers every deterministic check.

// unknown-api: an unknown namespace and an unknown member.
browser.bogusApi.doThing();
browser.messages.frobnicate();

// deprecated-api: a deprecated method, a version-incompatible method, and a
// deprecated namespace.
browser.messages.oldOne();
browser.messages.future();
browser.legacy.doThing();

// missing-permission: messages.* needs messagesRead; move() also needs
// accountsRead + messagesMove; none are declared.
browser.messages.list("INBOX");
browser.messages.move([1], "Trash");

// missing-permission (manifest key): the action API needs the "action" key.
browser.action.onClicked.addListener(() => {});

// eval-usage.
eval("doSomething()");

// sync-xhr.
const xhr = new XMLHttpRequest();
xhr.open("GET", "/data", false);

// unsafe-html.
document.body.innerHTML = location.hash;

// debugger-statement (unconditional).
debugger;

// async-onmessage.
browser.runtime.onMessage.addListener(async (msg) => msg);

// code-sanity: no-redeclare (prefer-const is a style fix, not flagged).
let neverReassigned = 1;
console.log(neverReassigned);
var duplicate = 2;
var duplicate = 3;
console.log(duplicate);
