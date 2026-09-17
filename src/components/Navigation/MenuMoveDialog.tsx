import { Alert, Button, Group, Modal, Select, Stack, Text } from "@mantine/core";
import React from "react";
import type { Updater } from "use-immer";
import { hexToBytes } from "../scripts/binaryPatcher";
import type { Data } from "../scripts/types";
import type { MenuTree, MenuTreeNode } from "./menuTree";
import { analyzeMoveDestinations, applyMoveToDraft } from "./relocating";
import { buildRefLocation } from "./reparenting";

interface MenuMoveDialogProps {
  data: Data;
  tree: MenuTree;
  node: MenuTreeNode;
  opened: boolean;
  originalSetupSct: string;
  setData: Updater<Data>;
  onClose: () => void;
}

const compatibilityLabels = {
  "safe-same-package": "Safe",
  "safe-cross-package": "Safe across packages",
  "requires-ref3": "Needs REF3",
  unavailable: "Unavailable",
} as const;

// The effective visibility of each Form as it appears anywhere in the tree,
// so a destination can be labelled with the state the moved item would
// inherit there.
function destinationStates(tree: MenuTree) {
  const nodesByForm = new Map<number, MenuTreeNode[]>();
  const visit = (nodes: MenuTreeNode[]) => {
    for (const candidate of nodes) {
      if (candidate.formIndex !== null) {
        nodesByForm.set(candidate.formIndex, [
          ...(nodesByForm.get(candidate.formIndex) ?? []),
          candidate,
        ]);
      }
      visit(candidate.children);
    }
  };
  visit([...tree.roots, ...tree.orphans]);
  return new Map(
    [...nodesByForm].map(([formIndex, nodes]) => {
      const state = nodes.every((candidate) => candidate.reachability === "detached")
        ? "detached"
        : nodes.some((candidate) => candidate.status === "visible")
          ? "visible"
          : nodes.some((candidate) => candidate.status === "conditional")
            ? "conditional"
            : nodes.some((candidate) => candidate.status === "hidden")
              ? "hidden"
              : "unknown";
      return [formIndex, state] as const;
    }),
  );
}

export default function MenuMoveDialog({
  data,
  tree,
  node,
  opened,
  originalSetupSct,
  setData,
  onClose,
}: MenuMoveDialogProps) {
  const [destination, setDestination] = React.useState<string | null>(null);
  const [error, setError] = React.useState("");

  const location = React.useMemo(
    () =>
      node.sourceFormIndex !== undefined && node.refChildIndex !== undefined
        ? buildRefLocation(data, node.sourceFormIndex, node.refChildIndex)
        : null,
    [data, node],
  );
  const sourceForm = location ? data.forms[location.sourceFormIndex] : undefined;
  const compatibility = React.useMemo(
    () =>
      location ? analyzeMoveDestinations(data, location, hexToBytes(originalSetupSct)) : [],
    [data, location, originalSetupSct],
  );
  const compatibilityByIndex = new Map(
    compatibility.map((result) => [result.formIndex, result]),
  );
  const states = React.useMemo(() => destinationStates(tree), [tree]);

  const destinations = data.forms.map((form, index) => {
    const result = compatibilityByIndex.get(index);
    const safe = result?.compatibility.startsWith("safe-") ?? false;
    const status = compatibilityLabels[result?.compatibility ?? "unavailable"];
    return {
      value: String(index),
      label: `${status} · ${form.name || "Unnamed Form"} · ${form.formId}${
        form.formSetTitle ? ` · ${form.formSetTitle}` : ""
      } · ${states.get(index) ?? "unknown"}${
        form.referencedIn.length === 0 ? " · no incoming Ref" : ""
      }${!safe && result?.reason ? ` — ${result.reason}` : ""}`,
      disabled: !safe,
    };
  });
  const safeDestinations = compatibility.filter((result) =>
    result.compatibility.startsWith("safe-"),
  ).length;
  const ref3Destinations = compatibility.filter(
    (result) => result.compatibility === "requires-ref3",
  ).length;
  const selectedCompatibility =
    destination === null ? undefined : compatibilityByIndex.get(Number.parseInt(destination, 10));

  function applyMove() {
    if (!location || destination === null) return;
    const destinationFormIndex = Number.parseInt(destination, 10);
    setError("");
    try {
      setData((draft) => {
        applyMoveToDraft(draft, location.sourceFormIndex, location.childIndex, destinationFormIndex);
      });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Move HII menu" centered>
      <Stack gap="md">
        <div>
          <Text size="sm" fw={600}>
            {node.label}
          </Text>
          <Text size="xs" c="dimmed">
            Current parent: {sourceForm?.name ?? "Unknown Form"}
          </Text>
        </div>

        <Select
          label="Destination Form"
          placeholder="Choose the new parent menu"
          searchable
          data={destinations}
          value={destination}
          onChange={setDestination}
          nothingFoundMessage="No destination Forms"
        />

        <Text size="xs" c="dimmed">
          {safeDestinations} safe destination{safeDestinations === 1 ? "" : "s"}
          {ref3Destinations > 0
            ? ` · ${String(ref3Destinations)} require REF3 conversion`
            : ""}
        </Text>

        {selectedCompatibility && (
          <Alert color="blue" title="Validated destination">
            {selectedCompatibility.reason}
          </Alert>
        )}

        <Text size="xs" c="dimmed">
          This moves the existing direct IFR Ref without changing the Setup HII size.
          Cross-package moves rebalance the proven package headers. Destinations that
          need opcode growth, have ambiguous provenance, duplicate the target or create
          a graph cycle remain disabled.
        </Text>

        {error.length > 0 && (
          <Alert color="red" title="The menu could not be moved">
            {error}
          </Alert>
        )}

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={applyMove} disabled={destination === null}>
            Move menu
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
