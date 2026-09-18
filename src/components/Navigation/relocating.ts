import { parseHexId, sameGuidOrBothUndefined } from "../scripts/hexId";
import {
  packageContaining,
  scanHiiFormsPackages,
  type HiiFormsPackage,
} from "../scripts/hiiPackages";
import { isSoleOwnerOfCondition, movableBlockStart } from "../scripts/refMoving";
import { refreshSingleFormSetNavigation } from "../scripts/singleFormSetNavigation";
import type { Data } from "../scripts/types";
import { resolveRefTarget, wouldCreateCycle, type RefLocation } from "./reparenting";

export type MenuMoveCompatibility =
  | "safe-same-package"
  | "safe-cross-package"
  | "requires-ref3"
  | "unavailable";

export interface MoveDestination {
  formIndex: number;
  compatibility: MenuMoveCompatibility;
  reason: string;
}

const REF_OPCODE = 0x0f;
const END_OPCODE = 0x29;
const REF_MIN_LENGTH = 15;

// Why `location`'s Ref can't be moved anywhere at all, or null when it can.
// Checked against the pristine HII bytes, since a move is only ever a
// fixed-size relocation of exactly the bytes the IFR dump described.
function moveBlocker(
  data: Data,
  location: RefLocation,
  bytes: Uint8Array,
  packages: HiiFormsPackage[],
): string | null {
  const sourceForm = data.forms[location.sourceFormIndex];
  const ref = location.ref;
  if (ref.hiddenByTabToggle !== undefined) {
    return "This item is currently hidden by the top-level tab visibility toggle; use Show to restore it to the navigation hub before moving it elsewhere.";
  }
  if (!isSoleOwnerOfCondition(sourceForm, ref)) {
    return "This item shares its hide condition with other items on this page, so it can't be moved alone: splitting a shared SuppressIf/GrayOutIf/DisableIf would either strand it hiding the wrong content, or drop the condition entirely.";
  }
  const refOffset = parseHexId(ref.sctOffset);
  if (
    refOffset + 2 > bytes.length ||
    bytes[refOffset] !== REF_OPCODE ||
    (bytes[refOffset + 1] & 0x7f) < REF_MIN_LENGTH
  ) {
    return "The source bytes no longer match the decoded IFR Ref span.";
  }
  // A scoped Ref owns nested opcodes up to its own End; moving just its
  // header bytes would tear that scope apart.
  if ((bytes[refOffset + 1] & 0x80) !== 0) {
    return "Only a non-scoped IFR Ref opcode can be moved.";
  }
  if (location.targetFormIndex < 0) {
    return "The selected Ref has a missing target and cannot be moved safely.";
  }
  if (packages.length === 0) {
    return "No valid HII Forms Package was found in the Setup binary stream.";
  }
  if (!packageContaining(packages, movableBlockStart(data, sourceForm, ref))) {
    return "The source or destination Forms Package could not be proven.";
  }
  return null;
}

// Every Form as a candidate destination for `location`'s Ref, each with a
// verdict and the reason behind it. Only the graph shape (cycles,
// duplicates) and the pristine byte layout (packages, End opcodes, Ref
// variant) decide: the move itself never touches the Ref's own bytes beyond
// relocating them, so a Ref can only cross into another FormSet when it
// already names its target's FormSet explicitly (REF3/REF4), and crossing
// Forms Packages just means both package lengths get rebalanced at export.
export function analyzeMoveDestinations(
  data: Data,
  location: RefLocation,
  bytes: Uint8Array,
): MoveDestination[] {
  const packages = scanHiiFormsPackages(bytes);
  const blocker = moveBlocker(data, location, bytes, packages);
  if (blocker !== null) {
    return data.forms.map((_, formIndex) => ({
      formIndex,
      compatibility: "unavailable",
      reason: blocker,
    }));
  }

  const sourceForm = data.forms[location.sourceFormIndex];
  const sourcePackage = packageContaining(
    packages,
    movableBlockStart(data, sourceForm, location.ref),
  );

  return data.forms.map((destinationForm, formIndex): MoveDestination => {
    const unavailable = (reason: string): MoveDestination => ({
      formIndex,
      compatibility: "unavailable",
      reason,
    });
    if (formIndex === location.sourceFormIndex) {
      return unavailable("The Ref is already in this Form.");
    }
    if (wouldCreateCycle(data, { sourceFormIndex: formIndex }, location.targetFormIndex)) {
      return unavailable("Moving this Ref there would create a cycle in the HII menu graph.");
    }
    const duplicate = destinationForm.children.some(
      (child) =>
        child.type === "Ref" &&
        resolveRefTarget(data, formIndex, child) === location.targetFormIndex,
    );
    if (duplicate) {
      return unavailable("The destination Form already contains a Ref to the same target.");
    }
    const destinationEnd = parseHexId(destinationForm.endOffset);
    if (
      destinationEnd + 2 > bytes.length ||
      bytes[destinationEnd] !== END_OPCODE ||
      (bytes[destinationEnd + 1] & 0x7f) !== 2
    ) {
      return unavailable("The destination Form End opcode no longer matches the binary model.");
    }
    const destinationPackage = packageContaining(packages, destinationEnd);
    if (!sourcePackage || !destinationPackage) {
      return unavailable("The source or destination Forms Package could not be proven.");
    }
    if (
      !sameGuidOrBothUndefined(sourceForm.formSetGuid, destinationForm.formSetGuid) &&
      location.ref.targetFormSetGuid === undefined
    ) {
      return {
        formIndex,
        compatibility: "requires-ref3",
        reason: "This REF/REF2 needs conversion to REF3 before it can cross FormSets.",
      };
    }
    if (sourcePackage === destinationPackage) {
      return {
        formIndex,
        compatibility: "safe-same-package",
        reason: "Safe fixed-size move inside the existing Forms Package.",
      };
    }
    if (
      (sourcePackage.packageListOffset === null) !==
      (destinationPackage.packageListOffset === null)
    ) {
      return unavailable("The Forms Packages have incompatible container provenance.");
    }
    return {
      formIndex,
      compatibility: "safe-cross-package",
      reason: "Safe fixed-size move; Forms Package lengths will be rebalanced.",
    };
  });
}

// Mutates an Immer draft: moves location's Ref out of its source Form's
// children and appends it to the destination Form's. The Ref's own fields
// (including its target FormId) are untouched - only which Form lists it
// changes. The physical byte relocation happens later, at download time
// (see detectRefMoves/applyRefMoves in binaryPatcher.ts), by comparing each
// Ref's current Form against where it pristinely lived.
export function applyMoveToDraft(
  draft: Data,
  sourceFormIndex: number,
  childIndex: number,
  destinationFormIndex: number,
) {
  const [moved] = draft.forms[sourceFormIndex].children.splice(childIndex, 1);
  draft.forms[destinationFormIndex].children.push(moved);
  // In a single-FormSet hub layout the tab inventory is the graph itself.
  refreshSingleFormSetNavigation(draft);
}
