import { sameGuidOrBothUndefined, sameHexId } from "../scripts/hexId";
import { refreshSingleFormSetNavigation } from "../scripts/singleFormSetNavigation";
import type {
  AmiSingleFormSetNavigationReport,
  AmiSingleFormSetPage,
  Data,
  Form,
  RefPrompt,
} from "../scripts/types";
import type { MenuTree } from "../Navigation/menuTree";
import { movableNodeForPage } from "./tabPlacement";

// A top-level tab hub can hide/show one of its own direct Refs without a
// generic Move: instead of synthesizing a brand new SuppressIf wrapper (an
// HII resize) it reuses an existing, already-active constant-true SuppressIf
// scope elsewhere in the FormSet as a "parking bin" for the bare Ref opcode.
// Hide moves the Ref into that scope; Show moves it back to the hub. Both are
// fixed-size - see hiddenByTabToggle on RefPrompt and computeRefBlock/
// detectRefMoves in binaryPatcher.ts for how the actual byte relocation
// mirrors the generic Move feature's own machinery.

export type TabVisibilityDirection = "hide" | "show";

export interface TabVisibilityAvailability {
  available: boolean;
  reason: string;
  sourceFormIndex?: number;
  childIndex?: number;
}

interface VisibilityHost {
  formIndex: number;
  suppressionOffset: string;
}

// An existing, reused parking bin for a hidden tab: a constant-true
// SuppressIf scope that already parks at least one Ref (proof it is a real,
// safe-to-share wrapper, not merely constant-true by coincidence), outside
// both the tab's current Form and its own target Form, and not already
// parking a Ref to that same target (two such Refs would make "the"
// suppressed reference for that page ambiguous - see
// collectSuppressedTargets in singleFormSetNavigation.ts). The lowest-offset
// candidate wins, so repeated Hides land deterministically.
function findVisibilityHost(
  data: Data,
  excludedFormIndex: number,
  targetFormId: string,
  targetFormSetGuid: string | undefined,
): VisibilityHost | undefined {
  const excluded = data.forms[excludedFormIndex];

  const seedFormIndexByOffset = new Map<string, number>();
  data.forms.forEach((form, formIndex) => {
    for (const child of form.children) {
      const offset = child.conditions?.[0];
      if (offset !== undefined && !seedFormIndexByOffset.has(offset)) {
        seedFormIndexByOffset.set(offset, formIndex);
      }
    }
  });

  const candidates: VisibilityHost[] = [];
  for (const suppression of data.suppressions) {
    const formIndex = seedFormIndexByOffset.get(suppression.offset);
    if (formIndex === undefined || formIndex === excludedFormIndex) continue;
    if (
      (suppression.kind ?? "SuppressIf") !== "SuppressIf" ||
      !suppression.active ||
      suppression.constant !== true ||
      !sameGuidOrBothUndefined(suppression.formSetGuid, excluded.formSetGuid)
    ) {
      continue;
    }
    const host = data.forms[formIndex];
    if (
      sameHexId(host.formId, targetFormId) &&
      sameGuidOrBothUndefined(host.formSetGuid, targetFormSetGuid)
    ) {
      continue;
    }
    const alreadyParksTarget = host.children.some(
      (child) =>
        child.type === "Ref" &&
        child.hiddenByTabToggle === suppression.offset &&
        sameHexId(child.formId, targetFormId) &&
        sameGuidOrBothUndefined(child.targetFormSetGuid ?? host.formSetGuid, targetFormSetGuid),
    );
    if (alreadyParksTarget) continue;
    candidates.push({ formIndex, suppressionOffset: suppression.offset });
  }
  candidates.sort(
    (left, right) =>
      parseInt(left.suppressionOffset, 16) - parseInt(right.suppressionOffset, 16),
  );

  return candidates.length > 0 ? candidates[0] : undefined;
}

// Whether a page's direct-tab / suppressed-tab Ref can be toggled, and why
// not when it can't - checked against the same node resolution the generic
// Move dialog uses (movableNodeForPage), so a page with no single
// unambiguous Ref stays unavailable here too.
export function analyzeTabVisibilityToggle(
  data: Data,
  tree: MenuTree,
  page: AmiSingleFormSetPage,
  direction: TabVisibilityDirection,
  hubFormIndex: number,
): TabVisibilityAvailability {
  if (hubFormIndex < 0) {
    return { available: false, reason: "The navigation hub could not be resolved." };
  }
  if (direction === "hide" && page.role !== "direct-tab") {
    return { available: false, reason: "Only a current top-level tab can be hidden this way." };
  }
  if (direction === "show" && page.role !== "suppressed-tab") {
    return {
      available: false,
      reason: "Only a tab parked by this toggle can be shown this way.",
    };
  }

  const node = movableNodeForPage(data, tree, page);
  if (node?.sourceFormIndex === undefined || node.refChildIndex === undefined) {
    return {
      available: false,
      reason: "No single, unambiguous IFR Ref identifies this page's placement.",
    };
  }
  const sourceForm = data.forms[node.sourceFormIndex];
  const ref = sourceForm.children[node.refChildIndex];
  if (ref.type !== "Ref") {
    return { available: false, reason: "Something went wrong. Please file a bug report on Github." };
  }
  const located = { sourceFormIndex: node.sourceFormIndex, childIndex: node.refChildIndex };

  if (direction === "hide") {
    if (node.sourceFormIndex !== hubFormIndex) {
      return {
        available: false,
        reason: "This item is not a direct child of the navigation hub.",
        ...located,
      };
    }
    if (ref.conditions !== undefined && ref.conditions.length > 0) {
      return {
        available: false,
        reason: "This tab already carries a hide condition; use Move instead.",
        ...located,
      };
    }
    const host = findVisibilityHost(
      data,
      hubFormIndex,
      ref.formId,
      ref.targetFormSetGuid ?? sourceForm.formSetGuid,
    );
    if (!host) {
      return {
        available: false,
        reason:
          "No existing constant-true SuppressIf scope elsewhere in this FormSet can be reused to park this tab.",
        ...located,
      };
    }
    return {
      available: true,
      reason: `Will park this tab inside the existing SuppressIf scope in "${data.forms[host.formIndex].name || data.forms[host.formIndex].formId}".`,
      ...located,
    };
  }

  if (ref.hiddenByTabToggle === undefined) {
    return {
      available: false,
      reason: "This Ref isn't currently parked by the tab visibility toggle.",
      ...located,
    };
  }
  const hub = data.forms[hubFormIndex];
  const targetFormSetGuid = ref.targetFormSetGuid ?? sourceForm.formSetGuid;
  const duplicate = hub.children.some(
    (child) =>
      child.type === "Ref" &&
      child !== ref &&
      sameHexId(child.formId, ref.formId) &&
      sameGuidOrBothUndefined(child.targetFormSetGuid ?? hub.formSetGuid, targetFormSetGuid),
  );
  if (duplicate) {
    return {
      available: false,
      reason:
        "The navigation hub already has a direct tab pointing at this page; showing this one would duplicate it.",
      ...located,
    };
  }
  return {
    available: true,
    reason: `Will restore this tab to the navigation hub "${hub.name || hub.formId}".`,
    ...located,
  };
}

// Where a shown Ref lands in the hub's own children array: right before the
// current array position of the next page that was a direct tab in the
// SAME relative order the last-known report had, so a Show doesn't always
// append at the end and reshuffle the tab list. Falls back to the end when
// there's no such neighbor (this was the last tab, or the last-known report
// doesn't have it) - see stationaryDestinationAnchor in binaryPatcher.ts for
// the matching byte-level anchor this index feeds into via array position.
function orderPreservingIndex(
  navigation: AmiSingleFormSetNavigationReport,
  hub: Form,
  shownRef: RefPrompt,
): number {
  const pageIndex = navigation.pages.findIndex(
    (page) =>
      page.ifrReferenceOffset !== undefined &&
      sameHexId(page.ifrReferenceOffset, shownRef.sctOffset),
  );
  if (pageIndex < 0) return hub.children.length;
  const nextTab = navigation.pages
    .slice(pageIndex + 1)
    .find((page) => page.role === "direct-tab");
  const nextTabRefOffset = nextTab?.ifrReferenceOffset;
  if (!nextTabRefOffset) return hub.children.length;
  const anchorIndex = hub.children.findIndex(
    (child) => child.type === "Ref" && sameHexId(child.sctOffset, nextTabRefOffset),
  );
  return anchorIndex < 0 ? hub.children.length : anchorIndex;
}

// Applies a Hide or Show toggle to the declarative model in place: Hide
// splices the hub's Ref out and parks it (with hiddenByTabToggle set) at the
// end of an existing reused SuppressIf scope's Form; Show clears that
// marker and splices the Ref back into the hub at an order-preserving
// position. Callers must pass the exact location analyzeTabVisibilityToggle
// resolved - this never re-derives it, so it never silently acts on a
// different Ref than the one the availability check reasoned about.
export function applyTabVisibilityToggle(
  draft: Data,
  hubFormIndex: number,
  sourceFormIndex: number,
  childIndex: number,
  direction: TabVisibilityDirection,
) {
  if (direction === "hide") {
    const hub = draft.forms[hubFormIndex];
    const ref = hub.children[childIndex];
    if (ref.type !== "Ref") {
      throw new Error("Something went wrong. Please file a bug report on Github.");
    }
    const host = findVisibilityHost(
      draft,
      hubFormIndex,
      ref.formId,
      ref.targetFormSetGuid ?? hub.formSetGuid,
    );
    if (!host) {
      throw new Error("Something went wrong. Please file a bug report on Github.");
    }
    hub.children.splice(childIndex, 1);
    ref.conditions = [host.suppressionOffset];
    ref.suppressIf = [host.suppressionOffset];
    ref.hiddenByTabToggle = host.suppressionOffset;
    draft.forms[host.formIndex].children.push(ref);
  } else {
    const source = draft.forms[sourceFormIndex];
    const ref = source.children[childIndex];
    if (ref.type !== "Ref" || ref.hiddenByTabToggle === undefined) {
      throw new Error("Something went wrong. Please file a bug report on Github.");
    }
    const navigation = draft.singleFormSetNavigation;
    const hub = draft.forms[hubFormIndex];
    const insertAt =
      navigation?.status === "detected"
        ? orderPreservingIndex(navigation, hub, ref)
        : hub.children.length;
    source.children.splice(childIndex, 1);
    delete ref.conditions;
    delete ref.suppressIf;
    delete ref.hiddenByTabToggle;
    hub.children.splice(insertAt, 0, ref);
  }
  refreshSingleFormSetNavigation(draft);
}
