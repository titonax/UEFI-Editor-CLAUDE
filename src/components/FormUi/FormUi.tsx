import React from "react";
import { Stack, Table } from "@mantine/core";
import type { Updater } from "use-immer";
import { useDebouncedState } from "@mantine/hooks";
import type { Data } from "../scripts/types";
import { sameHexId } from "../scripts/hexId";
import SearchUi from "./SearchUi/SearchUi";
import { summarizeFormBranch } from "../scripts/visibility";
import { buildMenuTree, findNodePath } from "../Navigation/menuTree";
import RootsTable from "./RootsTable";
import BranchSummary from "./BranchSummary";
import TableRow from "./TableRow";
import s from "./FormUi.module.css";

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
      <RootsTable
        data={data}
        setData={setData}
        roots={semanticTree.roots}
        handleRefClick={handleRefClick}
      />
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
