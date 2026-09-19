import type { AptioIvArtifacts } from "../scripts/aptioIvExtractor";
import type { AmiFirmwareGeneration } from "../scripts/amiFirmwareImage";

export interface FileContainer {
  file?: File;
  textContent?: string;
  isWrongFile: boolean;
}

// Present only when the four artifacts were extracted from a complete
// firmware image in this session (BiosImageUpload), never for the manual
// four-file mode: the retained provenance is what the root-visibility
// detector needs, and it can only come from the image itself.
export interface FirmwareSourceSession {
  fileName: string;
  artifacts: AptioIvArtifacts;
  // What the preflight concluded about the image's Aptio generation.
  generation: AmiFirmwareGeneration;
}

export interface Files {
  setupSctContainer: FileContainer;
  setupTxtContainer: FileContainer;
  amitseSctContainer: FileContainer;
  setupdataBinContainer: FileContainer;
  firmwareSource?: FirmwareSourceSession;
}

export interface PopulatedFiles {
  setupSctContainer: Required<FileContainer>;
  setupTxtContainer: Required<FileContainer>;
  amitseSctContainer: Required<FileContainer>;
  setupdataBinContainer: Required<FileContainer>;
  firmwareSource?: FirmwareSourceSession;
}
