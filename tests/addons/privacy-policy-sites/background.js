// The three shapes privacy-policy has to tell apart, in one add-on.

// One host reached from TWO sites: two cases, each with its own verdict, printed as one
// line because the entry collapses on the subject - the second rides on "(+1 elsewhere)".
fetch("https://api.example.com/one", { method: "POST", body: data });
fetch("https://api.example.com/two", { method: "POST", body: data });

// A second host, reached once: its own line, no count.
fetch("https://logs.example.net/x", { method: "POST", body: data });

// A host assembled at run time. The scheme is written here, the host is not, so the scan
// knows the destination is remote and cannot say whose it is. Reported all the same -
// dropping it would hide the site the tool can say least about - and its line carries a
// hint rather than claiming a hostname.
fetch(`https://${server}/api`, { method: "POST", body: data });
