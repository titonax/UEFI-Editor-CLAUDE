import type { Forms, Menu, Suppression } from "./types";

export async function sha256Hex(data: BufferSource) {
  const digest = await crypto.subtle.digest("SHA-256", data);

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
