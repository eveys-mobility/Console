// Test environment shims for components that touch browser APIs we
// don't want to (or can't) run for real in jsdom.

import '@testing-library/jest-dom/vitest';

// Every HTTP dependency must be explicitly faked by its test. The OS
// network-deny sandbox is a second barrier, including localhost.
globalThis.fetch = () => {
  throw new Error('Unexpected fetch in isolated test');
};

// matchMedia: jsdom doesn't implement it. Our useIsBelow() hook reads
// it on first render and subscribes to change events. Default to
// "matches: false" so a fresh test renders the desktop layout
// unless overridden via setMatchMedia(true) in a per-test mock.
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

// scrollIntoView: Radix primitives call this on focus moves; jsdom
// doesn't implement it. No-op is fine.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function noopScrollIntoView() {
    // no-op for tests
  };
}
