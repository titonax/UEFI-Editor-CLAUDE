import { type PopulatedFiles } from "../FileUploads/fileModel";
import { inspectAmiRootVisibility } from "./amiRootVisibility";
import { calculateJsonChecksum, hashFile } from "./hashing";
import { sameGuidOrBothUndefined, sameHexId } from "./hexId";
import { decToHexString } from "./binaryPatcher";
import { inspectSingleFormSetNavigation, singleFormSetHubMenu } from "./singleFormSetNavigation";
import { type Data, type Menu } from "./types";
import { enrichConditions } from "./ifrConditions";
import { formReferenceKey, parseSetupTxt } from "./ifrLineParser";

export const version = "0.5.0";

const wantedIFRExtractorVersions = ["1.6.1"];


function reversedHexBytes(value: string) {
  return value.match(/../g)?.reverse().join("") ?? "";
}


function guidToUefiHex(value: string) {
  const parts = value.split("-");
  if (parts.length !== 5) {
    return "";
  }
  return (
    reversedHexBytes(parts[0]) +
    reversedHexBytes(parts[1]) +
    reversedHexBytes(parts[2]) +
    parts[3] +
    parts[4]
  ).toUpperCase();
}


function littleEndianUint32(value: string) {
  const normalized = reversedHexBytes(value);
  return normalized.length === 8 ? parseInt(normalized, 16) : Number.NaN;
}


function discoverSetupDataMenu(formSetRoots: Menu, setupData: string): Menu {
  const normalizedSetupData = setupData.toUpperCase();
  const candidates: {
    entry: Menu[number];
    start: number;
    pageValue: number;
  }[] = [];

  for (const entry of formSetRoots) {
    if (!entry.formSetGuid) {
      continue;
    }
    const encodedGuid = guidToUefiHex(entry.formSetGuid);
    let guidIndex = normalizedSetupData.indexOf(encodedGuid);
    while (guidIndex !== -1) {
      if (guidIndex >= 8) {
        const start = guidIndex - 8;
        const pageValue = littleEndianUint32(
          normalizedSetupData.slice(start, guidIndex),
        );
        if (Number.isSafeInteger(pageValue)) {
          candidates.push({ entry, start, pageValue });
        }
      }
      guidIndex = normalizedSetupData.indexOf(encodedGuid, guidIndex + 2);
    }
  }

  // Each page-list slot is a fixed-width (20-byte, 40 hex-char) record, but
  // not every slot names a FormSet this dump's formSetRoots recognizes - a
  // real HP image (IPISB-CH2) has one unidentified slot in the middle of an
  // otherwise-regular 11-entry list, which only ever shows up here as a gap
  // of exactly one record width too many. Requiring an exact +40 between
  // consecutive candidates split that single list into a run of 5 and a run
  // of 6 and kept only the longer one, silently dropping the other 5 roots.
  // A small positive multiple of the stride still belongs to the same list
  // - it just skips over a slot or two this scan has no candidate for - so
  // runs merge across those gaps instead of breaking there. The tolerance
  // stays small on purpose: several other real images (E7752IMS, K01_0308,
  // K56CBAS, SABERTOOTH-Z97) have a single unrelated, coincidental GUID hit
  // (from some other SetupData structure, not the page list) that happens
  // to land tens or hundreds of stride-widths before or after the real
  // list - accepting large multiples merges that noise straight into the
  // result as a spurious extra root.
  const PAGE_LIST_RECORD_STRIDE = 40;
  const MAX_PAGE_LIST_GAP_MULTIPLE = 3;
  candidates.sort((left, right) => left.start - right.start);
  const runs: (typeof candidates)[] = [];
  for (const candidate of candidates) {
    if (runs.length === 0) {
      runs.push([candidate]);
      continue;
    }
    const current = runs[runs.length - 1];
    const previous = current[current.length - 1];
    const gap = candidate.start - previous.start;
    if (
      gap > 0 &&
      gap % PAGE_LIST_RECORD_STRIDE === 0 &&
      gap / PAGE_LIST_RECORD_STRIDE <= MAX_PAGE_LIST_GAP_MULTIPLE
    ) {
      current.push(candidate);
    } else {
      runs.push([candidate]);
    }
  }

  if (runs.length === 0) {
    return [];
  }
  const pageList = runs.sort((left, right) => right.length - left.length)[0];
  if (pageList.length < 3) {
    return [];
  }

  return pageList.map(({ entry, start, pageValue }) => ({
    ...entry,
    offset: null,
    source: "setupdata",
    pageMask: decToHexString(pageValue),
    pageInfoOffset: decToHexString(start / 2),
  }));
}


export interface FrameworkIfrInventory {
  formSets: number;
  forms: number;
  references: number;
}


// IFRExtractor-RS's verbose output for legacy EFI 1.10 "Framework" HII
// prints its own line labels ("FormSet Title:"/"Form Title:"/"Ref Prompt:"),
// distinct from the UEFI-mode ones parseData otherwise reads. This editor
// never parses Framework IFR (see parseData's "Only UEFI is supported."
// check below), but a rough read-only count is still useful evidence to
// report instead of a bare rejection - see legacyFrameworkHiiGuess in
// amiFirmwareImage.ts.
export function frameworkIfrInventory(text: string): FrameworkIfrInventory {
  return {
    formSets: (text.match(/^0x[0-9a-f]+:\s*FormSet Title:/gim) ?? []).length,
    forms: (text.match(/^0x[0-9a-f]+:\s*Form Title:/gim) ?? []).length,
    references: (text.match(/^0x[0-9a-f]+:\s*Ref Prompt:/gim) ?? []).length,
  };
}


export async function parseData(files: PopulatedFiles) {
  const [setupTxtHash, setupSctHash, amitseSctHash, setupdataBinHash] =
    await Promise.all([
      hashFile(files.setupTxtContainer.file),
      hashFile(files.setupSctContainer.file),
      hashFile(files.amitseSctContainer.file),
      hashFile(files.setupdataBinContainer.file),
    ]);

  let setupTxt = files.setupTxtContainer.textContent;
  const amitseSct = files.amitseSctContainer.textContent;
  const setupdataBin = files.setupdataBinContainer.textContent;

  if (
    !wantedIFRExtractorVersions.some((version) =>
      setupTxt.includes(`Program version: ${version}`),
    )
  ) {
    throw new Error(
      `Wrong IFRExtractor-RS version. Compatible versions: ${wantedIFRExtractorVersions.join(
        ", ",
      )}.`,
    );
  }

  if (!setupTxt.includes("Extraction mode: UEFI")) {
    throw new Error("Only UEFI is supported.");
  }

  if (!/\{ .* \}/.test(setupTxt)) {
    throw new Error(`Use the "verbose" option of IFRExtractor.`);
  }

  if (!setupTxt.includes(`SHA256: ${setupSctHash}`)) {
    throw new Error("Setup SCT and IFR Extractor output TXT SHA256 mismatch");
  }

  setupTxt = setupTxt.replace(/[\r\n](?!0x[0-9A-F]{3})/g, "<br>");

  const {
    formSetIds,
    formSetMetadata,
    formSetRoots,
    varStores,
    forms,
    suppressions,
    references,
  } = parseSetupTxt(setupTxt, setupdataBin);

  enrichConditions(forms, varStores, suppressions);

  const matches = [...formSetIds].flatMap((formSetId) =>
    [...amitseSct.matchAll(new RegExp(formSetId + "(.{4})", "gi"))].map(
      (match) => ({ match, formSetId }),
    ),
  );
  // An AMITSE table entry names a FormSet and a FormId; only a Form with
  // that FormId inside that very FormSet counts. A same-numbered Form in
  // another FormSet is a different page, and inventing an entry from the
  // FormSet's title alone would claim a root that no Form backs.
  const discoveredMenu: Menu = matches.flatMap(({ match, formSetId }) => {
    const hexEntry = decToHexString(
      parseInt(match[1].slice(2) + match[1].slice(0, 2), 16),
    );
    const formSet = formSetMetadata.get(formSetId);
    const matchedForm = formSet
      ? forms.find(
          (form) =>
            sameGuidOrBothUndefined(form.formSetGuid, formSet.guid) &&
            sameHexId(form.formId, hexEntry),
        )
      : undefined;
    if (!formSet || !matchedForm) {
      return [];
    }
    return [
      {
        name: matchedForm.name,
        formId: hexEntry,
        offset: decToHexString((match.index + formSetId.length) / 2),
        formSetGuid: formSet.guid,
        source: "amitse" as const,
      },
    ];
  });
  // The AMITSE entry whose FormId a SetupData root rewrites at export. One
  // entry for the FormSet is unambiguous. When the FormSet is registered more
  // than once, only an entry for the root's own Form qualifies, and it must
  // be the only one: picking the first hit would let an edit overwrite
  // another page's slot, so an ambiguous root gets no offset instead.
  const amitseOffsetFor = (entry: Menu[number]) => {
    const sameFormSet = discoveredMenu.filter(
      (candidate) =>
        candidate.formSetGuid?.toLowerCase() === entry.formSetGuid?.toLowerCase(),
    );
    if (sameFormSet.length <= 1) {
      return sameFormSet[0]?.offset ?? null;
    }
    const sameForm = sameFormSet.filter((candidate) =>
      sameHexId(candidate.formId, entry.formId),
    );
    return sameForm.length === 1 ? sameForm[0].offset : null;
  };
  const setupDataMenu = discoverSetupDataMenu(formSetRoots, setupdataBin).map(
    (entry) => ({
      ...entry,
      offset: amitseOffsetFor(entry),
    }),
  );
  // A single FormSet whose entry Form fans out into the tabs is its own
  // menu: the hub is the only root and its direct Refs are the tabs, so the
  // AMITSE table and SetupData page list only serve as corroboration there.
  const singleFormSetNavigation = inspectSingleFormSetNavigation(
    formSetRoots,
    forms,
    discoveredMenu,
    undefined,
    suppressions,
  );
  const hubMenu = singleFormSetHubMenu(singleFormSetNavigation);
  const menu =
    hubMenu.length > 0
      ? hubMenu
      : setupDataMenu.length > 0
        ? setupDataMenu
        : discoveredMenu.length > 0
          ? discoveredMenu
          : formSetRoots;

  for (const form of forms) {
    const referenceKey = formReferenceKey(form.formId, form.formSetGuid);
    if (referenceKey in references) {
      form.referencedIn = [...references[referenceKey]];
    }
  }

  const dataJson: Data = {
    // Four extracted files carry no evidence of the Aptio generation (a
    // "$SPF" SetupData profile is shared by IV and V boards alike); a
    // complete-image session overrides this from its preflight.
    firmwareFamily: "ami-aptio",
    menu,
    formSetRoots,
    forms,
    varStores,
    suppressions,
    // The root byte vector lives in the Setup PE32 inside the image, so it
    // can only be looked for when the image itself was opened.
    rootVisibility: files.firmwareSource
      ? inspectAmiRootVisibility(formSetRoots, files.firmwareSource.artifacts.provenance)
      : undefined,
    singleFormSetNavigation,
    version,
    hashes: {
      setupTxt: setupTxtHash,
      setupSct: setupSctHash,
      amitseSct: amitseSctHash,
      setupdataBin: setupdataBinHash,
      offsetChecksum: await calculateJsonChecksum(menu, forms, suppressions),
    },
  };

  return dataJson;
}
