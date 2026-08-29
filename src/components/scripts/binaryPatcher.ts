import { saveAs } from "file-saver";
import type { PopulatedFiles } from "../FileUploads/FileUploads";
import { sameHexId } from "./hexId";
import type { Data, Suppression } from "./types";

export function validateByteInput(value: string) {
  return (
    value.length <= 2 &&
    (value.length === 0 ||
      value.split("").every((char) => /[a-fA-F0-9]/.test(char)))
  );
}

export function replaceAt(
  string: string,
  index: number,
  length: number,
  replacement: string,
) {
  return string.slice(0, index) + replacement + string.slice(index + length);
}

export function offsetToIndex(offset: string) {
  return parseInt(offset, 16) * 2;
}

export function decToHexString(decimal: number) {
  return `0x${decimal.toString(16).toUpperCase()}`;
}

export function getUint8Array(string: string) {
  const array = [];
  for (let i = 0, len = string.length; i < len; i += 2) {
    array[i / 2] = parseInt(string.slice(i, i + 2), 16);
  }

  return array;
}

export function downloadModifiedFiles(data: Data, files: PopulatedFiles) {
  let wasSetupSctModified = false;
  let wasAmitseSctModified = false;
  let wasSetupdataBinModified = false;

  let changeLog = "";

  let modifiedSetupSct = files.setupSctContainer.textContent;
  let setupSctChangeLog = "";

  const suppressions = JSON.parse(
    JSON.stringify(data.suppressions),
  ) as Suppression[];

  for (const suppression of suppressions) {
    if ((suppression.kind ?? "SuppressIf") !== "SuppressIf") {
      continue;
    }
    if (!suppression.active) {
      if (
        modifiedSetupSct.slice(
          offsetToIndex(suppression.end),
          offsetToIndex(suppression.end) + 4,
        ) !== "2902"
      ) {
        throw new Error(
          "Something went wrong. Please file a bug report on Github.",
        );
      }

      modifiedSetupSct = replaceAt(
        modifiedSetupSct,
        offsetToIndex(suppression.end),
        4,
        "",
      );

      modifiedSetupSct = replaceAt(
        modifiedSetupSct,
        offsetToIndex(suppression.start),
        0,
        "2902",
      );

      for (const suppressionToUpdate of suppressions) {
        if (suppressionToUpdate.offset !== suppression.offset) {
          if (
            parseInt(suppression.start, 16) <
              parseInt(suppressionToUpdate.start, 16) &&
            parseInt(suppressionToUpdate.start, 16) <
              parseInt(suppression.end, 16)
          ) {
            suppressionToUpdate.start = decToHexString(
              (offsetToIndex(suppressionToUpdate.start) + 8) / 2,
            );
          }

          if (
            parseInt(suppression.start, 16) <
              parseInt(suppressionToUpdate.end, 16) &&
            parseInt(suppressionToUpdate.end, 16) <
              parseInt(suppression.end, 16)
          ) {
            suppressionToUpdate.end = decToHexString(
              (offsetToIndex(suppressionToUpdate.end) + 8) / 2,
            );
          }
        }
      }

      setupSctChangeLog += `Unsuppressed ${suppression.offset}\n`;

      wasSetupSctModified = true;
    }
  }

  let modifiedAmitseSct = files.amitseSctContainer.textContent;
  let amitseSctChangeLog = "";

  for (const entry of data.menu) {
    if (entry.offset === null) {
      continue;
    }

    const padded = entry.formId.split("x")[1].padStart(4, "0");
    const newValue = padded.slice(2) + padded.slice(0, 2);
    const index = offsetToIndex(entry.offset);
    const oldValue = modifiedAmitseSct.slice(index, index + 4);

    if (newValue !== oldValue) {
      modifiedAmitseSct = replaceAt(modifiedAmitseSct, index, 4, newValue);

      const oldFormId = decToHexString(
        parseInt(oldValue.slice(-2) + oldValue.slice(-4, -2), 16),
      );
      const oldForm = data.forms.find((form) =>
        sameHexId(form.formId, oldFormId),
      );
      const newForm = data.forms.find((form) =>
        sameHexId(form.formId, entry.formId),
      );
      if (!oldForm || !newForm) {
        throw new Error(
          "Something went wrong. Please file a bug report on Github.",
        );
      }

      amitseSctChangeLog += `${oldForm.name} | FormId ${oldFormId} -> ${newForm.name} | FormId ${entry.formId}\n`;

      wasAmitseSctModified = true;
    }
  }

  let modifiedSetupdataBin = files.setupdataBinContainer.textContent;
  let setupdataBinChangeLog = "";

  for (const form of data.forms) {
    for (const child of form.children) {
      if (
        child.offsets &&
        child.accessLevel &&
        child.failsafe &&
        child.optimal
      ) {
        const accessLevelIndex = offsetToIndex(child.offsets.accessLevel);
        const oldAccessLevel = modifiedSetupdataBin.slice(
          accessLevelIndex,
          accessLevelIndex + 2,
        );
        const newAccessLevel = child.accessLevel.padStart(2, "0");
        if (oldAccessLevel !== newAccessLevel) {
          modifiedSetupdataBin = replaceAt(
            modifiedSetupdataBin,
            accessLevelIndex,
            2,
            newAccessLevel,
          );
          setupdataBinChangeLog += `${child.name} | QuestionId ${child.questionId}: Access Level ${oldAccessLevel} -> ${newAccessLevel}\n`;

          wasSetupdataBinModified = true;
        }

        const failsafeIndex = offsetToIndex(child.offsets.failsafe);
        const oldFailsafe = modifiedSetupdataBin.slice(
          failsafeIndex,
          failsafeIndex + 2,
        );
        const newFailsafe = child.failsafe.padStart(2, "0");
        if (oldFailsafe !== newFailsafe) {
          modifiedSetupdataBin = replaceAt(
            modifiedSetupdataBin,
            failsafeIndex,
            2,
            newFailsafe,
          );
          setupdataBinChangeLog += `${child.name} | QuestionId ${child.questionId}: Failsafe ${oldFailsafe} -> ${newFailsafe}\n`;

          wasSetupdataBinModified = true;
        }

        const optimalIndex = offsetToIndex(child.offsets.optimal);
        const oldOptimal = modifiedSetupdataBin.slice(
          optimalIndex,
          optimalIndex + 2,
        );
        const newOptimal = child.optimal.padStart(2, "0");
        if (oldOptimal !== newOptimal) {
          modifiedSetupdataBin = replaceAt(
            modifiedSetupdataBin,
            optimalIndex,
            2,
            newOptimal,
          );
          setupdataBinChangeLog += `${child.name} | QuestionId ${child.questionId}: Optimal ${oldOptimal} -> ${newOptimal}\n`;

          wasSetupdataBinModified = true;
        }
      }
    }
  }

  if (wasSetupSctModified) {
    changeLog += `========== ${files.setupSctContainer.file.name} ==========\n\n${setupSctChangeLog}\n\n\n`;

    saveAs(
      new Blob([new Uint8Array(getUint8Array(modifiedSetupSct))], {
        type: "application/octet-stream",
      }),
      files.setupSctContainer.file.name,
    );
  }

  if (wasAmitseSctModified) {
    changeLog += `========== ${files.amitseSctContainer.file.name} ==========\n\n${amitseSctChangeLog}\n\n\n`;

    saveAs(
      new Blob([new Uint8Array(getUint8Array(modifiedAmitseSct))], {
        type: "application/octet-stream",
      }),
      files.amitseSctContainer.file.name,
    );
  }

  if (wasSetupdataBinModified) {
    changeLog += `========== ${files.setupdataBinContainer.file.name} ==========\n\n${setupdataBinChangeLog}\n\n\n`;

    saveAs(
      new Blob([new Uint8Array(getUint8Array(modifiedSetupdataBin))], {
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
