import { Button, FileButton, Group, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconDownload, IconUpload } from "@tabler/icons-react";
import { saveAs } from "file-saver";
import React from "react";
import type { Updater } from "use-immer";
import type { PopulatedFiles } from "../FileUploads/fileModel";
import { assertAmiRootVisibilityEditsMatch } from "../scripts/amiRootVisibilityEditing";
import { downloadModifiedFiles, validateByteInput } from "../scripts/binaryPatcher";
import { parseDataFile } from "../scripts/dataValidation";
import { refreshSingleFormSetNavigation } from "../scripts/singleFormSetNavigation";
import { calculateJsonChecksum } from "../scripts/hashing";
import { version } from "../scripts/ifrParser";
import type { Data, Suppression } from "../scripts/types";
import s from "./Footer.module.css";

interface FooterProps {
  files: PopulatedFiles;
  data: Data;
  setData: Updater<Data>;
  currentFormIndex: number;
}

export default function Footer({
  files,
  currentFormIndex,
  data,
  setData,
}: FooterProps) {
  const resetRef = React.useRef<() => void>(null);
  const [input, setInput] = React.useState("05");

  return (
    <div className={s.root}>
      <Group justify="space-between" gap={"xs"} className={s.maxWidth}>
        <Group gap={"xs"}>
          <FileButton
            resetRef={resetRef}
            accept=".json"
            onChange={(file) => {
              if (file) {
                void (async () => {
                  try {
                    const jsonData = parseDataFile(await file.text());

                    if (
                      jsonData.version === version &&
                      jsonData.hashes.setupTxt === data.hashes.setupTxt &&
                      jsonData.hashes.setupSct === data.hashes.setupSct &&
                      jsonData.hashes.amitseSct === data.hashes.amitseSct &&
                      jsonData.hashes.setupdataBin ===
                        data.hashes.setupdataBin &&
                      (await calculateJsonChecksum(
                        jsonData.menu,
                        jsonData.forms,
                        jsonData.suppressions,
                      )) === data.hashes.offsetChecksum
                    ) {
                      // The root vector is evidence about the firmware that
                      // is open right now, never trusted from a file; a saved
                      // plan is kept only if it still matches that evidence.
                      jsonData.rootVisibility = data.rootVisibility;
                      assertAmiRootVisibilityEditsMatch(
                        jsonData.rootVisibilityEdits,
                        jsonData.rootVisibility,
                      );
                      // Same for the single-FormSet tab inventory: rebuilt
                      // from the imported graph with the open firmware's
                      // AMITSE evidence, never taken from the file.
                      refreshSingleFormSetNavigation(
                        jsonData,
                        data.singleFormSetNavigation,
                      );
                      setData(jsonData);
                    } else {
                      notifications.show({
                        color: "red",
                        title: "Could not load data.json",
                        message:
                          "Wrong data.json version, source hashes, or offset checksum.",
                      });
                    }
                  } catch (error) {
                    notifications.show({
                      color: "red",
                      title: "Could not load data.json",
                      message:
                        error instanceof Error
                          ? error.message
                          : String(error),
                    });
                  } finally {
                    resetRef.current?.();
                  }
                })();
              }
            }}
          >
            {(props) => (
              <Button
                {...props}
                size="xs"
                leftSection={<IconUpload />}
                variant="default"
              >
                data.json
              </Button>
            )}
          </FileButton>

          <Button
            size="xs"
            variant="default"
            leftSection={<IconDownload />}
            onClick={() => {
              saveAs(
                new Blob([JSON.stringify(data, null, 2)], {
                  type: "text/plain",
                }),
                "data.json",
              );
            }}
          >
            data.json
          </Button>

          <Button
            size="xs"
            variant="default"
            leftSection={<IconDownload />}
            // Extracted-file patches are what the user reinserts with
            // UEFITool themselves, whatever the generation; only a complete
            // image lacks that path, since the modified Setup module cannot
            // be put back into the image it came from yet.
            disabled={
              files.firmwareSource !== undefined ||
              (data.rootVisibilityEdits?.length ?? 0) > 0
            }
            title={
              (data.rootVisibilityEdits?.length ?? 0) > 0
                ? "Root visibility changes require the verified full-image reconstruction path"
                : files.firmwareSource !== undefined
                  ? "Exporting extracted files from a complete image is disabled until safe reinsertion is implemented; keep your edits with data.json"
                  : undefined
            }
            onClick={() => {
              try {
                const result = downloadModifiedFiles(data, files);
                if (result.status === "no-changes") {
                  notifications.show({
                    color: "blue",
                    title: "Nothing to download",
                    message: "No modifications have been done.",
                  });
                }
              } catch (error) {
                notifications.show({
                  color: "red",
                  title: "Could not generate the UEFI files",
                  message:
                    error instanceof Error ? error.message : String(error),
                });
              }
            }}
          >
            UEFI files
          </Button>
        </Group>

        {currentFormIndex >= 0 && (
          <Group gap={"xs"}>
            <Button
              size="xs"
              variant="default"
              onClick={() => {
                setData((draft) => {
                  for (const child of data.forms[currentFormIndex].children) {
                    if (child.suppressIf) {
                      for (const suppressionOffset of child.suppressIf) {
                        (
                          draft.suppressions.find(
                            (suppression) =>
                              suppression.offset === suppressionOffset,
                          ) as Suppression
                        ).active = false;
                      }
                    }
                  }
                });
              }}
            >
              Unsuppress all Items in this Form
            </Button>

            <Button
              size="xs"
              variant="default"
              onClick={() => {
                setData((draft) => {
                  for (const child of draft.forms[currentFormIndex].children) {
                    if (child.accessLevel !== null) {
                      child.accessLevel = input;
                    }
                  }
                });
              }}
            >
              Change all Access Levels in this Form to
            </Button>

            <TextInput
              className={s.textInput}
              size="xs"
              value={input}
              onChange={(ev) => {
                const value = ev.target.value.toUpperCase();

                if (validateByteInput(value)) {
                  setInput(value);
                }
              }}
            />
          </Group>
        )}
      </Group>
    </div>
  );
}
