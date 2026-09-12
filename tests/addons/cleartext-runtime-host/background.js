// The host is assembled at run time, so the scan resolves only the "http://" prefix:
// remote and cleartext are both known, the host is not. Three sends to prove they
// collapse into one entry rather than one entry per destination.
async function send(server, payload) {
  await fetch(`http://${server}/api`, { method: "POST", body: payload });
}
fetch("http://logs.example.org/l", { method: "POST", body: "b" });
fetch("http://metrics.example.net/m", { method: "POST", body: "c" });
send("api.example.com", "a");
