import React from "react";
import { Alert, Badge, Button, Checkbox, Group, NavLink, ScrollArea, Select, Stack, Table, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconDownload } from "@tabler/icons-react";
import { type PhoenixSetupMenu, savePhoenixSetupChanges } from "../scripts/phoenixSetupTable";
import { isForceableItem, isPhoenixLabelItem, phoenixItemTypeLabel, phoenixText } from "./biosImageLabels";

// The Phoenix setup menu panel of the firmware upload screen.
// The Phoenix counterpart to the AMI Aptio HII menu tree: every screen a
// legacy Phoenix CMOS Setup Table defines, with each item's prompt/help
// resolved from STRINGS.ROM and a Pick Field's own option list turned into
// a real selector. Laid out the same way the AMI editor is - a screen list
// on the left, the selected screen's items on the right. When the image
// carries a root/tab table (see parsePhoenixRootTable in
// phoenixSetupTable.ts) each screen is the real Setup tab - "Main",
// "Security", "Boot", ... - with its authoritative item membership;
// otherwise this falls back to unnamed, contiguous-run "Screen N" sections
// that don't claim a confirmed tab identity (see docs/phoenix/README.md).
//
// A Pick Field's own selection here is staged in this browser tab only and
// never exported - there's no persisted "current value" for one anywhere
// in TEMPLAT.ROM to write it to (it lives in NVRAM at runtime instead).
// "Force visible", by contrast, is a genuine, exportable edit: patching the
// hide path's own immediate operand is the exact machine-code change
// confirmed - byte-for-byte, on real hardware - to make a hidden item
// appear, and the Export button below produces the same
// header-stripped TEMPLAT00.ROM Phoenix BIOS Editor's own TEMP folder
// expects, ready to drop in and rebuild with PBE (no LH5 encoder needed for
// this - PBE's own "Build" does the recompression). See
// docs/phoenix/README.md's "Menu visibility" section for the full mechanism
// and "Exporting a visibility patch for Phoenix BIOS Editor" for the
// exact PBE steps this mirrors.
export function PhoenixSetupMenuPanel({ menu, templat }: { menu: PhoenixSetupMenu; templat: Uint8Array }) {
  const sections = React.useMemo(
    () => menu.sections.filter((section) => section.items.length > 0),
    [menu],
  );
  const [selectedOffset, setSelectedOffset] = React.useState<number | null>(
    sections[0]?.offset ?? null,
  );
  const [selections, setSelections] = React.useState<Record<number, string>>({});
  const [forcedVisibleOffsets, setForcedVisibleOffsets] = React.useState<ReadonlySet<number>>(
    new Set(),
  );

  const totalItems = sections.reduce((sum, section) => sum + section.items.length, 0);
  const totalUnparsed = sections.reduce((sum, section) => sum + (section.unparsedItems ?? 0), 0);
  if (totalItems === 0) return null;
  const selectedSection = sections.find((section) => section.offset === selectedOffset) ?? sections[0];
  const hasRealTabs = menu.source === "root-table";
  const forcedVisibleItems = sections
    .flatMap((section) => section.items)
    .filter((item) => forcedVisibleOffsets.has(item.offset));

  return (
    <Stack gap="xs">
      <Group gap="xs">
        <Badge variant="light" color="grape">
          Phoenix Setup menu: {String(sections.length)} screen(s), {String(totalItems)} item(s)
        </Badge>
        {hasRealTabs && (
          <Badge variant="light" color="teal">
            Real tab names (root table)
          </Badge>
        )}
        {totalUnparsed > 0 && (
          <Badge variant="light" color="orange">
            {String(totalUnparsed)} item(s) could not be parsed
          </Badge>
        )}
      </Group>
      <Text size="xs" c="dimmed">
        Prompts, help text and a Pick Field's own option list, all resolved
        from STRINGS.ROM. Bold rows are Text/Submenu items, which read as
        in-line group labels rather than questions.{" "}
        {hasRealTabs
          ? "Screen names and item membership below come from the image's own root/tab table."
          : "This image has no root/tab table, so screens below are unnamed contiguous runs rather than confirmed Setup tabs."}{" "}
        A selection made below is only kept in this browser tab - it isn't
        written back into the image yet, and some items may be conditionally
        hidden on real hardware by embedded firmware logic this inventory
        can't evaluate - see docs/phoenix/README.md.
      </Text>
      <Group align="flex-start" gap="md" wrap="nowrap">
        <ScrollArea.Autosize mah={480} miw={220} maw={220}>
          <Stack gap={2}>
            {sections.map((section, index) => (
              <NavLink
                key={section.offset}
                label={phoenixText(section.name) ?? `Screen ${String(index + 1)}`}
                description={
                  `${String(section.items.length)} item(s)` +
                  ((section.unparsedItems ?? 0) > 0
                    ? ` · ${String(section.unparsedItems)} unparsed`
                    : "")
                }
                active={section.offset === selectedSection.offset}
                onClick={() => {
                  setSelectedOffset(section.offset);
                }}
                variant="light"
              />
            ))}
          </Stack>
        </ScrollArea.Autosize>
        <ScrollArea.Autosize mah={480} style={{ flex: 1, minWidth: 0 }}>
          <Table striped withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Type</Table.Th>
                <Table.Th>Prompt</Table.Th>
                <Table.Th>Help</Table.Th>
                <Table.Th>Options</Table.Th>
                <Table.Th>Visibility</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {selectedSection.items.map((item) => {
                const isLabel = isPhoenixLabelItem(item.type);
                // Mantine's Select rejects duplicate option values outright
                // (throws, taking down the whole panel) - two option slots
                // can resolve to the same text, so de-duplicate defensively.
                const options = Array.from(
                  new Set(item.options.map((option) => phoenixText(option) ?? option)),
                );
                return (
                  <Table.Tr key={item.offset}>
                    <Table.Td>{phoenixItemTypeLabel(item.type)}</Table.Td>
                    <Table.Td fw={isLabel ? 700 : undefined}>
                      {phoenixText(item.prompt) ?? "—"}
                    </Table.Td>
                    <Table.Td>{phoenixText(item.help)}</Table.Td>
                    <Table.Td>
                      {options.length > 0 && (
                        <Select
                          size="xs"
                          data={options}
                          value={selections[item.offset] ?? options[0]}
                          onChange={(value) => {
                            if (value === null) return;
                            setSelections((current) => ({ ...current, [item.offset]: value }));
                          }}
                          allowDeselect={false}
                          comboboxProps={{ withinPortal: false }}
                        />
                      )}
                    </Table.Td>
                    <Table.Td>
                      {isForceableItem(item) && (
                        <Checkbox
                          size="xs"
                          label="Force visible"
                          checked={forcedVisibleOffsets.has(item.offset)}
                          onChange={(event) => {
                            const checked = event.currentTarget.checked;
                            setForcedVisibleOffsets((current) => {
                              const next = new Set(current);
                              if (checked) next.add(item.offset);
                              else next.delete(item.offset);
                              return next;
                            });
                          }}
                        />
                      )}
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </ScrollArea.Autosize>
      </Group>
      <Alert variant="light" color="teal" title="Save changes">
        <Stack gap="xs">
          <Text size="xs">
            Checking "Force visible" above stages the exact machine-code edit confirmed to work on
            real hardware (see docs/phoenix/README.md) - overwriting that item's hide-path immediate
            operand to 0x0000. Saving downloads only the file that edit actually touches -{" "}
            <Text span ff="monospace" size="xs">
              TEMPLAT00.ROM
            </Text>{" "}
            , already header-stripped for Phoenix BIOS Editor's own{" "}
            <Text span ff="monospace" size="xs">
              TEMP
            </Text>{" "}
            folder - plus a changelog, the same way the AMI editor's own "Save" only downloads what
            it actually changed. Replace it there and rebuild from within PBE; PBE recompresses it
            back to LH5 itself, so no separate encoder is needed here. Full steps in
            docs/phoenix/README.md.
          </Text>
          <Group>
            <Button
              size="xs"
              variant="light"
              leftSection={<IconDownload size={14} />}
              onClick={() => {
                const result = savePhoenixSetupChanges(templat, forcedVisibleItems);
                if (result.status === "no-changes") {
                  notifications.show({
                    color: "blue",
                    title: "Nothing to download",
                    message: "No modifications have been done.",
                  });
                }
              }}
            >
              Save changes
            </Button>
          </Group>
        </Stack>
      </Alert>
    </Stack>
  );
}
