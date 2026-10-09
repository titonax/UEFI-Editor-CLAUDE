import { Alert, Badge, Button, Code, Group, List, Modal, Stack, Table, Text } from "@mantine/core";
import { IconAlertTriangle, IconCheck, IconDownload, IconShieldCheck } from "@tabler/icons-react";
import { saveAs } from "file-saver";
import React from "react";
import type { PopulatedFiles } from "../FileUploads/fileModel";
import { startFullImageCheck as startCheckInWorker, type FullImageCheckHandle } from "../scripts/fullImageCheckClient";
import {
  changesFromPlan,
  modifiedImageName,
  type FullImageRequest,
  type FullImageResult,
  type FullImageStage,
} from "../scripts/fullImageExport";
import { assessFirmwareReconstruction } from "../scripts/firmwareProvenance";
import type { Data } from "../scripts/types";

const stageTitle: Record<FullImageStage, string> = {
  plan: "The plan cannot be placed in the image",
  rebuild: "The image cannot be rebuilt or failed its own checks",
  "read-back": "The rebuilt image does not read back as intended",
  report: "The record of the output could not be made",
};

type CheckState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "refused"; fingerprint: string | null; message: string }
  | { phase: "done"; fingerprint: string | null; result: FullImageResult };

interface FullImageExportDialogProps {
  opened: boolean;
  onClose: () => void;
  files: PopulatedFiles;
  // The applied plan; the dialog never reads the live preview.
  appliedData: Data;
  // Identifies the applied plan, so a result for an older plan is not offered.
  planFingerprint: string | null;
  // Injectable for tests; the app runs the check in a worker.
  startCheck?: (request: FullImageRequest) => FullImageCheckHandle;
}

function SummaryRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Table.Tr>
      <Table.Td>{label}</Table.Td>
      <Table.Td>{value}</Table.Td>
    </Table.Tr>
  );
}

export default function FullImageExportDialog({
  opened,
  onClose,
  files,
  appliedData,
  planFingerprint,
  startCheck = startCheckInWorker,
}: FullImageExportDialogProps) {
  const [state, setState] = React.useState<CheckState>({ phase: "idle" });
  const handle = React.useRef<FullImageCheckHandle | null>(null);
  const source = files.firmwareSource;

  React.useEffect(
    () => () => {
      handle.current?.cancel();
    },
    [],
  );

  if (!source) return null;
  const assessment = assessFirmwareReconstruction(source.artifacts.provenance);
  const done = state.phase === "done" ? state : null;
  const refused = state.phase === "refused" ? state : null;
  // Whatever the last run concluded is about the plan it was run for.
  const concludedFor = done?.fingerprint ?? refused?.fingerprint;
  const fresh = (done ?? refused) !== null && concludedFor === planFingerprint;
  const stale = (done ?? refused) !== null && !fresh;
  const success = fresh && done?.result.ok ? done.result : null;
  const failure = fresh && done && !done.result.ok ? done.result : null;

  const run = () => {
    const fingerprint = planFingerprint;
    let request: FullImageRequest;
    try {
      const changes = changesFromPlan(appliedData, files);
      const context = source.artifacts.artifactSets.find((one) => one.id === source.artifacts.selectedArtifactSetId);
      if (!context) throw new Error("The selected firmware context is not among the contexts this image holds.");
      request = {
        context,
        graph: source.artifacts.provenance,
        artifactSetId: source.artifacts.selectedArtifactSetId,
        sourceName: source.fileName,
        changes,
      };
    } catch (error) {
      setState({ phase: "refused", fingerprint, message: error instanceof Error ? error.message : String(error) });
      return;
    }
    setState({ phase: "running" });
    let started: FullImageCheckHandle;
    try {
      started = startCheck(request);
    } catch (error) {
      setState({ phase: "refused", fingerprint, message: error instanceof Error ? error.message : String(error) });
      return;
    }
    handle.current = started;
    started.result.then(
      (result) => {
        if (handle.current !== started) return;
        handle.current = null;
        setState({ phase: "done", fingerprint, result });
      },
      (error: unknown) => {
        if (handle.current !== started) return;
        handle.current = null;
        setState({ phase: "refused", fingerprint, message: error instanceof Error ? error.message : String(error) });
      },
    );
  };

  const cancel = () => {
    const running = handle.current;
    handle.current = null;
    running?.cancel();
    setState({ phase: "idle" });
  };

  const download = (result: Extract<FullImageResult, { ok: true }>, withImage: boolean) => {
    // The changelog first: if the browser lets only one download through, a
    // changelog without an image is harmless and an image without its
    // changelog is not.
    saveAs(new Blob([result.changelog], { type: "text/plain" }), "changelog.txt");
    if (withImage) {
      saveAs(new Blob([result.image], { type: "application/octet-stream" }), modifiedImageName(source.fileName));
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={() => {
        // A check nobody is looking at would only keep the CPU busy.
        if (state.phase === "running") cancel();
        onClose();
      }}
      title="Complete firmware image"
      size="xl"
      centered
    >
      <Stack gap="md">
        <Text size="sm">
          Puts the applied change queue back into <Code>{source.fileName}</Code> and checks the result before
          offering it. Nothing is downloaded until the check passes.
        </Text>

        {!assessment.writeEnabled && (
          <Alert color="red" icon={<IconAlertTriangle size={16} />} title="This image cannot be rebuilt">
            {assessment.blockers.join(" ")}
          </Alert>
        )}

        <Alert color="yellow" icon={<IconAlertTriangle size={16} />} title="What a passing check does not prove">
          <List size="sm" spacing={4}>
            {assessment.caveats.map((caveat) => (
              <List.Item key={caveat}>{caveat}</List.Item>
            ))}
          </List>
          <Text size="sm" mt="xs">
            Keep a backup read of the chip made with a hardware programmer before flashing anything.
          </Text>
        </Alert>

        <Group>
          {state.phase === "running" ? (
            <Button color="gray" variant="default" onClick={cancel}>
              Cancel check
            </Button>
          ) : (
            <Button
              leftSection={<IconShieldCheck size={16} />}
              disabled={!assessment.writeEnabled}
              onClick={run}
            >
              Check firmware output
            </Button>
          )}
          {state.phase === "running" && (
            <Text size="sm" c="dimmed">
              Rebuilding and reading the image back. This can take minutes on a large image; closing this window cancels it.
            </Text>
          )}
        </Group>

        {refused && fresh && (
          <Alert color="red" icon={<IconAlertTriangle size={16} />} title="The check could not run">
            {refused.message}
          </Alert>
        )}

        {failure && (
          <Alert color="red" icon={<IconAlertTriangle size={16} />} title={stageTitle[failure.stage]}>
            <List size="sm" spacing={4}>
              {failure.messages.map((message, index) => (
                <List.Item key={`${String(index)}:${message}`}>{message}</List.Item>
              ))}
            </List>
            <Text size="sm" mt="xs">
              No image was produced. Your edits are still in the change queue and in data.json.
            </Text>
          </Alert>
        )}

        {stale && (
          <Alert color="orange" icon={<IconAlertTriangle size={16} />} title="This result is for an older plan">
            The applied change queue has changed since the last check. Run it again.
          </Alert>
        )}

        {success && (
          <Stack gap="xs">
            <Group gap="xs">
              <Badge color="green" leftSection={<IconCheck size={11} />}>
                Checks passed
              </Badge>
              <Badge color="gray" variant="light">
                not flashed
              </Badge>
            </Group>
            <Table withColumnBorders>
              <Table.Tbody>
                <SummaryRow label="Changed bytes" value={`${String(success.summary.changedBytes)} in ${String(success.summary.changedRanges)} range(s)`} />
                <SummaryRow label="FFS checksums repaired" value={success.summary.repairedFiles} />
                <SummaryRow label="Compressed sections re-encoded" value={success.summary.recompressedSections} />
                <SummaryRow label="Size" value={`${String(success.summary.imageBytes)} bytes (unchanged)`} />
                <SummaryRow label="Source SHA-256" value={<Code>{success.summary.sourceSha256}</Code>} />
                <SummaryRow label="Output SHA-256" value={<Code>{success.summary.outputSha256}</Code>} />
              </Table.Tbody>
            </Table>
            <Group>
              <Button
                color="green"
                leftSection={<IconDownload size={16} />}
                onClick={() => {
                  download(success, true);
                }}
              >
                Download image and changelog.txt
              </Button>
              <Button
                variant="default"
                onClick={() => {
                  download(success, false);
                }}
              >
                changelog.txt only
              </Button>
            </Group>
            <Text size="xs" c="dimmed">
              Two files are downloaded; if your browser asks to allow multiple downloads, allow them. The changelog belongs with the image.
            </Text>
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}
