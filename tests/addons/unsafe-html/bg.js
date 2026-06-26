// Every innerHTML write is flagged (static and dynamic alike); an empty clear is exempt.
document.body.innerHTML = location.hash;
const safe = document.getElementById("x");
safe.innerHTML = "<p>static</p>";
const el = document.getElementById("y");
el.innerHTML = location.search;
const clr = document.getElementById("z");
clr.innerHTML = "";
