
Thank you for your submission. We appreciate the effort you’ve put into creating this add-on. However, it cannot be accepted and hosted on addons.thunderbird.net in its current form. The following findings caused the submission to be rejected:

1) Data is sent over an unencrypted connection. All data must travel over an encrypted channel - use https:// (or wss:// for sockets), never http://, ws:// or ftp://.
 - sync.js:12 - posts over http://

You can run this automated review yourself before submitting:
https://github.com/thunderbird/webext-linter
