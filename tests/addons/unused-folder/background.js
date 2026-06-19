// Minimal entry point. It references nothing under deadtree/, so that whole
// nested tree is unreachable - and since every file in it is unused, the report
// collapses it to the single top-most folder "deadtree/".
function init() {
  return true;
}
init();
