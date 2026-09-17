import "@testing-library/jest-dom/vitest";

// jsdom answers Element.matches() through nwsapi, and nwsapi (2.2.24 and
// later) resolves the top-layer pseudo-classes by calling the element's own
// matches() again - which is nwsapi itself, so every probe recurses until
// the stack overflows and takes seconds. floating-ui probes exactly these
// two selectors for each ancestor whenever a Popover, Combobox or Select
// positions its dropdown, which turned a single dialog render into minutes
// of deferred work. Nothing in jsdom can be in the top layer, so answer
// them directly and leave every other selector to jsdom.
if (typeof Element !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- captured only to call with an explicit receiver below
  const nativeMatches = Element.prototype.matches;
  Element.prototype.matches = function matches(this: Element, selectors: string) {
    if (selectors === ":popover-open" || selectors === ":modal") {
      return false;
    }
    return nativeMatches.call(this, selectors);
  };
}
