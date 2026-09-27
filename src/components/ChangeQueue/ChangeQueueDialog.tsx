// Ported from titonax/uefi-editor-gpt's own ChangeQueue/ChangeQueueDialog.tsx,
// unchanged: a generic review UI over ChangeQueueEntry/ChangeQueueAnalysis
// (see scripts/changeQueue.ts), with no vendor-specific logic of its own.
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  ScrollArea,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { IconAlertTriangle, IconCheck, IconTrash } from "@tabler/icons-react";
import type { ChangeQueueAnalysis, ChangeQueueEntry } from "../scripts/changeQueue";

const defaultMetricLabels = {
  units: "byte(s)",
  spans: "optimized patch span(s)",
};

export default function ChangeQueueDialog<TPayload>({
  opened,
  entries,
  analysis,
  appliedFingerprint,
  onClose,
  onToggleEnabled,
  onRemove,
  onClear,
  onApply,
  metricLabels = defaultMetricLabels,
}: {
  opened: boolean;
  entries: ChangeQueueEntry<TPayload>[];
  analysis: ChangeQueueAnalysis<TPayload>;
  appliedFingerprint: string | null;
  onClose: () => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onApply: () => void;
  metricLabels?: { units: string; spans: string };
}) {
  const isApplied = analysis.canApply && appliedFingerprint === analysis.fingerprint;
  const errors = analysis.issues.filter((issue) => issue.severity === "error");
  const warnings = analysis.issues.filter((issue) => issue.severity === "warning");
  return (
    <Modal opened={opened} onClose={onClose} title="Change queue" size="xl" centered>
      <Stack gap="md">
        <Group gap="xs">
          <Badge color="blue" variant="light">
            {String(analysis.stats.selectedChanges)} selected
          </Badge>
          <Badge color="gray" variant="light">
            {String(analysis.stats.changedBytes)} {metricLabels.units}
          </Badge>
          <Badge color="gray" variant="light">
            {String(analysis.stats.patchSpans)} {metricLabels.spans}
          </Badge>
          {analysis.stats.deduplicatedSpans > 0 && (
            <Badge color="violet" variant="light">
              {String(analysis.stats.deduplicatedSpans)} duplicate span(s) removed
            </Badge>
          )}
          {isApplied && (
            <Badge color="green" leftSection={<IconCheck size={11} />}>
              Applied plan
            </Badge>
          )}
        </Group>

        {errors.map((issue) => (
          <Alert
            key={`${issue.code}:${issue.entryIds.join(":")}`}
            color="red"
            icon={<IconAlertTriangle size={16} />}
            title="This selection cannot be applied"
          >
            {issue.message}
          </Alert>
        ))}
        {warnings.map((issue) => (
          <Alert
            key={`${issue.code}:${issue.entryIds.join(":")}`}
            color="yellow"
            icon={<IconAlertTriangle size={16} />}
            title="Queue optimization"
          >
            {issue.message}
          </Alert>
        ))}

        {entries.length === 0 ? (
          <Text c="dimmed" ta="center" py="xl">
            The queue is empty. Add an operation from an editable firmware item.
          </Text>
        ) : (
          <ScrollArea mah={420}>
            <Table striped withColumnBorders>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={58}>Use</Table.Th>
                  <Table.Th>Operation</Table.Th>
                  <Table.Th>Target</Table.Th>
                  <Table.Th>Effect</Table.Th>
                  <Table.Th w={72}>Remove</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {entries.map((entry) => (
                  <Table.Tr key={entry.id} opacity={entry.enabled ? 1 : 0.55}>
                    <Table.Td>
                      <Checkbox
                        checked={entry.enabled}
                        aria-label={`Select ${entry.title}`}
                        onChange={(event) => {
                          onToggleEnabled(entry.id, event.currentTarget.checked);
                        }}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Badge variant="light">{entry.operation}</Badge>
                    </Table.Td>
                    <Table.Td>{entry.title}</Table.Td>
                    <Table.Td>
                      <Text size="sm">{entry.description}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Button
                        size="compact-xs"
                        color="red"
                        variant="subtle"
                        aria-label={`Remove ${entry.title} from change queue`}
                        onClick={() => {
                          onRemove(entry.id);
                        }}
                      >
                        <IconTrash size={15} />
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        )}

        <Group justify="space-between">
          <Button
            color="red"
            variant="light"
            disabled={entries.length === 0}
            onClick={onClear}
          >
            Clear queue
          </Button>
          <Group gap="xs">
            <Button variant="default" onClick={onClose}>
              Close
            </Button>
            <Button
              color="green"
              disabled={!analysis.canApply || isApplied}
              onClick={onApply}
            >
              {isApplied ? "Plan applied" : "Apply selected"}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
