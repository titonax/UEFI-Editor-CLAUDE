import { Alert, Badge, Button, Group, Stack, Table, Text, Tooltip } from "@mantine/core";
import type { Updater } from "use-immer";
import {
  desiredAmiRootVisibility,
  toggleAmiRootVisibility,
} from "../scripts/amiRootVisibilityEditing";
import type { Data } from "../scripts/types";

function formatBufferOffset(offset: number) {
  return `0x${offset.toString(16).toUpperCase()}`;
}

// The AMITSE root byte vector detected in the Setup PE32 (see
// amiRootVisibility.ts), and the per-root desired-state buttons that record
// a reversible pending plan next to the immutable original evidence.
export default function RootVisibilityAnalysis({
  data,
  setData,
}: {
  data: Data;
  setData: Updater<Data>;
}) {
  const report = data.rootVisibility;
  if (!report) return null;

  if (report.status !== "detected") {
    return (
      <Alert
        color={report.status === "ambiguous" ? "orange" : "gray"}
        title={
          report.status === "not-applicable"
            ? "Root visibility — single-FormSet layout"
            : report.status === "ambiguous"
              ? "Root visibility vector — ambiguous"
              : "Root visibility vector — unresolved"
        }
      >
        {report.reason}
      </Alert>
    );
  }

  const originalVisible = report.entries.filter((entry) => entry.visible).length;
  const desiredVisible = report.entries.filter(
    (entry) => desiredAmiRootVisibility(data, entry) === 1,
  ).length;
  const pending = data.rootVisibilityEdits?.length ?? 0;

  return (
    <Alert color="blue" title="Root visibility vector — code corroborated">
      <Stack gap="xs">
        <Text size="sm">{report.reason}</Text>
        <Group gap="xs">
          <Badge color="green">{String(desiredVisible)} desired shown</Badge>
          <Badge color="red">
            {String(report.entries.length - desiredVisible)} desired hidden
          </Badge>
          {pending > 0 && <Badge color="yellow">{String(pending)} pending</Badge>}
          {report.vector && (
            <Badge color="gray" variant="light">
              Buffer {String(report.vector.bufferId)} @{" "}
              {formatBufferOffset(report.vector.offset)}
            </Badge>
          )}
        </Group>
        <Table striped withColumnBorders>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>IFR order</Table.Th>
              <Table.Th>Root FormSet</Table.Th>
              <Table.Th>Original BIOS</Table.Th>
              <Table.Th>Desired state</Table.Th>
              <Table.Th>Vector byte</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {report.entries.map((entry) => {
              const desired = desiredAmiRootVisibility(data, entry);
              const changed = desired !== entry.value;
              return (
                <Table.Tr key={entry.formSetGuid ?? String(entry.rootIndex)}>
                  <Table.Td>{String(entry.rootIndex)}</Table.Td>
                  <Table.Td>
                    <Text size="sm">{entry.name}</Text>
                    {entry.formSetGuid && (
                      <Text size="xs" c="dimmed">
                        {entry.formSetGuid}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Badge color={entry.visible ? "green" : "red"} variant="light">
                      {entry.visible ? "Visible (01)" : "Hidden (00)"}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Tooltip
                      label={`Press to make this root ${desired === 1 ? "hidden" : "visible"}.`}
                    >
                      <Button
                        size="compact-xs"
                        color={desired === 1 ? "green" : "red"}
                        variant={changed ? "filled" : "light"}
                        aria-label={`Desired root state for ${entry.name}: ${desired === 1 ? "visible" : "hidden"}`}
                        onClick={() => {
                          setData((draft) => {
                            draft.rootVisibilityEdits = toggleAmiRootVisibility(
                              draft,
                              entry.rootIndex,
                            );
                          });
                        }}
                      >
                        {desired === 1 ? "Visible (01)" : "Hidden (00)"}
                      </Button>
                    </Tooltip>
                    {changed && (
                      <Text size="xs" c="yellow" mt={3}>
                        Pending change
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>{formatBufferOffset(entry.bufferOffset)}</Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
        {pending > 0 && (
          <Group justify="space-between" gap="xs">
            <Text size="xs" c="yellow">
              Desired state differs from the original BIOS in {String(pending)} root
              {pending === 1 ? "" : "s"}.
            </Text>
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              onClick={() => {
                setData((draft) => {
                  draft.rootVisibilityEdits = undefined;
                });
              }}
            >
              Reset root changes
            </Button>
          </Group>
        )}
        {desiredVisible === 0 && (
          <Text size="xs" c="red">
            Warning: the desired plan hides every root FormSet and could leave Setup
            without a usable top-level page.
          </Text>
        )}
        <Text size="xs" c="dimmed">
          Original evidence remains immutable. Buttons record a reversible desired state
          in the pending change set. Full-image writing remains disabled until the
          reconstruction path can rebuild and verify every enclosing firmware layer. The
          original BIOS contains {String(originalVisible)} visible roots.
        </Text>
      </Stack>
    </Alert>
  );
}
