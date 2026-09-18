import React from "react";
import { Stack, Table } from "@mantine/core";
import type { Updater } from "use-immer";
import { useDebouncedState } from "@mantine/hooks";
import type { Data } from "../scripts/types";
import { sameHexId } from "../scripts/hexId";
import SearchUi from "./SearchUi/SearchUi";
import { summarizeFormBranch } from "../scripts/visibility";
import { findNodePath, type MenuTree } from "../Navigation/menuTree";
import RootsTable from "./RootsTable";
import RootVisibilityAnalysis from "./RootVisibilityAnalysis";
import SingleFormSetNavigation from "./SingleFormSetNavigation";
import MenuMoveDialog from "../Navigation/MenuMoveDialog";
import type { MenuTreeNode } from "../Navigation/menuTree";
import { sameGuidOrBothUndefined } from "../scripts/hexId";
import { applyTabVisibilityToggle } from "./tabVisibility";
import BranchSummary from "./BranchSummary";
import TableRow from "./TableRow";
import s from "./FormUi.module.css";
import { SEARCH_VIEW, TOP_LEVEL_MENU_VIEW } from "../../formNavigation";

interface FormUiProps {
  data: Data;
  setData: Updater<Data>;
  // The pristine Setup HII as hex, for the tab inventory's move dialog.
  originalSetupSct: string;
  currentFormIndex: number;
  setCurrentFormIndex: React.Dispatch<React.SetStateAction<number>>;
  tree: MenuTree;
}

interface TabPlacementMove {
  node: MenuTreeNode;
  intent: "demote-tab" | "promote-tab";
  initialDestinationFormIndex?: number;
}

export default function FormUi({
  data,
  setData,
  originalSetupSct,
  currentFormIndex,
  setCurrentFormIndex,
  tree,
}: FormUiProps) {
  const [search, setSearch] = useDebouncedState("", 200);
  const [tabMove, setTabMove] = React.useState<TabPlacementMove | null>(null);

  // Computed unconditionally so the useMemo below stays a fixed hook call
  // regardless of which view (search / top-level menu / a specific form)
  // ends up rendering; for the two non-form views these are simply unused.
  const currentPath = findNodePath(tree.roots, currentFormIndex);
  const orphanPath =
    currentPath.length === 0
      ? findNodePath(tree.orphans, currentFormIndex)
      : [];
  const activePath = currentPath.length > 0 ? currentPath : orphanPath;
  const pageNode = activePath[activePath.length - 1];

  const visibilitySummary = React.useMemo(() => {
    if (currentFormIndex < 0) {
      return null;
    }
    return summarizeFormBranch(data, currentFormIndex, pageNode.status);
  }, [data, currentFormIndex, pageNode]);

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

  if (currentFormIndex === SEARCH_VIEW) {
    return (
      <SearchUi
        data={data}
        handleRefClick={handleRefClick}
        search={search}
        setSearch={setSearch}
      />
    );
  }

  if (currentFormIndex === TOP_LEVEL_MENU_VIEW) {
    const navigation = data.singleFormSetNavigation;
    const hubFormIndex =
      navigation?.status === "detected" && navigation.hubFormId !== undefined
        ? data.forms.findIndex(
            (form) =>
              sameHexId(form.formId, navigation.hubFormId ?? "") &&
              sameGuidOrBothUndefined(form.formSetGuid, navigation.formSetGuid),
          )
        : -1;
    return (
      <Stack>
        {tabMove && (
          <MenuMoveDialog
            data={data}
            tree={tree}
            node={tabMove.node}
            opened
            originalSetupSct={originalSetupSct}
            setData={setData}
            intent={tabMove.intent}
            initialDestinationFormIndex={tabMove.initialDestinationFormIndex}
            onClose={() => {
              setTabMove(null);
            }}
          />
        )}
        <RootVisibilityAnalysis data={data} setData={setData} />
        <SingleFormSetNavigation
          data={data}
          tree={tree}
          hubFormIndex={hubFormIndex}
          onMovePage={(page, node) => {
            setTabMove({
              node,
              intent: page.role === "direct-tab" ? "demote-tab" : "promote-tab",
              // A promotion offers the hub straight away when it is known.
              initialDestinationFormIndex:
                page.role === "descendant" && hubFormIndex >= 0 ? hubFormIndex : undefined,
            });
          }}
          onToggleVisibility={(_page, direction, sourceFormIndex, childIndex) => {
            setData((draft) => {
              applyTabVisibilityToggle(draft, hubFormIndex, sourceFormIndex, childIndex, direction);
            });
          }}
        />
        <RootsTable
          data={data}
          setData={setData}
          roots={tree.roots}
          handleRefClick={handleRefClick}
        />
      </Stack>
    );
  }

  if (!visibilitySummary) {
    return null;
  }

  const activeProfile = tree.profiles.find(
    (profile) => profile.id === pageNode.profileId,
  );
  const pageStatus = pageNode.status;

  return (
    <Stack gap={0}>
      <BranchSummary
        pageNode={pageNode}
        activeProfile={activeProfile}
        pageStatus={pageStatus}
        visibilitySummary={visibilitySummary}
      />
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
