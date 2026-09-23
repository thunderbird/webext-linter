// The pre-build source entry point: named main.js, not the background.js the XPI
// ships, so the two layouts genuinely differ. The fake namespace proves the code
// checks reviewed this file.
browser.totallyFakeNamespace.doThing();
