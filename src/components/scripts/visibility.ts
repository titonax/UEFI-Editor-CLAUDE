import type {
  ConditionSource,
  Data,
  FormChildren,
  Suppression,
  VisibilityStatus,
} from "./types";

export interface VisibilityInfo {
  status: VisibilityStatus;
  gate: "none" | "suppression" | "availability";
  label: string;
  explanation: string;
  conditions: Suppression[];
  hardwareDependent: boolean;
  accessDependent: boolean;
  uiStateDependent: boolean;
}

export type VisibilityCounts = Record<VisibilityStatus, number>;

export interface FormBranchVisibility {
  direct: VisibilityCounts;
  branch: VisibilityCounts;
  directSources: ConditionSourceCounts;
  branchSources: ConditionSourceCounts;
  descendantForms: number;
}

export type ConditionSourceCounts = Record<ConditionSource, number>;

const labels: Record<VisibilityStatus, string> = {
  visible: "No visibility gate",
  hidden: "Hiding gate",
  conditional: "Availability gate",
  unknown: "Unknown",
  orphaned: "Detached",
  broken: "Broken reference",
};

export function visibilityLabel(status: VisibilityStatus) {
  return labels[status];
}

export function conditionsForChild(data: Data, child: FormChildren) {
  return (child.conditions ?? child.suppressIf ?? [])
    .map((offset) =>
      data.suppressions.find((condition) => condition.offset === offset),
    )
    .filter((condition): condition is Suppression => condition !== undefined);
}

export function childVisibility(
  data: Data,
  child: FormChildren,
): VisibilityInfo {
  const conditions = conditionsForChild(data, child).filter(
    (condition) => condition.active,
  );
  const effectiveConditions = conditions.filter(
    (condition) => condition.constant !== false,
  );
  const suppressions = effectiveConditions.filter(
    (condition) => (condition.kind ?? "SuppressIf") === "SuppressIf",
  );
  const hardwareDependent = effectiveConditions.some(
    (condition) => condition.source === "hardware",
  );
  const accessDependent = effectiveConditions.some(
    (condition) => condition.source === "access",
  );
  const uiStateDependent = effectiveConditions.some(
    (condition) => condition.source === "ui",
  );

  if (suppressions.length > 0) {
    const alwaysHidden = suppressions.some(
      (condition) => condition.constant === true,
    );
    return {
      status: "hidden",
      gate: "suppression",
      label: alwaysHidden ? "Always hidden" : "Hidden when true",
      explanation: alwaysHidden
        ? "The IFR contains an always-true SuppressIf gate, so this item is hidden."
        : "SuppressIf is a real HII hiding gate. The item is hidden whenever the displayed expression evaluates to true; its current runtime value is not stored in the firmware image.",
      conditions,
      hardwareDependent,
      accessDependent,
      uiStateDependent,
    };
  }

  const availabilityConditions = effectiveConditions.filter((condition) => {
    const kind = condition.kind ?? "SuppressIf";
    return kind === "GrayOutIf" || kind === "DisableIf";
  });

  if (availabilityConditions.length > 0) {
    return {
      status: "conditional",
      gate: "availability",
      label: "Disabled / gray when true",
      explanation:
        "GrayOutIf or DisableIf keeps the item in the HII structure but makes it unavailable whenever the displayed expression evaluates to true.",
      conditions,
      hardwareDependent,
      accessDependent,
      uiStateDependent,
    };
  }

  return {
    status: "visible",
    gate: "none",
    label: labels.visible,
    explanation:
      child.accessLevel === null
        ? "No active SuppressIf, GrayOutIf, or DisableIf gate affects this item."
        : `No active IFR condition is known. AMI SetupData AccessLevel is 0x${child.accessLevel}; that policy byte is reported separately and is not treated as proof of live visibility.`,
    conditions,
    hardwareDependent: false,
    accessDependent: false,
    uiStateDependent: false,
  };
}

export function combineVisibility(
  parent: VisibilityStatus,
  child: VisibilityStatus,
): VisibilityStatus {
  const parentGate =
    parent === "hidden" || parent === "conditional" ? parent : "visible";
  const childGate =
    child === "hidden" || child === "conditional" ? child : "visible";

  if (parentGate === "hidden" || childGate === "hidden") {
    return "hidden";
  }

  if (parentGate === "conditional" || childGate === "conditional") {
    return "conditional";
  }

  return "visible";
}

function emptyCounts(): VisibilityCounts {
  return {
    visible: 0,
    hidden: 0,
    conditional: 0,
    unknown: 0,
    orphaned: 0,
    broken: 0,
  };
}

function emptySourceCounts(): ConditionSourceCounts {
  return {
    setup: 0,
    hardware: 0,
    access: 0,
    ui: 0,
    runtime: 0,
    constant: 0,
    unknown: 0,
  };
}

function normalizedFormId(formId: string) {
  const parsed = parseInt(formId);
  return Number.isNaN(parsed) ? formId : String(parsed);
}

function findReferencedForm(
  data: Data,
  formId: string,
  formSetGuid?: string,
) {
  const normalized = normalizedFormId(formId);
  const inFormSet = data.forms.findIndex(
    (form) =>
      (form.formSetGuid ?? "").toLowerCase() ===
        (formSetGuid ?? "").toLowerCase() &&
      normalizedFormId(form.formId) === normalized,
  );

  return inFormSet >= 0
    ? inFormSet
    : data.forms.findIndex(
        (form) => normalizedFormId(form.formId) === normalized,
      );
}

export function summarizeFormBranch(
  data: Data,
  rootFormIndex: number,
  inheritedStatus: VisibilityStatus = "visible",
): FormBranchVisibility {
  const direct = emptyCounts();
  const branch = emptyCounts();
  const directSources = emptySourceCounts();
  const branchSources = emptySourceCounts();
  const descendantForms = new Set<number>();

  function visit(
    formIndex: number,
    inheritedStatus: VisibilityStatus,
    ancestors: Set<number>,
    depth: number,
  ) {
    const form = data.forms[formIndex];

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(formIndex);

    for (const child of form.children) {
      const visibility = childVisibility(data, child);
      let status = combineVisibility(
        inheritedStatus,
        visibility.status,
      );
      let targetIndex = -1;

      if (child.type === "Ref") {
        targetIndex = findReferencedForm(
          data,
          child.formId,
          child.targetFormSetGuid ?? form.formSetGuid,
        );
        if (targetIndex < 0) {
          status = "broken";
        }
      }

      branch[status]++;
      const sources = new Set(
        visibility.conditions
          .filter(
            (condition) => condition.active && condition.constant !== false,
          )
          .map((condition) => condition.source ?? "unknown"),
      );
      for (const source of sources) {
        branchSources[source]++;
      }
      if (depth === 0) {
        direct[status]++;
        for (const source of sources) {
          directSources[source]++;
        }
      }

      if (
        child.type === "Ref" &&
        targetIndex >= 0 &&
        !nextAncestors.has(targetIndex)
      ) {
        descendantForms.add(targetIndex);
        visit(targetIndex, status, nextAncestors, depth + 1);
      }
    }
  }

  visit(rootFormIndex, inheritedStatus, new Set(), 0);
  descendantForms.delete(rootFormIndex);

  return {
    direct,
    branch,
    directSources,
    branchSources,
    descendantForms: descendantForms.size,
  };
}
