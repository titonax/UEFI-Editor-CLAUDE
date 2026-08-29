import type { Forms, Menu, Suppression } from "./types";

// Some browser extensions (privacy/anti-fingerprinting tools in particular)
// intercept or shim the Web Crypto API and can leave a digest() call
// permanently unresolved instead of rejecting it - indistinguishable from
// the whole app hanging, since nothing else here is CPU-bound enough to
// explain a multi-second stall. A generous timeout turns that into a
// diagnosable error instead of a silent, indefinite wait.
const SHA256_TIMEOUT_MS = 15_000;

export async function sha256Hex(data: BufferSource) {
  const digest = await Promise.race([
    crypto.subtle.digest("SHA-256", data),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(
          new Error(
            `Hashing timed out after ${String(SHA256_TIMEOUT_MS / 1000)}s. A browser extension (privacy/anti-fingerprinting tools sometimes intercept the Web Crypto API) may be blocking this - try disabling extensions or retrying in a private window.`,
          ),
        );
      }, SHA256_TIMEOUT_MS);
    }),
  ]);

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function hashFile(file: File) {
  return sha256Hex(await file.arrayBuffer());
}

export async function calculateJsonChecksum(
  menu: Menu,
  forms: Forms,
  suppressions: Suppression[],
) {
  let offsetChecksum = "";

  for (const menuItem of menu) {
    offsetChecksum += menuItem.offset ?? "";
  }

  for (const form of forms) {
    for (const child of form.children) {
      offsetChecksum += JSON.stringify(child.offsets);
    }
  }

  for (const suppression of suppressions) {
    offsetChecksum += suppression.offset + suppression.start + suppression.end;
  }

  return sha256Hex(new TextEncoder().encode(offsetChecksum));
}
