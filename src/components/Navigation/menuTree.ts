import type { Data, VisibilityStatus } from "../scripts/types";
import { findFormIndexByFormId, normalizedHexId } from "../scripts/hexId";
import {
  childVisibility,
  combineVisibility,
  visibilityLabel,
} from "../scripts/visibility";

export type ReachabilityStatus =
  | "root"
  | "reachable"
  | "detached"
  | "broken";

export type RootSource =
  | "amitse"
  | "setupdata"
  | "hii-formset"
  | "inferred";

export interface MenuProfile {
  id: string;
  label: string;
  assessment: "probable-live" | "probable-fallback" | "unresolved";
  confidence: "high" | "medium" | "low";
  evidence: string[];
  roots: MenuTreeNode[];
}

export interface MenuTreeNode {
  key: string;
  label: string;
  formName: string;
  formId: string;
  formIndex: number | null;
  children: MenuTreeNode[];
  cycle?: boolean;
  missing?: boolean;
  status: VisibilityStatus;
  statusLabel: string;
  reachability: ReachabilityStatus;
  reachabilityLabel: string;
  rootSource?: RootSource;
  hardwareDependent: boolean;
  accessDependent: boolean;
  uiStateDependent: boolean;
  pageMask?: string;
  profileId?: string;
  profileLabel?: string;
  profileAssessment?: MenuProfile["assessment"];
  incomingReferenceCount: number;
  outgoingReferenceCount: number;
  parentageLabel: string;
  conditionSummary?: string;
  // Identifies the exact Ref opcode this node was reached through - the
  // parent Form's index and which of its children the Ref is - so a "move"
  // action on this row can retarget that specific opcode (see
  // reparenting.ts's buildRefLocation) without re-searching for it. Absent
  // for root nodes (AMITSE/SetupData menu entries, edited via RootsTable
  // instead) since those aren't a Ref at all.
  sourceFormIndex?: number;
  refChildIndex?: number;
}

export interface MenuTree {
  roots: MenuTreeNode[];
  profiles: MenuProfile[];
  orphans: MenuTreeNode[];
  expandableKeys: string[];
  firstKeyByFormIndex: Map<number, string>;
  signature: string;
  truncated: boolean;
}

function conditionDescriptions(
  visibility: ReturnType<typeof childVisibility>,
) {
  return visibility.conditions
    .filter((condition) => condition.active && condition.constant !== false)
    .map((condition) => {
      const kind = condition.kind ?? "SuppressIf";
      return `${kind}: ${condition.expression ?? `condition at ${condition.offset}`}`;
    });
}

function inheritedStatusLabel(
  status: VisibilityStatus,
  directStatus: VisibilityStatus,
  directLabel: string,
) {
  if (status === directStatus) {
    return directLabel;
  }

  if (status === "hidden") {
    return "Hidden by parent gate";
  }

  if (status === "conditional") {
    return "Unavailable by parent gate";
  }

  return visibilityLabel(status);
}

function canonicalMenuRole(label: string) {
  const normalized = label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (normalized.includes("advanced")) return "advanced";
  if (normalized.includes("security")) return "security";
  if (normalized.includes("boot")) return "boot";
  if (normalized.includes("chipset")) return "chipset";
  if (normalized.includes("sysinfo") || normalized.includes("system info")) {
    return "sysinfo";
  }
  if (normalized.includes("main")) return "main";
  if (normalized.includes("exit")) return "exit";
  return normalized;
}

// A group needs at least this many roots before a repeated major tab
// (Advanced/Security/Boot) is treated as evidence of a *second* profile
// restarting, rather than just an early, coincidental repeat within the
// same menu (e.g. a single "Advanced" appearing twice).
const MIN_ROOTS_BEFORE_SEQUENCE_RESTART = 3;

function inferMenuProfiles(roots: MenuTreeNode[]): MenuProfile[] {
  if (roots.length === 0) {
    return [];
  }

  const groups: MenuTreeNode[][] = [];
  let current: MenuTreeNode[] = [];
  let seenRoles = new Set<string>();
  let previousRole = "";

  for (const root of roots) {
    const role = canonicalMenuRole(root.label);
    const startsAfterExit =
      previousRole === "exit" && (role === "main" || role === "sysinfo");
    const restartsKnownSequence =
      current.length >= MIN_ROOTS_BEFORE_SEQUENCE_RESTART &&
      seenRoles.has(role) &&
      ["advanced", "security", "boot"].includes(role);
    if (current.length > 0 && (startsAfterExit || restartsKnownSequence)) {
      groups.push(current);
      current = [];
      seenRoles = new Set<string>();
    }
    current.push(root);
    seenRoles.add(role);
    previousRole = role;
  }
  groups.push(current);

  const hasGenericGroup = groups.some((group) => {
    const roles = new Set(group.map((root) => canonicalMenuRole(root.label)));
    return roles.has("main") && roles.has("chipset") && roles.has("exit");
  });
  const hasSetupDataEvidence = roots.every(
    (root) => root.rootSource === "setupdata" && root.pageMask !== undefined,
  );

  return groups.map((group, index) => {
    const roles = new Set(group.map((root) => canonicalMenuRole(root.label)));
    const rawLabels = group.map((root) => root.label.toLowerCase());
    const generic =
      roles.has("main") &&
      roles.has("chipset") &&
      rawLabels.some((label) => label.includes("save") && label.includes("exit"));
    const oem = roles.has("sysinfo") && hasGenericGroup && groups.length > 1;
    const assessment: MenuProfile["assessment"] = oem
      ? "probable-live"
      : generic && groups.length > 1
        ? "probable-fallback"
        : "unresolved";
    const label = oem
      ? "OEM menu profile · probable live"
      : generic && groups.length > 1
        ? "AMI full profile · probable fallback"
        : groups.length > 1
          ? `Alternate menu profile ${String(index + 1)}`
          : "Menu profile";
    const evidence = [
      hasSetupDataEvidence
        ? `${String(group.length)} contiguous pages are registered in the AMITSE SetupData page list.`
        : `${String(group.length)} HII entry forms occur as a coherent menu sequence.`,
    ];
    if (generic) {
      evidence.push(
        "The Main/Advanced/Chipset/Boot/Security/Save & Exit sequence matches the standard full AMI layout.",
      );
    }
    if (oem) {
      evidence.push(
        "The SysInfo/Advanced/Security/Boot/Exit sequence restarts the major tabs and uses vendor-oriented pages, indicating an alternate OEM layout.",
      );
    }
    if (assessment !== "unresolved") {
      evidence.push(
        "Profile membership is proven by SetupData; probable live/fallback status is inferred from the menu roles because runtime profile selection is not an IFR relationship.",
      );
    }
    const profile: MenuProfile = {
      id: `profile-${String(index + 1)}`,
      label,
      assessment,
      confidence:
        assessment === "unresolved" && hasSetupDataEvidence
          ? "high"
          : "medium",
      evidence,
      roots: group,
    };
    function assignProfile(node: MenuTreeNode) {
      node.profileId = profile.id;
      node.profileLabel = profile.label;
      node.profileAssessment = profile.assessment;
      for (const child of node.children) {
        assignProfile(child);
      }
    }
    for (const root of group) {
      assignProfile(root);
    }
    return profile;
  });
}

interface BuildFormNodeOptions {
  formIndex: number;
  key: string;
  label: string;
  ancestors: Set<number>;
  inheritedStatus: VisibilityStatus;
  reachability: ReachabilityStatus;
  conditionPath?: string[];
  hardwareDependent?: boolean;
  accessDependent?: boolean;
  uiStateDependent?: boolean;
  statusLabel?: string;
  reachabilityLabel?: string;
  rootSource?: RootSource;
  pageMask?: string;
  parentageLabel?: string;
  sourceFormIndex?: number;
  refChildIndex?: number;
}

// Ref cycles are already stopped by the ancestors check below, but a form
// reached via multiple different Ref paths (a "diamond": several menus all
// linking to the same shared sub-page) is deliberately re-expanded once per
// incoming path, since each path can carry its own inherited visibility
// status. Real AMI Aptio setups share sub-pages heavily, so a chain of just
// a few dozen such diamonds can multiply into millions of node builds and
// freeze the tab. This caps total node creation so the tree always finishes
// in bounded time; MenuTree.truncated tells the UI to warn instead of
// silently rendering an incomplete tree.
const MAX_MENU_TREE_NODES = 20000;

export function buildMenuTree(data: Data): MenuTree {
  const reachable = new Set<number>();
  const expandableKeys: string[] = [];
  const firstKeyByFormIndex = new Map<number, string>();
  let nodeCount = 0;
  let truncated = false;

  function buildFormNode(options: BuildFormNodeOptions): MenuTreeNode {
    nodeCount++;
    if (nodeCount > MAX_MENU_TREE_NODES) {
      truncated = true;
    }
    const {
      formIndex,
      key,
      label,
      ancestors,
      inheritedStatus,
      reachability,
      conditionPath = [],
      hardwareDependent = false,
      accessDependent = false,
      uiStateDependent = false,
      statusLabel = visibilityLabel(inheritedStatus),
      reachabilityLabel = reachability === "detached"
        ? "Detached descendant"
        : "Reachable from menu",
      rootSource,
      pageMask,
      parentageLabel = "No incoming IFR reference was found.",
      sourceFormIndex,
      refChildIndex,
    } = options;
    const form = data.forms[formIndex];
    const cycle = ancestors.has(formIndex);
    reachable.add(formIndex);

    if (!firstKeyByFormIndex.has(formIndex)) {
      firstKeyByFormIndex.set(formIndex, key);
    }

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(formIndex);

    const children = cycle || truncated
      ? []
      : form.children
          .map((child, childIndex): MenuTreeNode | null => {
            if (child.type !== "Ref") {
              return null;
            }

            const reference = child;
            const targetFormSetGuid =
              reference.targetFormSetGuid ?? form.formSetGuid;
            const targetIndex = findFormIndexByFormId(
              data.forms,
              reference.formId,
              targetFormSetGuid,
            );
            const childKey = `${key}/ref-${String(childIndex)}-${normalizedHexId(
              reference.formId,
            )}`;
            const visibility = childVisibility(data, reference);
            const descriptions = conditionDescriptions(visibility);
            const nextConditionPath = [...conditionPath, ...descriptions];
            const nextHardwareDependent =
              hardwareDependent || visibility.hardwareDependent;
            const nextAccessDependent =
              accessDependent || visibility.accessDependent;
            const nextUiStateDependent =
              uiStateDependent || visibility.uiStateDependent;

            if (targetIndex < 0) {
              return {
                key: childKey,
                label:
                  reference.name.length > 0
                    ? reference.name
                    : `Missing form ${reference.formId}`,
                formName: "Referenced form was not found",
                formId: reference.formId,
                formIndex: null,
                children: [],
                missing: true,
                status: "broken",
                statusLabel: visibilityLabel("broken"),
                reachability: "broken",
                reachabilityLabel: "Dangling Ref target",
                hardwareDependent: nextHardwareDependent,
                accessDependent: nextAccessDependent,
                uiStateDependent: nextUiStateDependent,
                incomingReferenceCount: 1,
                outgoingReferenceCount: 0,
                parentageLabel: `Referenced by ${form.name || form.formId}, but the target does not exist.`,
                conditionSummary:
                  nextConditionPath.join("; ") ||
                  "The Ref target does not exist in the parsed HII graph.",
                sourceFormIndex: formIndex,
                refChildIndex: childIndex,
              };
            }

            const target = data.forms[targetIndex];
            const status = combineVisibility(
              inheritedStatus,
              visibility.status,
            );
            return buildFormNode({
              formIndex: targetIndex,
              key: childKey,
              label: reference.name.length > 0 ? reference.name : target.name,
              ancestors: nextAncestors,
              inheritedStatus: status,
              reachability:
                reachability === "detached" ? "detached" : "reachable",
              conditionPath: nextConditionPath,
              hardwareDependent: nextHardwareDependent,
              accessDependent: nextAccessDependent,
              uiStateDependent: nextUiStateDependent,
              statusLabel: inheritedStatusLabel(
                status,
                visibility.status,
                visibility.label,
              ),
              reachabilityLabel:
                reachability === "detached"
                  ? "Detached descendant"
                  : "Reachable through Ref",
              parentageLabel: `Referenced by ${form.name || form.formId} through an IFR Ref opcode.`,
              sourceFormIndex: formIndex,
              refChildIndex: childIndex,
            });
          })
          .filter((node): node is MenuTreeNode => node !== null);

    if (children.length > 0) {
      expandableKeys.push(key);
    }

    return {
      key,
      label:
        label.length > 0
          ? label
          : form.name.length > 0
            ? form.name
            : `Form ${form.formId}`,
      formName: form.name,
      formId: form.formId,
      formIndex,
      children,
      cycle,
      status: inheritedStatus,
      statusLabel,
      reachability,
      reachabilityLabel,
      rootSource,
      hardwareDependent,
      accessDependent,
      uiStateDependent,
      pageMask,
      incomingReferenceCount: form.referencedIn.length,
      outgoingReferenceCount: form.children.filter(
        (child) => child.type === "Ref",
      ).length,
      parentageLabel,
      conditionSummary:
        conditionPath.length > 0 ? conditionPath.join("; ") : undefined,
      sourceFormIndex,
      refChildIndex,
    };
  }

  const hasAmitseRoots = data.menu.some(
    (entry) =>
      entry.source === "setupdata" ||
      entry.source === "amitse" ||
      entry.offset !== null,
  );
  const rootEntries = hasAmitseRoots
    ? data.menu.filter(
        (entry) =>
          entry.source === "setupdata" ||
          entry.source === "amitse" ||
          entry.offset !== null,
      )
    : data.menu;

  const roots = rootEntries
    .map((entry, menuIndex): MenuTreeNode | null => {
      const formIndex = findFormIndexByFormId(
        data.forms,
        entry.formId,
        entry.formSetGuid,
      );
      const rootSource: RootSource =
        entry.source === "setupdata"
          ? "setupdata"
          : entry.source === "amitse" || entry.offset !== null
            ? "amitse"
            : "hii-formset";
      const reachabilityLabel =
        rootSource === "setupdata"
          ? "AMITSE SetupData page"
          : rootSource === "amitse"
            ? "AMITSE executable root"
            : "HII FormSet entry";

      if (formIndex < 0) {
        return {
          key: `root-${String(menuIndex)}-${normalizedHexId(entry.formId)}`,
          label: entry.name || `Missing root ${entry.formId}`,
          formName: "Menu root target was not found",
          formId: entry.formId,
          formIndex: null,
          children: [],
          missing: true,
          status: "broken",
          statusLabel: visibilityLabel("broken"),
          reachability: "broken",
          reachabilityLabel: "Broken root target",
          rootSource,
          hardwareDependent: false,
          accessDependent: false,
          uiStateDependent: false,
          pageMask: entry.pageMask,
          incomingReferenceCount: 0,
          outgoingReferenceCount: 0,
          parentageLabel: "The registered menu root target is missing.",
          conditionSummary:
            "The menu entry points to a form that does not exist in the parsed HII graph.",
        };
      }

      const form = data.forms[formIndex];
      return buildFormNode({
        formIndex,
        key: `root-${String(menuIndex)}-${normalizedHexId(entry.formId)}`,
        label:
          entry.name.length > 0
            ? entry.name
            : (form.formSetTitle ?? form.name),
        ancestors: new Set(),
        inheritedStatus: "visible",
        reachability: "root",
        statusLabel: "No visibility gate",
        reachabilityLabel,
        rootSource,
        pageMask: entry.pageMask,
        parentageLabel:
          rootSource === "setupdata"
            ? `Registered as a top-level AMITSE SetupData page${entry.pageMask ? ` with mask ${entry.pageMask}` : ""}. It has ${String(form.referencedIn.length)} incoming and ${String(form.children.filter((child) => child.type === "Ref").length)} outgoing IFR Ref(s); its parent is the AMITSE menu profile, not another HII form.`
            : "Registered as a top-level menu entry; it does not require an IFR Ref parent.",
      });
    })
    .filter((node): node is MenuTreeNode => node !== null);

  if (roots.length === 0) {
    for (const [formIndex, form] of data.forms.entries()) {
      if (form.referencedIn.length === 0 && !reachable.has(formIndex)) {
        roots.push(
          buildFormNode({
            formIndex,
            key: `root-fallback-${String(formIndex)}`,
            label: form.formSetTitle ?? form.name,
            ancestors: new Set(),
            inheritedStatus: "visible",
            reachability: "root",
            statusLabel: "No visibility gate",
            reachabilityLabel: "Inferred graph entry",
            rootSource: "inferred",
            parentageLabel:
              "Inferred as a root because no incoming IFR Ref was found.",
          }),
        );
      }
    }
  }

  const profiles = inferMenuProfiles(roots);

  const remaining = new Set(
    data.forms
      .map((_, formIndex) => formIndex)
      .filter((formIndex) => !reachable.has(formIndex)),
  );
  const incomingFromRemaining = new Map<number, number>();
  for (const formIndex of remaining) {
    incomingFromRemaining.set(formIndex, 0);
  }
  for (const formIndex of remaining) {
    const form = data.forms[formIndex];
    for (const child of form.children) {
      if (child.type !== "Ref") {
        continue;
      }
      const targetIndex = findFormIndexByFormId(
        data.forms,
        child.formId,
        child.targetFormSetGuid ?? form.formSetGuid,
      );
      if (remaining.has(targetIndex)) {
        incomingFromRemaining.set(
          targetIndex,
          (incomingFromRemaining.get(targetIndex) ?? 0) + 1,
        );
      }
    }
  }

  const formSetRootIndices = new Set(
    (
      data.formSetRoots ??
      data.menu.filter((entry) => entry.source === "formset")
    )
      .map((entry) =>
        findFormIndexByFormId(data.forms, entry.formId, entry.formSetGuid),
      )
      .filter((formIndex) => formIndex >= 0),
  );
  const detachedCandidates = [
    ...[...remaining].filter((formIndex) => formSetRootIndices.has(formIndex)),
    ...[...remaining].filter(
      (formIndex) =>
        !formSetRootIndices.has(formIndex) &&
        (incomingFromRemaining.get(formIndex) ?? 0) === 0,
    ),
  ];

  const orphans: MenuTreeNode[] = [];
  function addDetachedRoot(formIndex: number, reason: string) {
    if (reachable.has(formIndex)) {
      return;
    }
    const form = data.forms[formIndex];
    orphans.push(
      buildFormNode({
        formIndex,
        key: `detached-${String(formIndex)}`,
        label: form.formSetTitle ?? form.name,
        ancestors: new Set(),
        inheritedStatus: "visible",
        reachability: "detached",
        statusLabel: "No visibility gate",
        reachabilityLabel: reason,
        parentageLabel: reason,
      }),
    );
  }

  for (const formIndex of detachedCandidates) {
    addDetachedRoot(
      formIndex,
      formSetRootIndices.has(formIndex)
        ? "Detached HII FormSet"
        : "Unreferenced form",
    );
  }

  for (const formIndex of remaining) {
    addDetachedRoot(formIndex, "Detached cycle or isolated subgraph");
  }

  const signature = [
    ...roots.map((node) => node.key),
    ...orphans.map((node) => node.key),
    ...data.forms.map(
      (form) =>
        `${form.formSetGuid ?? ""}:${normalizedHexId(form.formId)}:${form.children
          .filter((child) => child.type === "Ref")
          .map(
            (child) =>
              `${child.targetFormSetGuid ?? form.formSetGuid ?? ""}:${normalizedHexId(child.formId)}`,
          )
          .join(",")}`,
    ),
  ].join("|");

  return {
    roots,
    profiles,
    orphans,
    expandableKeys,
    firstKeyByFormIndex,
    signature,
    truncated,
  };
}

export function findNodePath(
  nodes: MenuTreeNode[],
  formIndex: number,
): MenuTreeNode[] {
  for (const node of nodes) {
    if (node.formIndex === formIndex) {
      return [node];
    }

    const childPath = findNodePath(node.children, formIndex);
    if (childPath.length > 0) {
      return [node, ...childPath];
    }
  }

  return [];
}
