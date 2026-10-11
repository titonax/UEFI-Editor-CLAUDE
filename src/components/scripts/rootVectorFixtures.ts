// A synthetic x86-64 PE32+ carrying the Setup root registration vector, for the
// tests of its detection and of editing it inside a rebuilt image. Not firmware.
import type { Menu } from "./types";

export const IMAGE_BASE = 0x180000000;

function writeName(bytes: Uint8Array, offset: number, value: string) {
  bytes.set(new TextEncoder().encode(value), offset);
}

function writeRipDisplacement(view: DataView, instructionOffset: number, targetRva: number) {
  view.setInt32(instructionOffset + 3, targetRva - (instructionOffset + 7), true);
}

// A synthetic x86-64 PE32+ with a .text section holding the root-vector
// loop (lea rbx, [vector]; lea rdi, [table]; cmp byte [rbx], 0; jne; inc
// rbx; add rdi, 0x20; sub rsi, 1; jne back) and a .data section holding
// the vector and the page table. Raw offsets equal RVAs, which keeps the
// RIP-relative arithmetic readable.
export function buildPe(
  values: number[],
  options: { dynamicCount?: boolean; secondVector?: number[] } = {},
) {
  const bytes = new Uint8Array(0x900);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4d, 0x5a], 0);
  view.setUint32(0x3c, 0x80, true);
  bytes.set([0x50, 0x45, 0, 0], 0x80);
  view.setUint16(0x84, 0x8664, true);
  view.setUint16(0x86, 2, true);
  view.setUint16(0x94, 0xf0, true);
  view.setUint16(0x98, 0x20b, true);
  view.setBigUint64(0xb0, BigInt(IMAGE_BASE), true);

  const textHeader = 0x188;
  writeName(bytes, textHeader, ".text");
  view.setUint32(textHeader + 8, 0x200, true);
  view.setUint32(textHeader + 12, 0x200, true);
  view.setUint32(textHeader + 16, 0x200, true);
  view.setUint32(textHeader + 20, 0x200, true);
  view.setUint32(textHeader + 36, 0x60000020, true);

  const dataHeader = textHeader + 40;
  writeName(bytes, dataHeader, ".data");
  view.setUint32(dataHeader + 8, 0x300, true);
  view.setUint32(dataHeader + 12, 0x600, true);
  view.setUint32(dataHeader + 16, 0x300, true);
  view.setUint32(dataHeader + 20, 0x600, true);
  view.setUint32(dataHeader + 36, 0xc0000040, true);

  function writeLoop(
    codeOffset: number,
    vectorOffset: number,
    tableOffset: number,
    loopValues: number[],
    dynamicCount: boolean,
  ) {
    if (dynamicCount) {
      const countOffset = 0x6f0;
      view.setUint32(countOffset, loopValues.length, true);
      bytes.set([0x8b, 0x05, 0, 0, 0, 0], codeOffset - 8);
      view.setInt32(codeOffset - 6, countOffset - (codeOffset - 8 + 6), true);
    } else {
      bytes[codeOffset - 8] = 0xbe;
      view.setUint32(codeOffset - 7, loopValues.length, true);
    }

    bytes.set([0x48, 0x8d, 0x1d, 0, 0, 0, 0], codeOffset);
    writeRipDisplacement(view, codeOffset, vectorOffset);
    bytes.set([0x48, 0x8d, 0x3d, 0, 0, 0, 0], codeOffset + 7);
    writeRipDisplacement(view, codeOffset + 7, tableOffset);
    bytes.set(
      [
        0x80, 0x3b, 0x00, 0x75, 0x08, 0x48, 0xff, 0xc3, 0x48, 0x83, 0xc7, 0x20, 0x48,
        0x83, 0xee, 0x01, 0x75, 0xee,
      ],
      codeOffset + 14,
    );
    bytes.set(loopValues, vectorOffset);
  }

  writeLoop(0x220, 0x680, 0x700, values, options.dynamicCount ?? false);
  if (options.secondVector) {
    writeLoop(0x280, 0x6c0, 0x780, options.secondVector, false);
  }
  return bytes;
}


export const VECTOR_OFFSET = 0x680;

export function rootMenu(count: number): Menu {
  return Array.from({ length: count }, (_, index) => ({
    name: `Root ${String(index)}`,
    formId: `0x${String(index + 1)}`,
    formSetGuid: `0000000${String(index)}-0000-0000-0000-000000000000`,
    offset: null,
    source: "formset" as const,
  }));
}
