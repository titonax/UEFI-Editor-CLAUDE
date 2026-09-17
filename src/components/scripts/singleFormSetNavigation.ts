import { normalizedHexId, sameGuidOrBothUndefined, sameHexId } from "./hexId";
import type {
  AmiSingleFormSetNavigationReport,
  AmiSingleFormSetPage,
  AmiSingleFormSetPageRole,
  Data,
  Form,
  Forms,
  Menu,
  RefPrompt,
} from "./types";

// Some later AMI Setup layouts keep every navigation page inside one HII
// FormSet and never use the per-FormSet root byte vector. There the FormSet
// entry Form is a navigation hub whose direct IFR Refs, in opcode order,
// are the current top-level tabs. Three things stay separate on purpose:
// a page registered in the AMITSE table, a Form reachable in the IFR graph,
// and a direct child of the hub. Only the last one makes a page a tab;
// registration corroborates but never promotes.

function formKey(formId: string, formSetGuid: string) {
  return `${formSetGuid.toLowerCase()}:${normalizedHexId(formId)}`;
}

function refsOf(form: Form): RefPrompt[] {
  return form.children.filter((child): child is RefPrompt => child.type === "Ref");
}

function formsMatching(forms: Forms, formId: string, formSetGuid: string) {
  return forms.filter(
    (form) =>
      sameGuidOrBothUndefined(form.formSetGuid, formSetGuid) &&
      sameHexId(form.formId, formId),
  );
}

// A Ref stays inside the FormSet unless it explicitly names another one.
function staysInFormSet(ref: RefPrompt, owner: Form, formSetGuid: string) {
  return sameGuidOrBothUndefined(ref.targetFormSetGuid ?? owner.formSetGuid, formSetGuid);
}

interface Registration {
  name: string;
  formId: string;
  offsets: string[];
}

// AMITSE registrations collapsed by page identity, keeping every offset the
// page was found at (real tables repeat entries).
function collectRegistrations(registrations: Menu, formSetGuid: string) {
  const byKey = new Map<string, Registration>();
  for (const entry of registrations) {
    if (
      entry.offset === null ||
      !sameGuidOrBothUndefined(entry.formSetGuid, formSetGuid)
    ) {
      continue;
    }
    const key = formKey(entry.formId, formSetGuid);
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.offsets.includes(entry.offset)) existing.offsets.push(entry.offset);
    } else {
      byKey.set(key, { name: entry.name, formId: entry.formId, offsets: [entry.offset] });
    }
  }
  return byKey;
}

// Which Forms (by FormId) hold a Ref to each Form of the FormSet.
function collectParents(forms: Forms, formSetGuid: string) {
  const parents = new Map<string, string[]>();
  for (const owner of forms) {
    if (!sameGuidOrBothUndefined(owner.formSetGuid, formSetGuid)) continue;
    for (const ref of refsOf(owner)) {
      if (!staysInFormSet(ref, owner, formSetGuid)) continue;
      const key = formKey(ref.formId, formSetGuid);
      const known = parents.get(key) ?? [];
      if (!known.includes(owner.formId)) known.push(owner.formId);
      parents.set(key, known);
    }
  }
  return parents;
}

// Every Form the hub reaches through unambiguous same-FormSet Refs.
function collectReachable(forms: Forms, hub: Form, formSetGuid: string) {
  const reachable = new Set<string>();
  const queue = [hub];
  for (let owner = queue.shift(); owner; owner = queue.shift()) {
    const key = formKey(owner.formId, formSetGuid);
    if (reachable.has(key)) continue;
    reachable.add(key);
    for (const ref of refsOf(owner)) {
      if (!staysInFormSet(ref, owner, formSetGuid)) continue;
      const targets = formsMatching(forms, ref.formId, formSetGuid);
      if (targets.length === 1) queue.push(targets[0]);
    }
  }
  return reachable;
}

function undetected(
  status: Exclude<AmiSingleFormSetNavigationReport["status"], "detected">,
  reason: string,
  formSetGuid?: string,
): AmiSingleFormSetNavigationReport {
  return {
    status,
    mechanism: "single-formset-ifr-hub",
    confidence: "unresolved",
    reason,
    formSetGuid,
    pages: [],
  };
}

// Classifies a single-FormSet HII around its entry Form. `knownHubFormId`
// re-runs the classification for a hub already proven on parse (after a
// move or a data.json import), where fewer than two direct tabs is a valid
// pending state rather than a reason to doubt the layout.
export function inspectSingleFormSetNavigation(
  formSetRoots: Menu,
  forms: Forms,
  amitseRegistrations: Menu,
  knownHubFormId?: string,
): AmiSingleFormSetNavigationReport {
  const root = formSetRoots.length === 1 ? formSetRoots[0] : undefined;
  if (!root?.formSetGuid) {
    return undetected(
      "not-applicable",
      "This detector applies only when the extracted HII contains one unambiguous FormSet entry.",
    );
  }
  const formSetGuid = root.formSetGuid;
  const hubCandidates = formsMatching(forms, knownHubFormId ?? root.formId, formSetGuid);
  if (hubCandidates.length !== 1) {
    return hubCandidates.length > 1
      ? undetected(
          "ambiguous",
          "The FormSet entry FormId resolves to more than one parsed Form.",
          formSetGuid,
        )
      : undetected(
          "unresolved",
          "The FormSet entry Form could not be resolved in the IFR graph.",
          formSetGuid,
        );
  }
  const hub = hubCandidates[0];

  const directRefs = refsOf(hub).filter((ref) => staysInFormSet(ref, hub, formSetGuid));
  if (knownHubFormId === undefined && directRefs.length < 2) {
    return undetected(
      "unresolved",
      "The single FormSet entry does not expose a multi-page direct Ref fan-out, so it is not classified as a tab hub.",
      formSetGuid,
    );
  }
  const directTargets = directRefs.map((ref) => ({
    ref,
    targets: formsMatching(forms, ref.formId, formSetGuid),
  }));
  const invalid = directTargets.find(({ targets }) => targets.length !== 1);
  if (invalid) {
    return undetected(
      "ambiguous",
      invalid.targets.length === 0
        ? `Direct hub Ref ${invalid.ref.formId} has no target Form.`
        : `Direct hub Ref ${invalid.ref.formId} has multiple target Forms.`,
      formSetGuid,
    );
  }
  const directKeys = directTargets.map(({ targets }) => formKey(targets[0].formId, formSetGuid));
  if (new Set(directKeys).size !== directKeys.length) {
    return undetected(
      "ambiguous",
      "The FormSet entry contains duplicate direct Refs to the same Form, so tab identity is ambiguous.",
      formSetGuid,
    );
  }

  const registrations = collectRegistrations(amitseRegistrations, formSetGuid);
  const parents = collectParents(forms, formSetGuid);
  const reachable = collectReachable(forms, hub, formSetGuid);
  const pages: AmiSingleFormSetPage[] = [];
  const addPage = (
    form: Form,
    role: AmiSingleFormSetPageRole,
    displayName: string,
    ifrReferenceOffset?: string,
  ) => {
    const key = formKey(form.formId, formSetGuid);
    const registration = registrations.get(key);
    pages.push({
      name: displayName || form.name || `Form ${form.formId}`,
      formId: form.formId,
      formSetGuid,
      role,
      registeredInAmitse: registration !== undefined,
      registrationOffsets: registration?.offsets ?? [],
      ifrReferenceOffset,
      parentFormIds: parents.get(key) ?? [],
    });
  };

  addPage(hub, "hub", hub.name || root.name);
  for (const { ref, targets } of directTargets) {
    addPage(targets[0], "direct-tab", ref.name || targets[0].name, ref.sctOffset);
  }
  const represented = new Set(pages.map((page) => formKey(page.formId, formSetGuid)));
  for (const [key, registration] of registrations) {
    if (represented.has(key)) continue;
    const targets = formsMatching(forms, registration.formId, formSetGuid);
    if (targets.length !== 1) continue;
    addPage(
      targets[0],
      reachable.has(key) ? "descendant" : "registered-only",
      registration.name || targets[0].name,
    );
  }

  const tabs = pages.filter((page) => page.role === "direct-tab");
  const corroboratedTabs = tabs.filter((page) => page.registeredInAmitse).length;
  const registeredNonTabs = pages.filter(
    (page) => page.registeredInAmitse && page.role !== "direct-tab",
  ).length;
  return {
    status: "detected",
    mechanism: "single-formset-ifr-hub",
    confidence:
      tabs.length > 0 && corroboratedTabs === tabs.length ? "corroborated" : "ifr-only",
    reason: `The FormSet entry ${hub.name || hub.formId} (${hub.formId}) is the IFR navigation hub: ${String(tabs.length)} direct Ref${tabs.length === 1 ? "" : "s"} define the current top-level tabs. AMITSE corroborates ${String(corroboratedTabs)} of them and contains ${String(registeredNonTabs)} registered non-tab page${registeredNonTabs === 1 ? "" : "s"}; registration alone is not treated as tab visibility.`,
    formSetGuid,
    hubFormId: hub.formId,
    hubName: hub.name || root.name,
    pages,
  };
}

// The one menu root a detected hub layout has: the hub itself, whose tree
// children are the tabs.
export function singleFormSetHubMenu(report: AmiSingleFormSetNavigationReport): Menu {
  if (report.status !== "detected" || !report.formSetGuid || !report.hubFormId) {
    return [];
  }
  return [
    {
      name: report.hubName ?? `Form ${report.hubFormId}`,
      formId: report.hubFormId,
      offset: null,
      formSetGuid: report.formSetGuid,
      source: "ifr-hub",
    },
  ];
}

// The AMITSE evidence a report carries, in the shape the detector consumes.
function registrationsFromReport(report: AmiSingleFormSetNavigationReport): Menu {
  return report.pages.flatMap((page) =>
    page.registrationOffsets.map((offset) => ({
      name: page.name,
      formId: page.formId,
      offset,
      formSetGuid: page.formSetGuid,
      source: "amitse" as const,
    })),
  );
}

// Rebuilds the tab inventory from the current IFR graph, keeping the
// AMITSE evidence of `evidence` (the report of the firmware that is open).
// Called after every Ref move and after a data.json import; a hub layout
// also keeps the hub as the only menu root.
export function refreshSingleFormSetNavigation(
  data: Data,
  evidence: AmiSingleFormSetNavigationReport | undefined = data.singleFormSetNavigation,
) {
  if (!evidence || evidence.status === "not-applicable") return;
  const formSetRoots: Menu =
    data.formSetRoots ??
    (evidence.formSetGuid && evidence.hubFormId
      ? [
          {
            name: evidence.hubName ?? "Setup",
            formId: evidence.hubFormId,
            offset: null,
            formSetGuid: evidence.formSetGuid,
            source: "formset",
          },
        ]
      : []);
  const report = inspectSingleFormSetNavigation(
    formSetRoots,
    data.forms,
    registrationsFromReport(evidence),
    evidence.status === "detected" ? evidence.hubFormId : undefined,
  );
  data.singleFormSetNavigation = report;
  const menu = singleFormSetHubMenu(report);
  if (menu.length > 0) data.menu = menu;
}
