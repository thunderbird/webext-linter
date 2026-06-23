// Subscript-loaded by the wl experiment (core context), so its ChromeUtils usage is
// privileged and EXEMPT - it is reached only through the Experiment core loader.
const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
MailServices.accounts.defaultAccount;
