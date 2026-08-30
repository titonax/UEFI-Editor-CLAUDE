import React from "react";
import { Alert, Button, Group, Modal, Select, Stack, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import type { Updater } from "use-immer";
import type { Data } from "../scripts/types";
import { buildRefLocation, listMoveCandidates, type MoveCandidate } from "./reparenting";

export interface MoveRefTarget {
  sourceFormIndex: number;
  childIndex: number;
}

interface MoveRefDialogProps {
  data: Data;
  setData: Updater<Data>;
  target: MoveRefTarget;
  onClose: () => void;
  onMoved: (newFormIndex: number) => void;
}

function candidateLabel(candidate: MoveCandidate) {
  const base = `${candidate.name} (${candidate.formId})`;
  if (candidate.result.allowed) {
    return base;
  }
  const reason =
    candidate.result.reason === "same-target"
      ? "current destination"
      : "would create a navigation cycle";
  return `${base} — ${reason}`;
}

// Editing a Ref's target is the one HII-safe way to change "what this menu
// item opens" without resizing anything: FormId is a same-size, in-place
// overwrite (see binaryPatcher.ts). It is NOT the same as moving a Form out
// of one parent's child list and into another's - that would mean deleting
// or inserting a Ref opcode, which this app deliberately never does. So the
// dialog is honest about what actually happens: this one link gets a new
// destination; nothing else in the firmware changes.
export default function MoveRefDialog({
  data,
  setData,
  target,
  onClose,
  onMoved,
}: MoveRefDialogProps) {
  const location = React.useMemo(
    () => buildRefLocation(data, target.sourceFormIndex, target.childIndex),
    [data, target],
  );
  const candidates = React.useMemo(
    () => listMoveCandidates(data, location),
    [data, location],
  );
  const [selected, setSelected] = React.useState<string | null>(null);

  const sourceForm = data.forms[location.sourceFormIndex];
  const currentTarget =
    location.targetFormIndex >= 0 ? data.forms[location.targetFormIndex] : null;
  const selectedCandidate = candidates.find(
    (candidate) => String(candidate.formIndex) === selected,
  );

  return (
    <Modal opened title="Change link destination" onClose={onClose}>
      <Stack gap="sm">
        <Text size="sm">
          <Text span fw={600}>
            {location.ref.name || "This link"}
          </Text>{" "}
          in {sourceForm.name || sourceForm.formId}
        </Text>
        <Text size="sm" c="dimmed">
          Currently opens:{" "}
          {currentTarget
            ? `${currentTarget.name || currentTarget.formId} (${currentTarget.formId})`
            : "nothing — this is a dangling reference"}
        </Text>

        <Select
          label="New destination"
          placeholder="Pick a form"
          searchable
          value={selected}
          onChange={setSelected}
          data={candidates.map((candidate) => ({
            value: String(candidate.formIndex),
            label: candidateLabel(candidate),
            disabled: !candidate.result.allowed,
          }))}
        />

        <Alert
          icon={<IconAlertTriangle size={16} />}
          color="yellow"
          variant="light"
        >
          This only changes where the link goes. Its own text (
          {location.ref.name ? `"${location.ref.name}"` : "its label"}) comes
          from the firmware's original string table and won't update to
          describe the new destination.
        </Alert>

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!selectedCandidate?.result.allowed}
            onClick={() => {
              if (!selectedCandidate) {
                return;
              }
              setData((draft) => {
                const child =
                  draft.forms[location.sourceFormIndex].children[
                    location.childIndex
                  ];
                if (child.type === "Ref") {
                  child.formId = selectedCandidate.formId;
                }
              });
              onMoved(selectedCandidate.formIndex);
              onClose();
            }}
          >
            Change destination
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
