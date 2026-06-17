// Two dynamic sinks (flagged) share one message; the static string is not.
document.body.innerHTML = location.hash;
const safe = document.getElementById("x");
safe.innerHTML = "<p>static</p>";
const el = document.getElementById("y");
el.innerHTML = location.search;
