// A canary for the early exit: the review stops at experiment-not-allowed, its first check,
// so nothing after it runs. If one did, these would fire (eval-call, debugger-statement).
eval("1+1");
debugger;
