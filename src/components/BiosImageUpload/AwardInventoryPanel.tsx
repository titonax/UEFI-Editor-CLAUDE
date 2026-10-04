import { Alert, Badge, Group, ScrollArea, Stack, Table, Text } from "@mantine/core";
import type { AwardImageInspection } from "../scripts/awardFirmware";
import { summarizeAwardItemPages } from "../scripts/awardItemTable";
import { formatHexOffset } from "../scripts/amiFirmwareImage";

// Read-only view of a Phoenix-Award 6.00PG image: its LHA module chain and,
// when `_ITEM.BIN` decodes, a per-page summary of the setup items. Nothing
// here can be edited - see docs/award/README.md for what is known and what
// is not.
export default function AwardInventoryPanel({ inspection }: { inspection: AwardImageInspection }) {
  const { inventory, itemTable, itemTableError } = inspection;
  const pages = itemTable ? summarizeAwardItemPages(itemTable) : [];
  const hidden = itemTable?.records.filter((record) => record.hidden) ?? [];
  return (
    <Stack gap="xs">
      <Alert color="gray" title="Phoenix-Award BIOS inventory (read-only)">
        <Text size="sm">
          {String(inventory.modules.length)} checksum-verified LHA module(s). This editor
          cannot edit Award setup menus; see docs/award/README.md.
        </Text>
      </Alert>
      <ScrollArea h={Math.min(inventory.modules.length, 8) * 34 + 38}>
        <Table striped withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Module</Table.Th>
              <Table.Th>Offset</Table.Th>
              <Table.Th>Stored</Table.Th>
              <Table.Th>Packed</Table.Th>
              <Table.Th>Original</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {inventory.modules.map((module) => (
              <Table.Tr key={module.offset}>
                <Table.Td>{module.name}</Table.Td>
                <Table.Td>{formatHexOffset(module.offset)}</Table.Td>
                <Table.Td>{module.method === "-lh0-" ? "raw" : "LH5"}</Table.Td>
                <Table.Td>{String(module.packedSize)}</Table.Td>
                <Table.Td>{String(module.originalSize)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea>
      {itemTableError && (
        <Alert color="yellow" title="_ITEM.BIN could not be read">
          {itemTableError}
        </Alert>
      )}
      {itemTable && (
        <Stack gap="xs">
          <Group gap="xs">
            <Badge variant="light">{String(itemTable.records.length)} setup item record(s)</Badge>
            <Badge variant="light" color="gray">
              {String(itemTable.explainedBytes)} of {String(itemTable.totalBytes)} bytes decoded
            </Badge>
            <Badge variant="light" color={hidden.length > 0 ? "orange" : "gray"}>
              {String(hidden.length)} statically hidden
            </Badge>
          </Group>
          <Text size="xs" c="dimmed">
            Items per setup page (page number as the setup code derives it):{" "}
            {pages.map((entry) => `${String(entry.page)}: ${String(entry.items)}`).join(" · ")}.
            Hardware-dependent items are also hidden by code at run time, which this table
            cannot show.
          </Text>
        </Stack>
      )}
    </Stack>
  );
}
