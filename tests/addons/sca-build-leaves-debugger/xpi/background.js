// What actually ships. The build left a debugger statement behind, and a statement that
// is in the XPI is one the build did NOT strip - a review that reads only the archive
// cannot see it, because the archive is exactly the code the developer wrote.
const digest = (items) => {
  debugger;
  return items.map((i) => i.subject).join(", ");
};
console.log(digest([]));
