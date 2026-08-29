import s from "../FormUi.module.css";
import { useFocusTrap } from "@mantine/hooks";
import type { Data } from "../../scripts/types";
import { Stack, Table, TextInput } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";

interface SearchUiProps {
  data: Data;
  handleRefClick: (formId: string, formSetGuid?: string) => void;
  search: string;
  setSearch: (newValue: string) => void;
}

export default function SearchUi({
  data,
  handleRefClick,
  search,
  setSearch,
}: SearchUiProps) {
  const focusTrapRef = useFocusTrap();

  const found: {
    type: string;
    formId: string;
    formSetGuid?: string;
    formSetTitle?: string;
    formName: string;
    name: string;
  }[] = [];

  if (search.length >= 2) {
    for (const form of data.forms) {
      if (form.name.toLowerCase().includes(search)) {
        found.push({
          type: "Form",
          formId: form.formId,
          formSetGuid: form.formSetGuid,
          formSetTitle: form.formSetTitle,
          formName: form.name,
          name: form.name,
        });
      }

      for (const setting of form.children) {
        if (setting.name.toLowerCase().includes(search)) {
          found.push({
            type: setting.type,
            formId: form.formId,
            formSetGuid: form.formSetGuid,
            formSetTitle: form.formSetTitle,
            formName: form.name,
            name: setting.name,
          });
        }
      }
    }
  }

  return (
    <Stack>
      <TextInput
        ref={focusTrapRef}
        placeholder="Search"
        defaultValue={search}
        leftSection={<IconSearch />}
        onChange={(ev) => {
          setSearch(ev.target.value.toLowerCase());
        }}
      />

      <Table striped withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Name</Table.Th>
            <Table.Th>Type</Table.Th>
            <Table.Th>FormSet</Table.Th>
            <Table.Th>Form Name</Table.Th>
            <Table.Th>Form Id</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {found.map((entry) => (
            <Table.Tr
              key={`${entry.formSetGuid ?? ""}:${entry.formId}:${entry.type}:${entry.name}`}
            >
              <Table.Td>{entry.name}</Table.Td>
              <Table.Td>{entry.type}</Table.Td>
              <Table.Td>{entry.formSetTitle}</Table.Td>
              <Table.Td
                className={s.pointer}
                onClick={() => {
                  handleRefClick(entry.formId, entry.formSetGuid);
                }}
              >
                {entry.formName}
              </Table.Td>
              <Table.Td>{entry.formId}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
