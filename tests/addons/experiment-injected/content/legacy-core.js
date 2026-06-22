// Legacy overlay code in a privileged core context: messenger.msgHdrFromURI is a
// core function absent from the WebExtension schema. EXEMPT - must NOT be flagged.
var hdr = messenger.msgHdrFromURI("mailbox://x");
