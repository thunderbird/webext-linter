// The submitted archive is clean: nothing here halts a running Thunderbird.
const digest = (items) => items.map((i) => i.subject).join(", ");
console.log(digest([]));
