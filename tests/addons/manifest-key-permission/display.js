// Injected into message display pages via the message_display_scripts manifest
// key, which requires "messagesModify" - undeclared here, so it is reported as a
// missing permission anchored to the manifest key.
document.body?.setAttribute("data-kim-display", "1");
