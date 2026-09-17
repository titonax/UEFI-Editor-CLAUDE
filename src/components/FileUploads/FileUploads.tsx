import React from "react";
import type { Updater } from "use-immer";
import { FileInput, Stack, LoadingOverlay } from "@mantine/core";
import { IconUpload } from "@tabler/icons-react";
import { parseData } from "../scripts/ifrParser";
import type { Data } from "../scripts/types";
import { fileContainers, isPopulatedFiles, type Files } from "./fileModel";

const hexWorker = () =>
  new Worker(new URL("../scripts/hexWorker.ts", import.meta.url));
const MAX_INPUT_BYTES = 512 * 1024 * 1024;

export interface FileUploadsProps {
  files: Files;
  setFiles: Updater<Files>;
  setData: Updater<Data>;
  onError: (message: string) => void;
}

function fileToHex(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = hexWorker();
    worker.onmessage = (event: MessageEvent<string>) => {
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(`Could not read ${file.name}: ${event.message}`));
    };
    worker.postMessage(file);
  });
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

export default function FileUploads({
  files,
  setFiles,
  setData,
  onError,
}: FileUploadsProps) {
  // The `files` object that finished loading (successfully or not). The
  // overlay shows while a populated set is still being read/parsed, and
  // must go away again after a failure, not just after success.
  const [settledFiles, setSettledFiles] = React.useState<Files | null>(null);
  const populated = isPopulatedFiles(files);
  const hasOversizedFile =
    populated &&
    fileContainers(files).some((container) => container.file.size > MAX_INPUT_BYTES);
  const isLoading = populated && !hasOversizedFile && settledFiles !== files;

  React.useEffect(() => {
    if (!isPopulatedFiles(files)) {
      return undefined;
    }
    let cancelled = false;
    onError("");

    if (
      fileContainers(files).some((container) => container.file.size > MAX_INPUT_BYTES)
    ) {
      onError("One of the selected files exceeds the 512 MiB safety limit.");
      return undefined;
    }

    if (fileContainers(files).every((container) => !container.textContent)) {
      void Promise.all([
        files.setupTxtContainer.file.text(),
        fileToHex(files.setupSctContainer.file),
        fileToHex(files.amitseSctContainer.file),
        fileToHex(files.setupdataBinContainer.file),
      ])
        .then((values) => {
          if (cancelled) return;
          setFiles((draft) => {
            draft.setupTxtContainer.textContent = values[0];
            draft.setupSctContainer.textContent = values[1];
            draft.amitseSctContainer.textContent = values[2];
            draft.setupdataBinContainer.textContent = values[3];
          });
        })
        .catch((reason: unknown) => {
          if (cancelled) return;
          onError(errorMessage(reason));
          setSettledFiles(files);
        });
    } else {
      void parseData(files)
        .then((data) => {
          if (cancelled) return;
          setData(data);
          setSettledFiles(files);
        })
        .catch((reason: unknown) => {
          if (cancelled) return;
          onError(errorMessage(reason));
          setSettledFiles(files);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [files, onError, setFiles, setData]);

  return (
    <>
      <LoadingOverlay visible={isLoading} loaderProps={{ size: "xl" }} />
      <Stack>
        <FileInput
          leftSection={<IconUpload />}
          size="lg"
          placeholder="Setup HII / SCT"
          accept=".sct,.bin"
          value={files.setupSctContainer.file}
          error={files.setupSctContainer.isWrongFile}
          onChange={(file) => {
            if (file) {
              const name = file.name.toLowerCase();

              setFiles((draft) => {
                draft.setupSctContainer = {
                  file,
                  isWrongFile: !(
                    (name.includes("setup") && name.endsWith(".sct")) ||
                    name.endsWith(".bin")
                  ),
                };
              });
            }
          }}
        />

        <FileInput
          leftSection={<IconUpload />}
          size="lg"
          placeholder="IFR Extractor output TXT(s)"
          accept=".txt"
          multiple
          value={
            files.setupTxtContainer.file
              ? [files.setupTxtContainer.file]
              : []
          }
          error={files.setupTxtContainer.isWrongFile}
          onChange={(selectedFiles) => {
            if (selectedFiles.length !== 0) {
              const sortedFiles = [...selectedFiles].sort((a, b) =>
                a.name.localeCompare(b.name, undefined, { numeric: true }),
              );
              const isWrongFile = sortedFiles.some((file) => {
                const name = file.name.toLowerCase();
                return !(name.includes("ifr") && name.endsWith(".txt"));
              });
              const combinedFile = new File(
                sortedFiles.flatMap((file) => [file, "\n"]),
                `combined-${String(sortedFiles.length)}-ifr-outputs.txt`,
                { type: "text/plain" },
              );

              setFiles((draft) => {
                draft.setupTxtContainer = {
                  file: combinedFile,
                  isWrongFile,
                };
              });
            }
          }}
        />

        <FileInput
          leftSection={<IconUpload />}
          size="lg"
          placeholder="AMITSE PE32 / SCT"
          accept=".sct,.bin"
          value={files.amitseSctContainer.file}
          error={files.amitseSctContainer.isWrongFile}
          onChange={(file) => {
            if (file) {
              const name = file.name.toLowerCase();

              setFiles((draft) => {
                draft.amitseSctContainer = {
                  file,
                  isWrongFile: !(
                    (name.includes("amitse") && name.endsWith(".sct")) ||
                    name.endsWith(".bin")
                  ),
                };
              });
            }
          }}
        />

        <FileInput
          leftSection={<IconUpload />}
          size="lg"
          placeholder="Setupdata BIN"
          accept=".bin"
          value={files.setupdataBinContainer.file}
          error={files.setupdataBinContainer.isWrongFile}
          onChange={(file) => {
            if (file) {
              const name = file.name.toLowerCase();

              setFiles((draft) => {
                draft.setupdataBinContainer = {
                  file,
                  isWrongFile: !(
                    name.includes("setupdata") && name.endsWith(".bin")
                  ),
                };
              });
            }
          }}
        />
      </Stack>
    </>
  );
}
