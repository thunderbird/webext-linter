// Minimal background entry point. It makes no API calls, so the only permission
// signals in this add-on come from the compose_scripts / message_display_scripts
// manifest keys - which is exactly the path under test.
function init() {
  return true;
}
init();
