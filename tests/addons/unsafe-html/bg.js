// Dynamic content into innerHTML is flagged; a static string is not.
document.body.innerHTML = location.hash;
const safe = document.getElementById("x");
safe.innerHTML = "<p>static</p>";
