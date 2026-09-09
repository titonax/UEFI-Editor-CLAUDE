import { sameGuidOrBothUndefined } from "../scripts/hexId";
import { isSoleOwnerOfCondition } from "../scripts/refMoving";
import type { Data } from "../scripts/types";
import { resolveRefTarget, wouldCreateCycle, type RefLocation } from "./reparenting";

// Whether this Ref can be moved to a *different* Form at all, independent
// of which one. The only thing that ever blocks a move outright (as
// opposed to blocking one particular destination) is sharing its hide
// condition with sibling children - see isSoleOwnerOfCondition for why
// that can't be split apart without inserting opcodes.
export function canRefBeMoved(data: Data, location: RefLocation) {
  const sourceForm = data.forms[location.sourceFormIndex];
  if (!isSoleOwnerOfCondition(sourceForm, location.ref)) {
    return {
      allowed: false,
      explanation:
        "This item shares its hide condition with other items on this page, so it can't be moved alone: splitting a shared SuppressIf/GrayOutIf/DisableIf would either strand it hiding the wrong content, or drop the condition entirely.",
    } as const;
  }
  return { allowed: true } as const;
}

export type MoveDestinationReason =
  | "same-parent"
  | "would-create-cycle"
  | "duplicate-target"
  | "target-not-found";

export interface MoveDestinationResult {
  allowed: boolean;
  reason?: MoveDestinationReason;
}

// Whether `location`'s Ref could move into `destinationFormIndex`'s
// children. Unlike retargeting (reparenting.ts), the Ref's own target
// never changes here - only which Form lists it - so the cycle check is
// "would the destination become able to reach back to the Ref's existing
// target", and there's an extra check retargeting doesn't need: the
// destination Form might already have its own Ref to that same target.
export function evaluateMoveDestination(
  data: Data,
  location: RefLocation,
  destinationFormIndex: number,
): MoveDestinationResult {
  if (destinationFormIndex < 0 || destinationFormIndex >= data.forms.length) {
    return { allowed: false, reason: "target-not-found" };
  }
  if (destinationFormIndex === location.sourceFormIndex) {
    return { allowed: false, reason: "same-parent" };
  }
  if (
    location.targetFormIndex >= 0 &&
    wouldCreateCycle(
      data,
      { sourceFormIndex: destinationFormIndex },
      location.targetFormIndex,
    )
  ) {
    return { allowed: false, reason: "would-create-cycle" };
  }
  const destinationForm = data.forms[destinationFormIndex];
  const duplicate = destinationForm.children.some(
    (child) =>
      child.type === "Ref" &&
      resolveRefTarget(data, destinationFormIndex, child) ===
        location.targetFormIndex,
  );
  if (duplicate) {
    return { allowed: false, reason: "duplicate-target" };
  }
  return { allowed: true };
}

export interface MoveDestination {
  formIndex: number;
  name: string;
  formId: string;
  result: MoveDestinationResult;
}

// Every Form this Ref could be moved into, restricted to the FormSet it can
// actually reach - a move never touches the Ref's own bytes beyond
// relocating them, so (same as retargeting) it can't cross into a FormSet
// the Ref's own opcode variant has no way to name.
export function listMoveDestinations(
  data: Data,
  location: RefLocation,
): MoveDestination[] {
  const sourceForm = data.forms[location.sourceFormIndex];
  const scopeGuid = location.ref.targetFormSetGuid ?? sourceForm.formSetGuid;

  return data.forms
    .map((form, formIndex) => ({ form, formIndex }))
    .filter(({ form }) => sameGuidOrBothUndefined(form.formSetGuid, scopeGuid))
    .map(({ form, formIndex }) => ({
      formIndex,
      name: form.name || form.formId,
      formId: form.formId,
      result: evaluateMoveDestination(data, location, formIndex),
    }));
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
}
