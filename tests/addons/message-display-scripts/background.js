// Minimal entry point. It deliberately references neither content.js nor
// assets/content.css, so those files are reachable ONLY as message_display_scripts
// seeds from the manifest - which is exactly the path under test. The unreachable/
// tree is referenced by nothing and is the sole expected finding.
function init() {
  return true;
}
init();
