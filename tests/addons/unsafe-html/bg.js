// Every innerHTML write is flagged (static and dynamic alike); an empty clear is exempt.
document.body.innerHTML = location.hash;

safe.innerHTML = "<p>static</p>";

el.innerHTML = location.search;

clr.innerHTML = "";

// The other two markup sinks. Each names a different item, so these are separate
// entries: the advice is per-sink, which is why these do not share a message.
old.outerHTML = location.hash;

list.insertAdjacentHTML("beforeend", location.hash);
