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

// Under jsdom the global ArrayBuffer/Uint8Array belong to jsdom's realm, and
// Node 20's crypto.subtle.digest() only accepts buffers from Node's own realm
// ("2nd argument is not instance of ArrayBuffer, Buffer, TypedArray, or
// DataView"); Node 22 accepts both. Buffer.from() takes any ArrayBuffer or
// view and returns a Node-realm Buffer over the same memory, so route every
// digest input through it. Production code is untouched: real browsers have a
// single realm.
interface NodeBufferConstructor {
  from(buffer: ArrayBufferLike, byteOffset?: number, length?: number): Uint8Array;
}
const NodeBuffer = (globalThis as { Buffer?: NodeBufferConstructor }).Buffer;
if (NodeBuffer && typeof crypto !== "undefined" && "subtle" in crypto) {
  const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
  crypto.subtle.digest = (algorithm: AlgorithmIdentifier, data: BufferSource) =>
    nativeDigest(
      algorithm,
      ArrayBuffer.isView(data)
        ? NodeBuffer.from(data.buffer, data.byteOffset, data.byteLength)
        : NodeBuffer.from(data),
    );
}

// jsdom's Blob (and File) cannot be read with arrayBuffer() or text(), which
// the browser and Node both can; give it the same two methods through a
// FileReader so the components that read a File can be tested.
if (typeof FileReader !== "undefined" && !("arrayBuffer" in Blob.prototype)) {
  const readAsArrayBuffer = (blob: Blob) =>
    new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve(reader.result as ArrayBuffer);
      };
      reader.onerror = () => {
        reject(new Error("The blob could not be read."));
      };
      reader.readAsArrayBuffer(blob);
    });
  Object.defineProperty(Blob.prototype, "arrayBuffer", {
    configurable: true,
    value(this: Blob) {
      return readAsArrayBuffer(this);
    },
  });
  Object.defineProperty(Blob.prototype, "text", {
    configurable: true,
    async value(this: Blob) {
      return new TextDecoder().decode(await readAsArrayBuffer(this));
    },
  });
}
