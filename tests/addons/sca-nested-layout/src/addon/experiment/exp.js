// Privileged Experiment implementation, INSIDE --sca-source. Two things at once:
// the ChromeUtils call is legitimate here and core-symbol-in-webext must stay silent on
// it (that is what --sca-exp-source is for), while the innerHTML sink is not excused by
// being privileged - it is worse there - so unsafe-html must still report it. The
// exclusion is scoped to the WebExtension checks, not a blanket exemption.
ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
document.body.innerHTML = untrustedValue;
