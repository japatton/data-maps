// The host's global object, resolved once and in one place.
//
// The one-word ES2020 spelling of it is newer than Studio's floor of ES2018
// (see the README), so the lookup is written out by hand: a browser answers
// to `window`, a worker to `self`, Node to `global`.  `typeof` is used
// throughout, because naming an undeclared identifier directly would throw.
//
// Reading a property off it is deliberately left to the caller: touching
// `localStorage` at import time throws in a browser told to block site data,
// and every Studio module must import cleanly under Node.

export const globalObject = (function resolve() {
  if (typeof window !== "undefined") return window;
  if (typeof self !== "undefined") return self;
  if (typeof global !== "undefined") return global;
  return {};
}());
