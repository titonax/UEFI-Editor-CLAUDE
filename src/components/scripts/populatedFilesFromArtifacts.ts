import type { AptioIvArtifacts } from "./aptioIvExtractor";
import type { AmiFirmwareGeneration } from "./amiFirmwareImage";
import type { PopulatedFiles } from "../FileUploads/fileModel";

export function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) =>
    byte.toString(16).toUpperCase().padStart(2, "0"),
  ).join("");
}

// The shared step from a full-image extraction's AptioIvArtifacts to the
// PopulatedFiles shape the rest of the app (parseData, the editor,
// downloadModifiedFiles) works with - used by BiosImageUpload.tsx for the
// single firmware a session actually edits, and by CorpusRunner.tsx for
// every firmware in a local batch run.
export function buildPopulatedFilesFromArtifacts(
  artifacts: AptioIvArtifacts,
  fileName: string,
  generation: AmiFirmwareGeneration,
): PopulatedFiles {
  const amitseBytes = artifacts.amitse ?? new Uint8Array();
  const setupDataBytes = artifacts.setupData ?? new Uint8Array();
  return {
    setupSctContainer: {
      file: new File([artifacts.hii], "setup-ami-aptio.bin"),
      textContent: toHex(artifacts.hii),
      isWrongFile: false,
    },
    setupTxtContainer: {
      file: new File([artifacts.ifrText], "setup-ami-aptio.ifr.txt", {
        type: "text/plain",
      }),
      textContent: artifacts.ifrText,
      isWrongFile: false,
    },
    amitseSctContainer: {
      file: new File([amitseBytes], "amitse-ami-aptio.bin"),
      textContent: toHex(amitseBytes),
      isWrongFile: false,
    },
    setupdataBinContainer: {
      file: new File([setupDataBytes], "setupdata-ami-aptio.bin"),
      textContent: toHex(setupDataBytes),
      isWrongFile: false,
    },
    firmwareSource: { fileName, artifacts, generation },
  };
}
