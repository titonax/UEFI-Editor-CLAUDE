// Ported from titonax/uefi-editor-gpt's own ChangeQueue/DataChangeQueueDialog.tsx,
// unchanged: the thin AMI Data-specific wrapper around the generic
// ChangeQueueDialog, supplying the "logical field/edit" wording instead of
// the byte-patch one a raw binary queue would use.
import ChangeQueueDialog from "./ChangeQueueDialog";
import type { DataChangeQueueController } from "./useDataChangeQueue";

export default function DataChangeQueueDialog({
  opened,
  queue,
  onClose,
}: {
  opened: boolean;
  queue: DataChangeQueueController;
  onClose: () => void;
}) {
  return (
    <ChangeQueueDialog
      opened={opened}
      entries={queue.entries}
      analysis={queue.analysis}
      appliedFingerprint={queue.appliedFingerprint}
      onClose={onClose}
      onToggleEnabled={queue.toggleEnabled}
      onRemove={queue.remove}
      onClear={queue.clear}
      onApply={queue.apply}
      metricLabels={{
        units: "net logical field(s)",
        spans: "optimized logical edit(s)",
      }}
    />
  );
}
