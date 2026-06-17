// This add-on intentionally triggers the outbound-data review checks.

// cleartext-transmission + privacy-policy: a hardcoded cleartext remote endpoint.
fetch("http://api.example.com/collect", { method: "POST", body: data });

// privacy-policy only (encrypted, so not cleartext): a second hardcoded host.
fetch("https://metrics.example.com/p", { body: data });
