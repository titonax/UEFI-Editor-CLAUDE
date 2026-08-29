import React from "react";
import s from "./FormUi.module.css";
import type { Updater } from "use-immer";
import {
  Table,
  TextInput,
  NativeSelect,
  Spoiler,
  Stack,
  Group,
  Badge,
  Button,
  Text,
  Tooltip,
} from "@mantine/core";
import { useDebouncedState } from "@mantine/hooks";
import type {
  ConditionSource,
  Data,
  FormChildren,
  VisibilityStatus,
} from "../scripts/types";
import { validateByteInput } from "../scripts/binaryPatcher";
import { sameHexId } from "../scripts/hexId";
import SearchUi from "./SearchUi/SearchUi";
import {
  childVisibility,
  conditionsForChild,
  summarizeFormBranch,
} from "../scripts/visibility";
import { buildMenuTree, findNodePath } from "../Navigation/menuTree";

const conditionSourceMeta: Record<
  ConditionSource,
  { label: string; color: string; explanation: string }
> = {
  setup: {
    label: "Setup value",
    color: "blue",
    explanation: "The condition reads a user-configurable Setup value.",
  },
  hardware: {
    label: "HW capability",
    color: "yellow",
    explanation:
      "The condition reads a firmware-populated platform or CPU capability flag.",
  },
  access: {
    label: "Access policy",
    color: "violet",
    explanation:
      "The condition depends on AMI user/admin access or security state, not hardware.",
  },
  ui: {
    label: "AMI UI state",
    color: "cyan",
    explanation: "The condition depends on AMITSE navigation or UI state.",
  },
  runtime: {
    label: "Runtime variable",
    color: "orange",
    explanation:
      "The variable is evaluated at runtime but is not classified as hardware, access, or UI state.",
  },
  constant: {
    label: "Constant",
    color: "gray",
    explanation: "The IFR expression has a constant result.",
  },
  unknown: {
    label: "Unknown source",
    color: "gray",
    explanation: "The variable source could not be resolved.",
  },
};

const visibilityColors = {
  visible: "green",
  hidden: "red",
  conditional: "orange",
  unknown: "gray",
  orphaned: "red",
  broken: "pink",
} as const;

function ConditionDetails({
  child,
  data,
  setData,
}: {
  child: FormChildren;
  data: Data;
  setData: Updater<Data>;
}) {
  const conditions = conditionsForChild(data, child);
  if (conditions.length === 0 && child.accessLevel === null) {
    return <Text size="xs" c="dimmed">No condition</Text>;
  }

  return (
    <Stack gap={5} className={s.conditionList}>
      {conditions.map((condition) => {
        const index = data.suppressions.indexOf(condition);
        const kind = condition.kind ?? "SuppressIf";
        const source = condition.source ?? "unknown";
        const sourceMeta = conditionSourceMeta[source];
        return (
          <div key={condition.offset} className={s.conditionCard}>
            <Group gap={5} justify="space-between" wrap="nowrap">
              <Group gap={5} wrap="wrap">
                <Badge size="xs" color={kind === "SuppressIf" ? "red" : "orange"}>
                  {kind}
                </Badge>
                <Tooltip
                  label={
                    `${sourceMeta.explanation}${
                      condition.varStoreNames?.length
                        ? ` VarStore: ${condition.varStoreNames.join(", ")}.`
                        : ""
                    }`
                  }
                  multiline
                  w={340}
                >
                  <Badge
                    size="xs"
                    variant="outline"
                    color={sourceMeta.color}
                  >
                    {sourceMeta.label}
                  </Badge>
                </Tooltip>
              </Group>
              {kind === "SuppressIf" ? (
                <Tooltip label="Disable this suppression in the generated change set">
                  <Button
                    size="compact-xs"
                    color={condition.active ? "red" : "green"}
                    variant={condition.active ? "light" : "filled"}
                    onClick={() => {
                      if (index < 0) {
                        return;
                      }
                      setData((draft) => {
                        draft.suppressions[index].active = !condition.active;
                      });
                    }}
                  >
                    {condition.active ? "Force visible" : "Visibility forced"}
                  </Button>
                </Tooltip>
              ) : (
                <Badge size="xs" color="gray" variant="light">Read-only</Badge>
              )}
            </Group>
            <Text size="xs" mt={4} className={s.conditionExpression}>
              {condition.expression ?? `Condition at ${condition.offset}`}
            </Text>
            <Text size="xs" c="dimmed" mt={3}>
              {kind === "SuppressIf"
                ? "This expression hides the item when true."
                : "This expression disables or grays the item when true."}
              {" "}IFR condition offset: {condition.offset}
            </Text>
            {condition.varStoreNames?.length ? (
              <Text size="xs" c="dimmed" mt={3}>
                VarStore: {condition.varStoreNames.join(", ")}
              </Text>
            ) : null}
          </div>
        );
      })}
      {child.accessLevel !== null ? (
        <div className={s.conditionCard}>
          <Badge size="xs" color="gray" variant="outline">
            AMI access policy
          </Badge>
          <Text size="xs" mt={4} className={s.conditionExpression}>
            SetupData AccessLevel == 0x{child.accessLevel}
          </Text>
          <Text size="xs" c="dimmed" mt={3}>
            Shown as evidence only; this byte is not classified as hidden or
            visible without model-specific proof.
          </Text>
        </div>
      ) : null}
    </Stack>
  );
}

interface TableRowProps {
  child: FormChildren;
  index: number;
  handleRefClick: (formId: string, formSetGuid?: string) => void;
  data: Data;
  setData: Updater<Data>;
  currentFormIndex: number;
}

const TableRow = React.memo(
  function TableRow({
    child,
    index,
    handleRefClick,
    data,
    setData,
    currentFormIndex,
  }: TableRowProps) {
    const type = child.type;
    const visibility = childVisibility(data, child);
    const info = [];

    if (type === "CheckBox" || type === "OneOf" || type === "Numeric") {
      if (type === "OneOf") {
        for (const option of child.options) {
          info.push([option.option, option.value]);
        }

        info.push(["newline"]);
      }

      if (type === "Numeric") {
        info.push(
          ["Min", child.min],
          ["Max", child.max],
          ["Step", child.step],
          ["newline"]
        );
      }

      if (child.defaults) {
        for (const def of child.defaults) {
          info.push([`DefaultId ${def.defaultId}`, def.value]);
        }

        if (type !== "CheckBox") {
          info.push(["newline"]);
        }
      }

      if (type === "CheckBox") {
        const def = /\bDefault: (Enabled|Disabled)/.exec(child.flags);
        if (def) {
          info.push(["Default", def[1] === "Enabled" ? "1" : "0"]);
        }

        const mfgDef = /MfgDefault: (Enabled|Disabled)/.exec(child.flags);
        if (mfgDef) {
          info.push(["MfgDefault", mfgDef[1] === "Enabled" ? "1" : "0"]);
        }

        if (def ?? mfgDef ?? child.defaults) {
          info.push(["newline"]);
        }
      }

      info.push(
        ["QuestionId", child.questionId],
        ["VarStoreId", child.varStoreId],
        ["VarStoreName", child.varStoreName],
        ["VarOffset", child.varOffset]
      );

      if (type !== "CheckBox") {
        info.push(["Size (bits)", child.size]);
      }
    }

    return (
      <tr className={s.memoRow}>
        <td
          className={type === "Ref" ? s.pointer : undefined}
          onClick={() => {
            if (type === "Ref") {
              handleRefClick(child.formId, child.targetFormSetGuid);
            }
          }}
        >
          {child.name}
        </td>
        <td>{type}</td>
        <td>
          <Tooltip label={visibility.explanation} multiline w={320}>
            <Badge color={visibilityColors[visibility.status]} variant="light">
              {visibility.label}
            </Badge>
          </Tooltip>
        </td>
        <td className={s.width}>
          {child.accessLevel !== null && (
            <TextInput
              value={child.accessLevel}
              onChange={(ev) => {
                const value = ev.target.value.toUpperCase();

                if (validateByteInput(value)) {
                  setData((draft) => {
                    draft.forms[currentFormIndex].children[index].accessLevel =
                      value;
                  });
                }
              }}
            />
          )}
        </td>
        <td className={s.width}>
          {child.failsafe !== null && (
            <TextInput
              value={child.failsafe}
              onChange={(ev) => {
                const value = ev.target.value.toUpperCase();

                if (validateByteInput(value)) {
                  setData((draft) => {
                    draft.forms[currentFormIndex].children[index].failsafe =
                      value;
                  });
                }
              }}
            />
          )}
        </td>
        <td className={s.width}>
          {child.optimal !== null && (
            <TextInput
              value={child.optimal}
              onChange={(ev) => {
                const value = ev.target.value.toUpperCase();

                if (validateByteInput(value)) {
                  setData((draft) => {
                    draft.forms[currentFormIndex].children[index].optimal =
                      value;
                  });
                }
              }}
            />
          )}
        </td>
        <td><ConditionDetails child={child} data={data} setData={setData} /></td>
        <td>
          <Spoiler
            transitionDuration={0}
            maxHeight={70}
            showLabel=".........."
            hideLabel="....."
          >
            <Stack>
              {child.description && (
                <div>
                  {child.description
                    .split("<br>")
                    .filter((line) => line !== "")
                    .map((line, index) => (
                      // Static, stateless text rows recomputed from `child`
                      // on every render - never reordered or animated, so
                      // an index key is safe here.
                      // eslint-disable-next-line react-x/no-array-index-key
                      <div key={index}>{line}</div>
                    ))}
                </div>
              )}
              {info.length > 0 && (
                <div>
                  {info.map((item, index) => (
                    // eslint-disable-next-line react-x/no-array-index-key -- static, stateless rows recomputed on every render
                    <div key={index} className={s.infoRow}>
                      {item[0] === "newline" ? (
                        <br />
                      ) : (
                        <>
                          <div>{item[0]}</div>
                          <div>{item[1]}</div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Stack>
          </Spoiler>
        </td>
      </tr>
    );
  },
  (oldProps: TableRowProps, newProps: TableRowProps) => {
    const oldChild =
      oldProps.data.forms[oldProps.currentFormIndex].children[oldProps.index];
    const newChild =
      newProps.data.forms[newProps.currentFormIndex].children[newProps.index];

    if (
      oldChild.accessLevel !== newChild.accessLevel ||
      oldChild.failsafe !== newChild.failsafe ||
      oldChild.optimal !== newChild.optimal
    ) {
      return false;
    }

    // The offset list itself is fixed at parse time; only a referenced
    // suppression's `active` flag can change between renders.
    const offsets = oldChild.conditions ?? oldChild.suppressIf ?? [];
    return offsets.every((offset) => {
      const wasActive = oldProps.data.suppressions.find(
        (suppression) => suppression.offset === offset,
      )?.active;
      const isActive = newProps.data.suppressions.find(
        (suppression) => suppression.offset === offset,
      )?.active;
      return wasActive === isActive;
    });
  }
);

interface FormUiProps {
  data: Data;
  setData: Updater<Data>;
  currentFormIndex: number;
  setCurrentFormIndex: React.Dispatch<React.SetStateAction<number>>;
}

export default function FormUi({
  data,
  setData,
  currentFormIndex,
  setCurrentFormIndex,
}: FormUiProps) {
  const [search, setSearch] = useDebouncedState("", 200);
  const semanticTree = React.useMemo(() => buildMenuTree(data), [data]);

  function handleRefClick(formId: string, formSetGuid?: string) {
    const sourceFormSetGuid =
      formSetGuid ??
      (currentFormIndex >= 0
        ? data.forms[currentFormIndex].formSetGuid
        : undefined);
    let formIndex = data.forms.findIndex(
      (form) =>
        form.formSetGuid === sourceFormSetGuid &&
        sameHexId(form.formId, formId),
    );

    if (formIndex < 0) {
      formIndex = data.forms.findIndex((form) => sameHexId(form.formId, formId));
    }

    if (formIndex >= 0) {
      setCurrentFormIndex(formIndex);

      document.getElementById(`nav-${formIndex.toString()}`)?.scrollIntoView();
    }
  }

  if (currentFormIndex === -2) {
    return (
      <SearchUi
        data={data}
        handleRefClick={handleRefClick}
        search={search}
        setSearch={setSearch}
      />
    );
  }

  if (currentFormIndex === -1) {
    return (
      <Table striped withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Name</Table.Th>
            <Table.Th>Form Id</Table.Th>
            <Table.Th>Root evidence</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {data.menu.map((entry, index) => (
            <Table.Tr key={`${entry.formSetGuid ?? ""}:${entry.formId}`}>
              <Table.Td
                className={s.pointer}
                onClick={() => {
                  handleRefClick(entry.formId, entry.formSetGuid);
                }}
              >
                {entry.name}
              </Table.Td>
              <Table.Td className={s.formIdWidth}>
                <NativeSelect
                  className={s.formIdChildWidth}
                  disabled={entry.offset === null}
                  value={entry.formId}
                  data={data.forms
                    .filter(
                      (form) =>
                        !entry.formSetGuid ||
                        form.formSetGuid === entry.formSetGuid,
                    )
                    .map((form) => form.formId)}
                  onChange={(ev) => {
                    const value = ev.target.value;

                    setData((draft) => {
                      draft.menu[index].formId = value;
                      const matchedForm = data.forms.find(
                        (form) =>
                          (!entry.formSetGuid ||
                            form.formSetGuid === entry.formSetGuid) &&
                          sameHexId(form.formId, value),
                      );
                      draft.menu[index].name = matchedForm?.name ?? entry.name;
                    });
                  }}
                />
              </Table.Td>
              <Table.Td>
                <Group gap={5}>
                  <Tooltip
                    label={
                      entry.source === "setupdata"
                        ? `This root is registered in the AMITSE SetupData page list${entry.pageMask ? ` with page mask ${entry.pageMask}` : ""}.`
                        : entry.source === "amitse" || entry.offset !== null
                          ? "This root is present in the AMITSE executable menu table."
                          : "This is the entry form declared by its HII FormSet. It is structural evidence, not a runtime visibility condition."
                    }
                    multiline
                    w={360}
                  >
                    <Badge
                      color={
                        entry.source === "setupdata"
                          ? "cyan"
                          : entry.source === "amitse" || entry.offset !== null
                            ? "green"
                            : "blue"
                      }
                      variant="light"
                    >
                      {entry.source === "setupdata"
                        ? `SetupData page ${entry.pageMask ?? ""}`
                        : entry.source === "amitse" || entry.offset !== null
                          ? "AMITSE menu"
                          : "HII FormSet entry"}
                    </Badge>
                  </Tooltip>
                  {semanticTree.roots[index]?.profileLabel && (
                    <Badge
                      size="xs"
                      color={
                        semanticTree.roots[index].profileAssessment ===
                        "probable-live"
                          ? "green"
                          : semanticTree.roots[index].profileAssessment ===
                              "probable-fallback"
                            ? "orange"
                            : "gray"
                      }
                      variant="outline"
                    >
                      {semanticTree.roots[index].profileLabel}
                    </Badge>
                  )}
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    );
  }

  const currentPath = findNodePath(semanticTree.roots, currentFormIndex);
  const orphanPath =
    currentPath.length === 0
      ? findNodePath(semanticTree.orphans, currentFormIndex)
      : [];
  const activePath = currentPath.length > 0 ? currentPath : orphanPath;
  const pageNode = activePath[activePath.length - 1];
  const activeProfile = semanticTree.profiles.find(
    (profile) => profile.id === pageNode.profileId,
  );
  const pageStatus = pageNode.status;
  const visibilitySummary = summarizeFormBranch(
    data,
    currentFormIndex,
    pageStatus,
  );

  function summaryBadges(counts: Record<VisibilityStatus, number>) {
    return (
      <>
        <Badge color="green">{counts.visible} ungated</Badge>
        <Badge color="red">{counts.hidden} hidden / affected</Badge>
        <Badge color="orange">
          {counts.conditional} unavailable / affected
        </Badge>
        {counts.orphaned > 0 && (
          <Badge color="red">{counts.orphaned} orphaned</Badge>
        )}
        {counts.broken > 0 && (
          <Badge color="pink">{counts.broken} broken</Badge>
        )}
        {counts.unknown > 0 && (
          <Badge color="gray">{counts.unknown} unresolved</Badge>
        )}
      </>
    );
  }

  function sourceBadges(counts: Record<ConditionSource, number>) {
    return (
      <>
        {counts.hardware > 0 && (
          <Badge color="yellow" variant="outline">
            {counts.hardware} HW capability
          </Badge>
        )}
        {counts.access > 0 && (
          <Badge color="violet" variant="outline">
            {counts.access} access policy
          </Badge>
        )}
        {counts.ui > 0 && (
          <Badge color="cyan" variant="outline">
            {counts.ui} UI state
          </Badge>
        )}
        {counts.setup > 0 && (
          <Badge color="blue" variant="outline">
            {counts.setup} Setup value
          </Badge>
        )}
        {counts.runtime > 0 && (
          <Badge color="orange" variant="outline">
            {counts.runtime} other runtime
          </Badge>
        )}
      </>
    );
  }

  return (
    <Stack gap={0}>
      <Stack gap={4} className={s.visibilitySummary}>
        <Group gap="xs">
          <Text size="sm" fw={600}>Selected path:</Text>
          <Tooltip
            label={
              pageNode.conditionSummary ?? pageNode.reachabilityLabel
            }
            multiline
            w={420}
          >
            <Badge
              color={pageNode.reachability === "detached" ? "gray" : "blue"}
              variant="light"
            >
              {pageNode.reachabilityLabel}
            </Badge>
          </Tooltip>
          {activeProfile && (
            <Tooltip
              label={activeProfile.evidence.join(" ")}
              multiline
              w={460}
            >
              <Badge
                color={
                  activeProfile.assessment === "probable-live"
                    ? "green"
                    : activeProfile.assessment === "probable-fallback"
                      ? "orange"
                      : "gray"
                }
                variant="outline"
              >
                {activeProfile.label}
              </Badge>
            </Tooltip>
          )}
          {(pageStatus === "hidden" || pageStatus === "conditional") && (
            <Tooltip label={pageNode.conditionSummary} multiline w={420}>
              <Badge color={visibilityColors[pageStatus]} variant="light">
                {pageNode.statusLabel}
              </Badge>
            </Tooltip>
          )}
          {pageNode.hardwareDependent && (
            <Badge color="yellow" variant="outline">HW capability</Badge>
          )}
          {pageNode.accessDependent && (
            <Badge color="violet" variant="outline">Access policy</Badge>
          )}
          {pageNode.uiStateDependent && (
            <Badge color="cyan" variant="outline">AMI UI state</Badge>
          )}
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Text size="sm" fw={600}>Parentage:</Text>
          <Tooltip
            label={`${String(pageNode.incomingReferenceCount)} incoming IFR Ref(s); ${String(pageNode.outgoingReferenceCount)} outgoing IFR Ref(s).`}
          >
            <Text size="xs" c="dimmed">
              {pageNode.parentageLabel}
            </Text>
          </Tooltip>
        </Group>
        <Group gap="xs">
          <Text size="sm" fw={600}>This page:</Text>
          {summaryBadges(visibilitySummary.direct)}
          {sourceBadges(visibilitySummary.directSources)}
        </Group>
        <Group gap="xs">
          <Tooltip label="Includes controls and Ref targets in every nested page">
            <Text size="sm" fw={600}>Whole branch:</Text>
          </Tooltip>
          {summaryBadges(visibilitySummary.branch)}
          {sourceBadges(visibilitySummary.branchSources)}
          <Text size="xs" c="dimmed">
            {visibilitySummary.descendantForms} nested pages
          </Text>
        </Group>
      </Stack>
      <Table stickyHeader stickyHeaderOffset={150} striped withColumnBorders>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Name</Table.Th>
          <Table.Th>Type</Table.Th>
          <Table.Th>HII effect</Table.Th>
          <Table.Th>Access Level</Table.Th>
          <Table.Th>Failsafe</Table.Th>
          <Table.Th>Optimal</Table.Th>
          <Table.Th>Condition</Table.Th>
          <Table.Th>Info</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody className={s.striped}>
        {data.forms[currentFormIndex].children.map((child, index) => (
          <TableRow
            key={`${child.type}:${child.questionId}`}
            child={child}
            index={index}
            handleRefClick={handleRefClick}
            data={data}
            setData={setData}
            currentFormIndex={currentFormIndex}
          />
        ))}
      </Table.Tbody>
      </Table>
    </Stack>
  );
}
