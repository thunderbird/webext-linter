// If the source archive were ever reviewed on the reject path, these would fire
// (eval-call, debugger-statement). They must NOT appear: the review target is the XPI.
eval("1+1");
debugger;
