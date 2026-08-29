import { saveAs } from "file-saver";
import type { PopulatedFiles } from "../FileUploads/FileUploads";
import { parseHexId, sameHexId } from "./hexId";
import type { Data, Suppression } from "./types";

export function validateByteInput(value: string) {
  return (
    value.length <= 2 &&
    (value.length === 0 ||
      value.split("").every((char) => /[a-fA-F0-9]/.test(char)))
  );
}

export function decToHexString(decimal: number) {
  return `0x${decimal.toString(16).toUpperCase()}`;
}

function byteHex(byte: number) {
  return byte.toString(16).toUpperCase().padStart(2, "0");
}

export function hexToBytes(hex: string) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const END_OPCODE = [0x29, 0x02];

// Moves the 2-byte "End" opcode that closes a SuppressIf scope from `end`
// to `start`, unconditionally exposing the bytes it used to guard. Total
// length is unchanged: the removed bytes at `end` are exactly the ones
// inserted at `start`, so this is a single in-place shift of the region
// between the two rather than a remove-then-insert on the whole buffer.
function moveEndOpcodeToStart(bytes: Uint8Array, start: number, end: number) {
  if (bytes[end] !== END_OPCODE[0] || bytes[end + 1] !== END_OPCODE[1]) {
    throw new Error(
      "Something went wrong. Please file a bug report on Github.",
    );
  }

  bytes.copyWithin(start + END_OPCODE.length, start, end);
  bytes[start] = END_OPCODE[0];
  bytes[start + 1] = END_OPCODE[1];
}

export function downloadModifiedFiles(data: Data, files: PopulatedFiles) {
  let wasSetupSctModified = false;
  let wasAmitseSctModified = false;
  let wasSetupdataBinModified = false;

  let changeLog = "";

  const modifiedSetupSct = hexToBytes(files.setupSctContainer.textContent);
  let setupSctChangeLog = "";

  const suppressions = JSON.parse(
    JSON.stringify(data.suppressions),
  ) as Suppression[];

  for (const suppression of suppressions) {
    if ((suppression.kind ?? "SuppressIf") !== "SuppressIf") {
      continue;
    }
    if (!suppression.active) {
      const start = parseHexId(suppression.start);
      const end = parseHexId(suppression.end);
      moveEndOpcodeToStart(modifiedSetupSct, start, end);

      // Any other suppression whose start/end falls strictly inside this
      // one's guarded range physically moves by exactly one End-opcode's
      // width: moveEndOpcodeToStart only shifts the [start, end) region
      // right by END_OPCODE.length, it doesn't touch anything before
      // `start` or at/after `end`. parseData() always pushes a nested
      // suppression before the one that encloses it (scopes close
      // innermost-first), so in practice this suppression's own
      // moveEndOpcodeToStart call above has already run for every entry
      // that could be nested inside it by the time we get here. This loop
      // exists so the bookkeeping stays correct even if that ordering
      // assumption is ever violated (e.g. a hand-edited data.json).
      for (const suppressionToUpdate of suppressions) {
        if (suppressionToUpdate.offset !== suppression.offset) {
          const updateStart = parseHexId(suppressionToUpdate.start);
          const updateEnd = parseHexId(suppressionToUpdate.end);

          if (start < updateStart && updateStart < end) {
            suppressionToUpdate.start = decToHexString(
              updateStart + END_OPCODE.length,
            );
          }

          if (start < updateEnd && updateEnd < end) {
            suppressionToUpdate.end = decToHexString(
              updateEnd + END_OPCODE.length,
            );
          }
        }
      }

      setupSctChangeLog += `Unsuppressed ${suppression.offset}\n`;

      wasSetupSctModified = true;
    }
  }

  const modifiedAmitseSct = hexToBytes(files.amitseSctContainer.textContent);
  let amitseSctChangeLog = "";

  for (const entry of data.menu) {
    if (entry.offset === null) {
      continue;
    }

    const newFormId = parseHexId(entry.formId);
    const index = parseHexId(entry.offset);
    const oldFormId = modifiedAmitseSct[index] | (modifiedAmitseSct[index + 1] << 8);

    if (newFormId !== oldFormId) {
      modifiedAmitseSct[index] = newFormId & 0xff;
      modifiedAmitseSct[index + 1] = (newFormId >> 8) & 0xff;

      const oldFormIdHex = decToHexString(oldFormId);
      const oldForm = data.forms.find((form) =>
        sameHexId(form.formId, oldFormIdHex),
      );
      const newForm = data.forms.find((form) =>
        sameHexId(form.formId, entry.formId),
      );
      if (!oldForm || !newForm) {
        throw new Error(
          "Something went wrong. Please file a bug report on Github.",
        );
      }

      amitseSctChangeLog += `${oldForm.name} | FormId ${oldFormIdHex} -> ${newForm.name} | FormId ${entry.formId}\n`;

      wasAmitseSctModified = true;
    }
  }

  const modifiedSetupdataBin = hexToBytes(
    files.setupdataBinContainer.textContent,
  );
  let setupdataBinChangeLog = "";

  for (const form of data.forms) {
    for (const child of form.children) {
      if (
        child.offsets &&
        child.accessLevel &&
        child.failsafe &&
        child.optimal
      ) {
        const accessLevelIndex = parseHexId(child.offsets.accessLevel);
        const oldAccessLevel = modifiedSetupdataBin[accessLevelIndex];
        const newAccessLevel = parseHexId(child.accessLevel);
        if (oldAccessLevel !== newAccessLevel) {
          modifiedSetupdataBin[accessLevelIndex] = newAccessLevel;
          setupdataBinChangeLog += `${child.name} | QuestionId ${child.questionId}: Access Level ${byteHex(oldAccessLevel)} -> ${byteHex(newAccessLevel)}\n`;

          wasSetupdataBinModified = true;
        }

        const failsafeIndex = parseHexId(child.offsets.failsafe);
        const oldFailsafe = modifiedSetupdataBin[failsafeIndex];
        const newFailsafe = parseHexId(child.failsafe);
        if (oldFailsafe !== newFailsafe) {
          modifiedSetupdataBin[failsafeIndex] = newFailsafe;
          setupdataBinChangeLog += `${child.name} | QuestionId ${child.questionId}: Failsafe ${byteHex(oldFailsafe)} -> ${byteHex(newFailsafe)}\n`;

          wasSetupdataBinModified = true;
        }

        const optimalIndex = parseHexId(child.offsets.optimal);
        const oldOptimal = modifiedSetupdataBin[optimalIndex];
        const newOptimal = parseHexId(child.optimal);
        if (oldOptimal !== newOptimal) {
          modifiedSetupdataBin[optimalIndex] = newOptimal;
          setupdataBinChangeLog += `${child.name} | QuestionId ${child.questionId}: Optimal ${byteHex(oldOptimal)} -> ${byteHex(newOptimal)}\n`;

          wasSetupdataBinModified = true;
        }
      }
    }
  }

  if (wasSetupSctModified) {
    changeLog += `========== ${files.setupSctContainer.file.name} ==========\n\n${setupSctChangeLog}\n\n\n`;

    saveAs(
      new Blob([modifiedSetupSct], {
        type: "application/octet-stream",
      }),
      files.setupSctContainer.file.name,
    );
  }

  if (wasAmitseSctModified) {
    changeLog += `========== ${files.amitseSctContainer.file.name} ==========\n\n${amitseSctChangeLog}\n\n\n`;

    saveAs(
      new Blob([modifiedAmitseSct], {
        type: "application/octet-stream",
      }),
      files.amitseSctContainer.file.name,
    );
  }

  if (wasSetupdataBinModified) {
    changeLog += `========== ${files.setupdataBinContainer.file.name} ==========\n\n${setupdataBinChangeLog}\n\n\n`;

    saveAs(
      new Blob([modifiedSetupdataBin], {
        type: "application/octet-stream",
      }),
      files.setupdataBinContainer.file.name,
    );
  }

  if (wasSetupSctModified || wasAmitseSctModified || wasSetupdataBinModified) {
    saveAs(
      new Blob([changeLog], {
        type: "text/plain",
      }),
      "changelog.txt",
    );

    return { status: "downloaded" } as const;
  }

  return { status: "no-changes" } as const;
}
