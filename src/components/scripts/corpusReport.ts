import { buildMenuTree } from "../Navigation/menuTree";
import { analyzeTabVisibilityToggle } from "../FormUi/tabVisibility";
import { sameHexId } from "./hexId";
import type { AmiSingleFormSetPage, Data } from "./types";

// A structured, per-image summary of what this editor concluded about one
// firmware sample: how much of it parsed, which navigation/visibility
// mechanism was detected and how confidently, and - for every page the
// single-FormSet tab inventory found - whether Hide/Show is available and
// exactly why not when it isn't. This is the shape a corpus regression
// runner (see corpusRunner.node.test.ts) writes one of per image, so a
// change to classification or edit-availability logic shows up as a diff
// in these reports across the whole local corpus, not just in whichever
// sample happens to have a unit test.

export interface CorpusTabOperation {
  name: string;
  formId: string;
  role: AmiSingleFormSetPage["role"];
  registeredInAmitse: boolean;
  hide: { available: boolean; reason: string };
  show: { available: boolean; reason: string };
}

export interface CorpusReport {
  label: string;
  firmwareFamily: Data["firmwareFamily"];
  counts: {
    formSets: number;
    forms: number;
    refs: number;
    conditions: number;
  };
  navigation: {
    status: string;
    mechanism?: string;
    confidence?: string;
    hubName?: string;
    directTabs: number;
    suppressedTabs: number;
    descendants: number;
    registeredOnly: number;
    reason?: string;
  };
  rootVisibility?: {
    status: string;
    mechanism: string;
    confidence: string;
    entries: number;
    reason: string;
  };
  tabOperations: CorpusTabOperation[];
}

function countRefs(data: Data) {
  return data.forms.reduce(
    (total, form) => total + form.children.filter((child) => child.type === "Ref").length,
    0,
  );
}

function countFormSets(data: Data) {
  const guids = new Set(
    data.forms
      .map((form) => form.formSetGuid)
      .filter((guid): guid is string => guid !== undefined),
  );
  return guids.size;
}

// Every Hide/Show verdict the tab inventory's pages can produce, with its
// exact reason - the same calls FormUi.tsx makes to decide what to show the
// user, run here read-only against every page instead of just the one the
// user happens to be looking at.
function buildTabOperations(data: Data): CorpusTabOperation[] {
  const nav = data.singleFormSetNavigation;
  if (nav?.status !== "detected" || nav.hubFormId === undefined) {
    return [];
  }
  const hubFormIndex = data.forms.findIndex(
    (form) =>
      sameHexId(form.formId, nav.hubFormId ?? "") && form.formSetGuid === nav.formSetGuid,
  );
  if (hubFormIndex < 0) {
    return [];
  }
  const tree = buildMenuTree(data);
  return nav.pages.map((page) => {
    const hide = analyzeTabVisibilityToggle(data, tree, page, "hide", hubFormIndex);
    const show = analyzeTabVisibilityToggle(data, tree, page, "show", hubFormIndex);
    return {
      name: page.name,
      formId: page.formId,
      role: page.role,
      registeredInAmitse: page.registeredInAmitse,
      hide: { available: hide.available, reason: hide.reason },
      show: { available: show.available, reason: show.reason },
    };
  });
}

export function buildCorpusReport(data: Data, label: string): CorpusReport {
  const nav = data.singleFormSetNavigation;
  const rootVisibility = data.rootVisibility;

  return {
    label,
    firmwareFamily: data.firmwareFamily,
    counts: {
      formSets: countFormSets(data),
      forms: data.forms.length,
      refs: countRefs(data),
      conditions: data.suppressions.length,
    },
    navigation: {
      status: nav?.status ?? "not-applicable",
      mechanism: nav?.mechanism,
      confidence: nav?.confidence,
      hubName: nav?.hubName,
      directTabs: nav?.pages.filter((page) => page.role === "direct-tab").length ?? 0,
      suppressedTabs: nav?.pages.filter((page) => page.role === "suppressed-tab").length ?? 0,
      descendants: nav?.pages.filter((page) => page.role === "descendant").length ?? 0,
      registeredOnly: nav?.pages.filter((page) => page.role === "registered-only").length ?? 0,
      reason: nav?.reason,
    },
    rootVisibility: rootVisibility
      ? {
          status: rootVisibility.status,
          mechanism: rootVisibility.mechanism,
          confidence: rootVisibility.confidence,
          entries: rootVisibility.entries.length,
          reason: rootVisibility.reason,
        }
      : undefined,
    tabOperations: buildTabOperations(data),
  };
}

// Two independent, mutually-applicable navigation mechanisms exist: the
// single-FormSet IFR hub (report.navigation) and the multi-FormSet AMITSE
// root vector (report.rootVisibility). Most older Aptio IV reference
// boards only ever use the second one, so report.navigation.status
// correctly reads "not-applicable" there - that must not be read as
// "navigation unresolved" by anything deciding whether an image was
// successfully classified (see CorpusRunner.tsx's own recognized/partial
// status and its "Navigation" rate, both of which use this).
export function reportNavigationDetected(report: CorpusReport | undefined) {
  return (
    report?.navigation.status === "detected" ||
    report?.rootVisibility?.status === "detected"
  );
}

// A one-line-per-image console table, so a whole corpus run's shape is
// readable without opening every individual JSON report.
export function summarizeCorpusReports(reports: CorpusReport[]): string {
  const header = "label | family | forms | refs | nav status | direct/suppressed tabs | hide blocked | show blocked";
  const rows = reports.map((report) => {
    const hideBlocked = report.tabOperations.filter((op) => !op.hide.available && op.role === "direct-tab").length;
    const showBlocked = report.tabOperations.filter((op) => !op.show.available && op.role === "suppressed-tab").length;
    return [
      report.label,
      report.firmwareFamily,
      String(report.counts.forms),
      String(report.counts.refs),
      report.navigation.status,
      `${String(report.navigation.directTabs)}/${String(report.navigation.suppressedTabs)}`,
      String(hideBlocked),
      String(showBlocked),
    ].join(" | ");
  });
  return [header, ...rows].join("\n");
}
