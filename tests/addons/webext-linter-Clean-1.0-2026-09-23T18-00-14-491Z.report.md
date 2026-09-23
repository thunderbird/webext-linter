
Thank you for your submission. We appreciate the effort you’ve put into creating this add-on. However, it cannot be accepted and hosted on addons.thunderbird.net in its current form. The following findings caused the submission to be rejected:

1) The following code location(s) send user data or telemetry to a remote server without an explicit opt-in. User data or telemetry may be transmitted only when the user actively enables it on an options page that discloses what is sent.
 - background.js:12 - <a ping> attribute carries the message digest

You can run this automated review yourself before submitting:
https://github.com/thunderbird/webext-linter
