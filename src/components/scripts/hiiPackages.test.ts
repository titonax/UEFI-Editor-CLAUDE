import { describe, expect, it } from "vitest";
import { scanHiiFormsPackages } from "./hiiPackages";

function guidBytes(value: string) {
  const parts = value.split("-");
  const reverse = (hex: string) => hex.match(/../g)?.reverse().join("") ?? "";
  const encoded =
    reverse(parts[0]) + reverse(parts[1]) + reverse(parts[2]) + parts[3] + parts[4];
  return Uint8Array.from(encoded.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

// A 37-byte Forms Package: header, a FormSet opcode (23 bytes, GUID at +2),
// one Form opcode (6 bytes) and the two End opcodes closing both scopes.
function formsPackage(guid: string, formId: number) {
  const bytes = new Uint8Array(37);
  bytes.set([37, 0, 0, 0x02], 0);
  bytes.set([0x0e, 0x97], 4);
  bytes.set(guidBytes(guid), 6);
  bytes.set([0x01, 0x86, formId & 0xff, formId >> 8, 0, 0], 27);
  bytes.set([0x29, 0x02, 0x29, 0x02], 33);
  return bytes;
}

function packageList(...packages: Uint8Array[]) {
  const body = packages.reduce((total, pkg) => total + pkg.length, 0);
  const bytes = new Uint8Array(20 + body + 4);
  new DataView(bytes.buffer).setUint32(16, bytes.length, true);
  let cursor = 20;
  for (const pkg of packages) {
    bytes.set(pkg, cursor);
    cursor += pkg.length;
  }
  bytes.set([4, 0, 0, 0xdf], cursor);
  return bytes;
}

const guidA = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const guidB = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";

describe("scanHiiFormsPackages", () => {
  it("reads every Forms Package of a leading package list", () => {
    const bytes = packageList(formsPackage(guidA, 1), formsPackage(guidB, 2));

    expect(scanHiiFormsPackages(bytes)).toEqual([
      {
        offset: 20,
        end: 57,
        length: 37,
        payloadOffset: 24,
        packageListOffset: 0,
        formSetGuids: [guidA],
        formCount: 1,
      },
      {
        offset: 57,
        end: 94,
        length: 37,
        payloadOffset: 61,
        packageListOffset: 0,
        formSetGuids: [guidB],
        formCount: 1,
      },
    ]);
  });

  it("accepts a bare Forms Package with no list around it", () => {
    expect(scanHiiFormsPackages(formsPackage(guidA, 1))).toMatchObject([
      { offset: 0, packageListOffset: null, formSetGuids: [guidA] },
    ]);
  });

  it("finds a package list embedded in the middle of unrelated data", () => {
    const list = packageList(formsPackage(guidA, 1));
    const bytes = new Uint8Array(64 + list.length + 16);
    bytes.fill(0x5a);
    bytes.set(list, 64);

    expect(scanHiiFormsPackages(bytes)).toMatchObject([
      { offset: 84, packageListOffset: 64, formSetGuids: [guidA] },
    ]);
  });

  it("finds a bare FormSet-led package embedded in unrelated data", () => {
    const pkg = formsPackage(guidB, 7);
    const bytes = new Uint8Array(32 + pkg.length + 8);
    bytes.fill(0x11);
    bytes.set(pkg, 32);

    expect(scanHiiFormsPackages(bytes)).toMatchObject([
      { offset: 32, packageListOffset: null, formSetGuids: [guidB], formCount: 1 },
    ]);
  });

  it("rejects a package whose opcode scopes are unbalanced", () => {
    const pkg = formsPackage(guidA, 1);
    pkg[35] = 0x03; // turn the FormSet's closing End into a Text opcode

    expect(scanHiiFormsPackages(pkg)).toEqual([]);
  });

  it("rejects a package whose declared opcode length overruns it", () => {
    const pkg = formsPackage(guidA, 1);
    pkg[28] = 0x90; // Form opcode now claims 16 bytes, past the package end

    expect(scanHiiFormsPackages(pkg)).toEqual([]);
  });

  it("keeps the packages read before an inconsistent list boundary", () => {
    const bytes = packageList(formsPackage(guidA, 1));
    bytes[bytes.length - 1] = 0x00; // END package type corrupted

    expect(scanHiiFormsPackages(bytes)).toMatchObject([{ offset: 20 }]);
  });

  it("returns nothing for a buffer without any Forms Package", () => {
    expect(scanHiiFormsPackages(new Uint8Array(64))).toEqual([]);
  });
});
