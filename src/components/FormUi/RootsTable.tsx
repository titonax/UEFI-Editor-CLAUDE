import { Badge, Group, NativeSelect, Table, Tooltip } from "@mantine/core";
import type { Updater } from "use-immer";
import type { Data } from "../scripts/types";
import { sameHexId } from "../scripts/hexId";
import type { MenuTreeNode } from "../Navigation/menuTree";
import s from "./FormUi.module.css";

interface RootsTableProps {
  data: Data;
  setData: Updater<Data>;
  roots: MenuTreeNode[];
  handleRefClick: (formId: string, formSetGuid?: string) => void;
}

export default function RootsTable({
  data,
  setData,
  roots,
  handleRefClick,
}: RootsTableProps) {
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
                {roots[index]?.profileLabel && (
                  <Badge
                    size="xs"
                    color={
                      roots[index].profileAssessment === "probable-live"
                        ? "green"
                        : roots[index].profileAssessment ===
                            "probable-fallback"
                          ? "orange"
                          : "gray"
                    }
                    variant="outline"
                  >
                    {roots[index].profileLabel}
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
