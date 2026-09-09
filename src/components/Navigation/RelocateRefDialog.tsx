import React from "react";
import { Alert, Button, Group, Modal, Select, Stack, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import type { Updater } from "use-immer";
import type { Data } from "../scripts/types";
import { buildRefLocation } from "./reparenting";
import {
  applyMoveToDraft,
  canRefBeMoved,
  listMoveDestinations,
  type MoveDestination,
} from "./relocating";
import type { MoveRefTarget } from "./MoveRefDialog";

interface RelocateRefDialogProps {
  data: Data;
  setData: Updater<Data>;
  target: MoveRefTarget;
  onClose: () => void;
  onMoved: (newFormIndex: number) => void;
}

function destinationLabel(destination: MoveDestination) {
  const base = `${destination.name} (${destination.formId})`;
  if (destination.result.allowed) {
    return base;
  }
  const reason =
    destination.result.reason === "same-parent"
      ? "already its current page"
      : destination.result.reason === "duplicate-target"
        ? "already links to the same page"
        : "would create a navigation cycle";
  return `${base} — ${reason}`;
}

// Physically relocates a Ref opcode (and, if it's the sole occupant of one,
// its enclosing SuppressIf/GrayOutIf/DisableIf) so it becomes a child of a
// different Form - unlike MoveRefDialog, which only redirects where a link
// already on this page points to, this actually changes which page lists
// it. See relocating.ts and binaryPatcher.ts's detectRefMoves/applyRefMoves
// for why this stays HII-size-neutral: the same bytes just move to a new
// spot, spliced in right before the destination Form's own closing End.
export default function RelocateRefDialog({
  data,
  setData,
  target,
  onClose,
  onMoved,
}: RelocateRefDialogProps) {
  const location = React.useMemo(
    () => buildRefLocation(data, target.sourceFormIndex, target.childIndex),
    [data, target],
  );
  const eligibility = canRefBeMoved(data, location);
  const destinations = React.useMemo(
    () => (eligibility.allowed ? listMoveDestinations(data, location) : []),
    [data, location, eligibility.allowed],
  );
  const [selected, setSelected] = React.useState<string | null>(null);

  const sourceForm = data.forms[location.sourceFormIndex];
  const selectedDestination = destinations.find(
    (destination) => String(destination.formIndex) === selected,
  );

  return (
    <Modal opened title="Move to a different page" onClose={onClose}>
      <Stack gap="sm">
        <Text size="sm">
          <Text span fw={600}>
            {location.ref.name || "This item"}
          </Text>{" "}
          is currently on {sourceForm.name || sourceForm.formId}
        </Text>

        {!eligibility.allowed && (
          <Alert
            icon={<IconAlertTriangle size={16} />}
            color="yellow"
            variant="light"
            title="Can't move this on its own"
          >
            {eligibility.explanation}
          </Alert>
        )}

        {eligibility.allowed && (
          <>
            <Select
              label="Move to"
              placeholder="Pick a page"
              searchable
              value={selected}
              onChange={setSelected}
              data={destinations.map((destination) => ({
                value: String(destination.formIndex),
                label: destinationLabel(destination),
                disabled: !destination.result.allowed,
              }))}
            />

            <Alert
              icon={<IconAlertTriangle size={16} />}
              color="yellow"
              variant="light"
            >
              This physically relocates the item - it stops appearing on{" "}
              {sourceForm.name || sourceForm.formId} and appears on the
              destination page instead. Its own label doesn't change, and
              anything that was hiding it moves along with it.
            </Alert>
          </>
        )}

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {eligibility.allowed ? "Cancel" : "Close"}
          </Button>
          {eligibility.allowed && (
            <Button
              disabled={!selectedDestination?.result.allowed}
              onClick={() => {
                if (!selectedDestination) {
                  return;
                }
                setData((draft) => {
                  applyMoveToDraft(
                    draft,
                    location.sourceFormIndex,
                    location.childIndex,
                    selectedDestination.formIndex,
                  );
                });
                onMoved(selectedDestination.formIndex);
                onClose();
              }}
            >
              Move
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
