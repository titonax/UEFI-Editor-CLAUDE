import { saveAs } from "file-saver";
import type { PopulatedFiles } from "../FileUploads/fileModel";
import { findFormIndexByFormId, parseHexId, sameHexId } from "./hexId";
import { isSoleOwnerOfCondition } from "./refMoving";
import type { Data, Form, RefPrompt, Suppression } from "./types";

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

// An opcode's own Length byte (the low 7 bits of the second header byte)
// always encodes its total size, header included - this is how the whole
// IFR opcode stream is walked without a separate index. Reading it directly
// from the pristine bytes means a Ref's exact byte extent never needs to be
// tracked as its own parsed field.
function opcodeLength(bytes: Uint8Array, offset: number) {
  return bytes[offset + 1] & 0x7f;
}

export interface RefBlock {
  // The pristine byte range that has to move as one unit for this Ref to
  // relocate to a different Form: just the Ref opcode itself when it isn't
  // wrapped in a condition, or - when it's the sole occupant of one - that
  // whole SuppressIf/GrayOutIf/DisableIf too, so a hidden item keeps
  // whatever hides it instead of arriving unconditionally visible.
  start: number;
  length: number;
}

// Computes a Ref's movable block. Throws if the Ref shares its outermost
// condition with a sibling (see isSoleOwnerOfCondition) - the UI is
// expected to keep that case from ever reaching a move in the first place,
// so getting here means a data.json was hand-edited around that guard.
function computeRefBlock(
  data: Data,
  form: Form,
  ref: RefPrompt,
  bytes: Uint8Array,
): RefBlock {
  const conditionOffset = ref.conditions?.[0];
  if (conditionOffset !== undefined) {
    if (!isSoleOwnerOfCondition(form, ref)) {
      throw new Error(
        "Something went wrong. Please file a bug report on Github.",
      );
    }
    const suppression = data.suppressions.find(
      (candidate) => candidate.offset === conditionOffset,
    );
    if (!suppression) {
      throw new Error(
        "Something went wrong. Please file a bug report on Github.",
      );
    }
    const start = parseHexId(suppression.offset);
    const end = parseHexId(suppression.end) + END_OPCODE.length;
    return { start, length: end - start };
  }

  const start = parseHexId(ref.sctOffset);
  return { start, length: opcodeLength(bytes, start) };
}

// Where a pristine Ref's block originally lived, before any moves: the
// first Form (in physical/array order, which parseData always preserves -
// only children ever move between Forms, Forms themselves never do) whose
// own closing End sits after the block's start. Forms don't overlap, so
// this is unambiguous.
function findPristineOwnerFormIndex(data: Data, blockStart: number) {
  return data.forms.findIndex(
    (form) => parseHexId(form.endOffset) > blockStart,
  );
}

export interface DetectedRefMove {
  ref: RefPrompt;
  block: RefBlock;
  sourceFormIndex: number;
  destinationFormIndex: number;
}

// A Ref has been moved (in the declarative `data` model, immediately on the
// UI action - see relocating.ts's applyMoveToDraft) when the Form that
// currently lists it isn't the Form its pristine block position belongs to.
// Sorted by pristine block start so multiple simultaneous moves apply in a
// stable, deterministic order (see applyRefMoves for why the order itself
// doesn't affect the final byte layout).
export function detectRefMoves(
  data: Data,
  bytes: Uint8Array,
): DetectedRefMove[] {
  const moves: DetectedRefMove[] = [];

  data.forms.forEach((form, formIndex) => {
    for (const child of form.children) {
      if (child.type !== "Ref") {
        continue;
      }
      const block = computeRefBlock(data, form, child, bytes);
      const pristineOwner = findPristineOwnerFormIndex(data, block.start);
      if (pristineOwner !== formIndex) {
        moves.push({
          ref: child,
          block,
          sourceFormIndex: pristineOwner,
          destinationFormIndex: formIndex,
        });
      }
    }
  });

  return moves.sort((left, right) => left.block.start - right.block.start);
}

interface AppliedMove {
  sourceOffset: number;
  sourceEnd: number;
  destinationOffset: number;
}

// Where a pristine absolute offset ends up after one move: unchanged
// outside the moved block and the gap it crossed, shifted by the block's
// own length inside that gap, and relocated (preserving its position
// relative to the block's own start) inside the moved block itself.
function remapForMove(move: AppliedMove, offset: number) {
  const length = move.sourceEnd - move.sourceOffset;
  if (offset >= move.sourceOffset && offset < move.sourceEnd) {
    const newBlockStart =
      move.sourceOffset < move.destinationOffset
        ? move.destinationOffset - length
        : move.destinationOffset;
    return newBlockStart + (offset - move.sourceOffset);
  }
  if (move.sourceOffset < move.destinationOffset) {
    return offset >= move.sourceEnd && offset < move.destinationOffset
      ? offset - length
      : offset;
  }
  return offset >= move.destinationOffset && offset < move.sourceOffset
    ? offset + length
    : offset;
}

// Relocates [sourceOffset, sourceEnd) to right before destinationOffset, by
// rotating the (much smaller) gap between them rather than reallocating the
// whole buffer - the same in-place copyWithin technique moveEndOpcodeToStart
// uses for its own, narrower 2-byte case.
function applyMoveRotation(
  bytes: Uint8Array,
  sourceOffset: number,
  sourceEnd: number,
  destinationOffset: number,
) {
  const length = sourceEnd - sourceOffset;
  const moved = bytes.slice(sourceOffset, sourceEnd);
  if (sourceOffset < destinationOffset) {
    bytes.copyWithin(sourceOffset, sourceEnd, destinationOffset);
    bytes.set(moved, destinationOffset - length);
  } else {
    bytes.copyWithin(destinationOffset + length, destinationOffset, sourceOffset);
    bytes.set(moved, destinationOffset);
  }
}

// Physically applies every detected move to `bytes` in place, and returns a
// function that remaps any pristine offset to where it ended up. Moves are
// applied one at a time, each looking up its own source/destination through
// the running remap built from every move already applied - so regardless
// of `moves`' order, each move always operates on the buffer's actual
// current state, and the composed remap always reflects every move so far.
function applyRefMoves(
  data: Data,
  bytes: Uint8Array,
  moves: DetectedRefMove[],
) {
  let remap = (offset: number) => offset;

  for (const move of moves) {
    const sourceOffset = remap(move.block.start);
    const sourceEnd = sourceOffset + move.block.length;
    const destinationOffset = remap(
      parseHexId(data.forms[move.destinationFormIndex].endOffset),
    );

    applyMoveRotation(bytes, sourceOffset, sourceEnd, destinationOffset);

    const applied: AppliedMove = { sourceOffset, sourceEnd, destinationOffset };
    const previousRemap = remap;
    remap = (offset) => remapForMove(applied, previousRemap(offset));
  }

  return remap;
}

export function downloadModifiedFiles(data: Data, files: PopulatedFiles) {
  // A root byte lives in the Setup PE32 inside the image, not in any of
  // the four extracted files, so a pending plan can't be honored here and
  // silently dropping it would export something other than what the user
  // asked for.
  if ((data.rootVisibilityEdits?.length ?? 0) > 0) {
    throw new Error(
      "Root visibility changes require the verified full-image reconstruction path and cannot be exported as extracted UEFI files.",
    );
  }

  let wasSetupSctModified = false;
  let wasAmitseSctModified = false;
  let wasSetupdataBinModified = false;

  let changeLog = "";

  const modifiedSetupSct = hexToBytes(files.setupSctContainer.textContent);
  let setupSctChangeLog = "";

  // Retargeting a Ref overwrites its FormId field in place (2 bytes for 2
  // bytes, nothing shifts), so this runs before the SuppressIf loop below,
  // which does shift bytes (moveEndOpcodeToStart). A Ref opcode that
  // happens to sit inside a range about to be deactivated still gets its
  // new FormId carried along correctly by that later copyWithin, since it
  // treats the whole guarded region uniformly - but only if the FormId
  // byte is already the new value before the shift runs, not after.
  for (const form of data.forms) {
    for (const child of form.children) {
      if (child.type !== "Ref") {
        continue;
      }

      const formIdOffset = parseHexId(child.formIdOffset);
      const oldFormId =
        modifiedSetupSct[formIdOffset] |
        (modifiedSetupSct[formIdOffset + 1] << 8);
      const newFormId = parseHexId(child.formId);

      if (newFormId !== oldFormId) {
        modifiedSetupSct[formIdOffset] = newFormId & 0xff;
        modifiedSetupSct[formIdOffset + 1] = (newFormId >> 8) & 0xff;

        const oldFormIdHex = decToHexString(oldFormId);
        const targetFormSetGuid = child.targetFormSetGuid ?? form.formSetGuid;
        const oldTargetIndex = findFormIndexByFormId(
          data.forms,
          oldFormIdHex,
          targetFormSetGuid,
        );
        const newTargetIndex = findFormIndexByFormId(
          data.forms,
          child.formId,
          targetFormSetGuid,
        );
        if (oldTargetIndex < 0 || newTargetIndex < 0) {
          throw new Error(
            "Something went wrong. Please file a bug report on Github.",
          );
        }
        const oldTarget = data.forms[oldTargetIndex];
        const newTarget = data.forms[newTargetIndex];

        setupSctChangeLog += `${child.name || "Ref"} in "${form.name}" | FormId ${oldFormIdHex} (${oldTarget.name}) -> ${child.formId} (${newTarget.name})\n`;

        wasSetupSctModified = true;
      }
    }
  }

  // Moving a Ref to a different Form physically relocates its bytes (see
  // detectRefMoves/applyRefMoves), so this must run after the Ref-retarget
  // loop above (which writes new FormId values at pristine positions -
  // relocating carries those already-correct bytes along) and before the
  // SuppressIf-deactivation loop below (which needs suppressions'
  // start/end already reflecting anything that physically moved, not its
  // stale pristine position).
  const refMoves = detectRefMoves(data, modifiedSetupSct);
  const remapAfterMoves =
    refMoves.length > 0
      ? applyRefMoves(data, modifiedSetupSct, refMoves)
      : (offset: number) => offset;

  for (const move of refMoves) {
    const sourceForm = data.forms[move.sourceFormIndex];
    const destinationForm = data.forms[move.destinationFormIndex];
    setupSctChangeLog += `Moved ${move.ref.name || "Ref"} from "${sourceForm.name}" to "${destinationForm.name}"\n`;
    wasSetupSctModified = true;
  }

  const suppressions = JSON.parse(
    JSON.stringify(data.suppressions),
  ) as Suppression[];

  if (refMoves.length > 0) {
    for (const suppression of suppressions) {
      suppression.offset = decToHexString(
        remapAfterMoves(parseHexId(suppression.offset)),
      );
      suppression.start = decToHexString(
        remapAfterMoves(parseHexId(suppression.start)),
      );
      suppression.end = decToHexString(
        remapAfterMoves(parseHexId(suppression.end)),
      );
    }
  }

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
