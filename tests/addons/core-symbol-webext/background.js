Services.wm.getMostRecentWindow("mail:3pane"); // CORE in WebExtension -> FLAGGED
const mod = ChromeUtils.importESModule("resource:///x.sys.mjs"); // CORE -> FLAGGED too
messenger.wl.registerWindow("chrome://x/win.xhtml", "content/legacy.js");
messenger.mystery.run("content/maybe.js");
