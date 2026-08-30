import React from "react";
import { Stack, Table } from "@mantine/core";
import type { Updater } from "use-immer";
import { useDebouncedState } from "@mantine/hooks";
import type { Data } from "../scripts/types";
import { sameHexId } from "../scripts/hexId";
import { computeChildBlocks, swapAdjacentBlocks } from "../scripts/childOrdering";
import SearchUi from "./SearchUi/SearchUi";
import { summarizeFormBranch } from "../scripts/visibility";
import { findNodePath, type MenuTree } from "../Navigation/menuTree";
import RootsTable from "./RootsTable";
import BranchSummary from "./BranchSummary";
import TableRow from "./TableRow";
import s from "./FormUi.module.css";
import { SEARCH_VIEW, TOP_LEVEL_MENU_VIEW } from "../../formNavigation";

interface FormUiProps {
  data: Data;
  setData: Updater<Data>;
  currentFormIndex: number;
  setCurrentFormIndex: React.Dispatch<React.SetStateAction<number>>;
  tree: MenuTree;
}

export default function FormUi({
  data,
  setData,
  currentFormIndex,
  setCurrentFormIndex,
  tree,
}: FormUiProps) {
  const [search, setSearch] = useDebouncedState("", 200);

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
    return (
      <RootsTable
        data={data}
        setData={setData}
        roots={tree.roots}
        handleRefClick={handleRefClick}
      />
    );
  }

  if (!visibilitySummary) {
    return null;
  }

  const activeProfile = tree.profiles.find(
    (profile) => profile.id === pageNode.profileId,
  );
  const pageStatus = pageNode.status;

  const children = data.forms[currentFormIndex].children;
  // Blocks group a child together with any sibling(s) sharing the same
  // enclosing SuppressIf/GrayOutIf/DisableIf, since a condition wrapper has
  // to move as a whole with whatever it hides - see childOrdering.ts. Only
  // a block's first row gets the move controls; the rest of the block just
  // comes along with it.
  const blocks = computeChildBlocks(children);
  const blockIndexByChildIndex = new Map<number, number>();
  blocks.forEach((block, blockIndex) => {
    blockIndexByChildIndex.set(block.startIndex, blockIndex);
  });

  function moveBlock(blockIndex: number, direction: "up" | "down") {
    setData((draft) => {
      draft.forms[currentFormIndex].children = swapAdjacentBlocks(
        draft.forms[currentFormIndex].children,
        computeChildBlocks(draft.forms[currentFormIndex].children),
        blockIndex,
        direction,
      );
    });
  }

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
        {children.map((child, index) => {
          const blockIndex = blockIndexByChildIndex.get(index);
          return (
            <TableRow
              key={`${child.type}:${child.questionId}`}
              child={child}
              index={index}
              handleRefClick={handleRefClick}
              data={data}
              setData={setData}
              currentFormIndex={currentFormIndex}
              moveControl={
                blockIndex === undefined
                  ? null
                  : {
                      canMoveUp: blockIndex > 0,
                      canMoveDown: blockIndex < blocks.length - 1,
                      onMove: (direction) => {
                        moveBlock(blockIndex, direction);
                      },
                    }
              }
            />
          );
        })}
      </Table.Tbody>
      </Table>
    </Stack>
  );
}
