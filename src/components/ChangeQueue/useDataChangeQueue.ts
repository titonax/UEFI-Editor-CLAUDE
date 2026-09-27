// Ported from titonax/uefi-editor-gpt's own ChangeQueue/useDataChangeQueue.ts,
// unchanged: it's already fully generic over Data, with no vendor-specific
// logic of its own - see dataChangeQueue.ts for where Data's own shape
// matters.
import React from "react";
import { produce, type Draft } from "immer";
import type { Updater } from "use-immer";
import type { ChangeQueueEntry } from "../scripts/changeQueue";
import type { Data } from "../scripts/types";
import {
  appendDataChangeEntry,
  createDataChangeEntry,
  projectDataChangeQueue,
  type DataChangePayload,
} from "./dataChangeQueue";

export interface DataChangeQueueController {
  entries: ChangeQueueEntry<DataChangePayload>[];
  previewData: Data;
  appliedData: Data;
  analysis: ReturnType<typeof projectDataChangeQueue>["analysis"];
  appliedFingerprint: string | null;
  enqueueData: Updater<Data>;
  replaceBase: (data: Data) => void;
  toggleEnabled: (id: string, enabled: boolean) => void;
  remove: (id: string) => void;
  clear: () => void;
  apply: () => void;
}

// Wraps a Data value with a review queue: enqueueData is a drop-in
// Updater<Data> (the same shape use-immer's own setData has), so every
// existing edit handler keeps calling it exactly as before - it just stages
// a described, toggleable entry instead of committing straight away. See
// App.tsx for how `data`/`setData` get swapped for
// `previewData`/`enqueueData` at the top of the tree.
export function useDataChangeQueue(initialData: Data): DataChangeQueueController {
  const [base, setBase] = React.useState(() => structuredClone(initialData));
  const [entries, setEntries] = React.useState<ChangeQueueEntry<DataChangePayload>[]>(
    [],
  );
  const [appliedFingerprint, setAppliedFingerprint] = React.useState<string | null>(
    null,
  );
  const nextId = React.useRef(1);
  const projection = React.useMemo(
    () => projectDataChangeQueue(base, entries),
    [base, entries],
  );

  const enqueueData = React.useCallback<Updater<Data>>(
    (update) => {
      const before = projection.data;
      const after =
        typeof update === "function"
          ? produce(before, update as (draft: Draft<Data>) => void)
          : structuredClone(update);
      const entry = createDataChangeEntry(
        before,
        after,
        `firmware-change:${String(nextId.current)}`,
      );
      if (!entry) return;
      nextId.current += 1;
      setEntries((current) => appendDataChangeEntry(current, entry));
      setAppliedFingerprint(null);
    },
    [projection.data],
  );

  const replaceBase = React.useCallback((data: Data) => {
    setBase(structuredClone(data));
    setEntries([]);
    setAppliedFingerprint(null);
    nextId.current = 1;
  }, []);
  const toggleEnabled = React.useCallback((id: string, enabled: boolean) => {
    setEntries((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, enabled } : entry)),
    );
    setAppliedFingerprint(null);
  }, []);
  const remove = React.useCallback((id: string) => {
    setEntries((current) => current.filter((entry) => entry.id !== id));
    setAppliedFingerprint(null);
  }, []);
  const clear = React.useCallback(() => {
    setEntries([]);
    setAppliedFingerprint(null);
  }, []);
  const apply = React.useCallback(() => {
    if (projection.analysis.canApply) {
      setAppliedFingerprint(projection.analysis.fingerprint);
    }
  }, [projection.analysis]);
  const applied =
    projection.analysis.canApply &&
    appliedFingerprint === projection.analysis.fingerprint;

  return {
    entries,
    previewData: projection.data,
    appliedData: applied ? projection.data : base,
    analysis: projection.analysis,
    appliedFingerprint,
    enqueueData,
    replaceBase,
    toggleEnabled,
    remove,
    clear,
    apply,
  };
}
