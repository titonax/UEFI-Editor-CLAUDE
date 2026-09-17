import type { AptioIvArtifacts } from "../scripts/aptioIvExtractor";

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

export function fileContainers(files: Files): FileContainer[] {
  return [
    files.setupSctContainer,
    files.setupTxtContainer,
    files.amitseSctContainer,
    files.setupdataBinContainer,
  ];
}

export function isPopulatedFiles(files: Files): files is PopulatedFiles {
  return fileContainers(files).every(
    (container) => container.file !== undefined && !container.isWrongFile,
  );
}
