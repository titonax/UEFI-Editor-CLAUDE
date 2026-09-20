import type {
  AmiFirmwareGeneration,
  AmiSetupLayout,
  FirmwareContainer,
} from "./amiFirmwareImage";

// The manufacturer (motherboard/system vendor) is a lead, never proof: it
// can help decide which structures to expect, including when the exact
// model is unknown, but the actual structural detectors run on every image
// regardless, and a brand match never unlocks editing/writing on its own.
// See docs/ami/manufacturer-knowledge.md for the evidence precedence this
// implements and the sample intake it is drawn from.
export const brandCatalogueVersion = "0.1.0";

export type FirmwareBrand =
  | "ASRock"
  | "ASUS"
  | "Dell"
  | "Gigabyte"
  | "HP"
  | "Intel"
  | "MSI"
  | "Supermicro";
export type BrandSignalSource =
  | "documented-hash"
  | "user-supplied"
  | "firmware-marker"
  | "filename";
export type BrandNavigation = "multi-formset-root-vector" | "single-formset-ifr-hub";

export const supportedBrands: FirmwareBrand[] = [
  "ASRock",
  "ASUS",
  "Dell",
  "Gigabyte",
  "HP",
  "Intel",
  "MSI",
  "Supermicro",
];

export interface BrandMarker {
  brand: FirmwareBrand;
  marker: string;
  offset: number;
}

export interface BrandSignal {
  brand: FirmwareBrand;
  source: BrandSignalSource;
  detail: string;
  offset?: number;
}

interface DocumentedSample {
  brand: FirmwareBrand;
  sha256: string;
  source: string;
  generation?: AmiFirmwareGeneration;
  container?: FirmwareContainer;
  layout?: AmiSetupLayout;
  navigation?: BrandNavigation;
}

export interface BrandPattern {
  mechanism: BrandNavigation;
  samples: number;
}

export interface BrandClassification {
  brand: FirmwareBrand | null;
  basis: BrandSignalSource | "conflict" | "unknown";
  signals: BrandSignal[];
  documentedSamples: number;
  observedGenerations: { generation: AmiFirmwareGeneration; samples: number }[];
  observedContainers: { container: FirmwareContainer; samples: number }[];
  observedLayouts: { layout: AmiSetupLayout; samples: number }[];
  navigationPrior: BrandPattern[];
  navigationOutcome: "unmeasured" | "matches-prior" | "new-pattern";
}

// Hashes identify the exact payloads already documented elsewhere in this
// repository (see each sample's source doc). These observations describe
// the corpus; they do not grant edit or write support on their own.
const documentedSamples: DocumentedSample[] = [
  {
    brand: "Intel",
    sha256: "12770cbddbab0fd071e91142afe6b1882c7a50c0e7b438866f6b99b5c660da64",
    source: "docs/ami/samples/intel-nuc10i5fnh-0067.md",
    container: "firmware-volume-image",
    layout: "unified-setup-formset",
    navigation: "single-formset-ifr-hub",
  },
  {
    brand: "ASUS",
    sha256: "e862e5b0fdce10e44764be6072dd5b8017544264353dbfa02c8074e0ccc15190",
    source: "docs/ami/single-formset-ifr-navigation.md",
    container: "vendor-image",
    layout: "unified-setup-formset",
    navigation: "single-formset-ifr-hub",
  },
  {
    brand: "ASUS",
    sha256: "9344b904cd319b3d385ffdf74d232a5e3999a2963cc74937af95a631a87f1454",
    source: "docs/ami/single-formset-ifr-navigation.md",
    container: "vendor-image",
    layout: "unified-setup-formset",
    navigation: "single-formset-ifr-hub",
  },
  {
    brand: "ASUS",
    sha256: "ab56462aef141f05beea299aa14fc6fb6234412cf83f59903aef15807f2be1e9",
    source: "docs/aptio-iv/samples/cross-vendor-intake.md",
    generation: "aptio-iv",
    container: "vendor-image",
  },
  {
    brand: "ASUS",
    sha256: "772c44e15c76315de3dc2f772360b643ddffe726ff6d1700d1a021cc0560aef5",
    source: "docs/aptio-iv/samples/cross-vendor-intake.md",
    generation: "aptio-iv",
    container: "vendor-image",
  },
  {
    brand: "ASUS",
    sha256: "cb71e90c3863a3d0c097d5774bf5fdd536bf4f528f679e17d27c2d1add69c6462",
    source: "docs/aptio-iv/samples/cross-vendor-intake.md",
    generation: "aptio-iv",
    container: "vendor-image",
  },
  {
    brand: "HP",
    sha256: "c13e4495042f0bda3deadf4d110bf241cdeb6679153cde001b24e7e337b4e2c1",
    source: "docs/aptio-iv/samples/hp-server-l01-0278.md",
    generation: "aptio-iv",
    container: "intel-flash",
    layout: "split-form-packages",
  },
  {
    brand: "HP",
    sha256: "6d18c962f3ffa6b941ada4e6fa71be4cdf1e7ff8297f5f4a4b73e29969f350a9",
    source: "docs/aptio-iv/samples/hp-ipisb-ch2-w25q32.md",
    generation: "aptio-iv",
    container: "intel-flash",
    layout: "split-form-packages",
  },
  {
    brand: "HP",
    sha256: "c0a18c739897fcc0ee428802272c566ec49014b6074aadf0c55fdb5513e816ff",
    source: "docs/aptio-iv/samples/hp-boa-8005.md",
    generation: "aptio-iv",
    container: "firmware-volume-image",
    layout: "split-form-packages",
  },
  {
    brand: "MSI",
    sha256: "49593660b086ae48a3c968286e68c4b8e7e13e934483776b13802f3de4e3b330",
    source: "docs/aptio-iv/samples/cross-vendor-intake.md",
    generation: "aptio-iv",
    container: "intel-flash",
  },
  {
    brand: "MSI",
    sha256: "cebd6ec82bdd73b3dd953f981cd084efb789f52bc2481a9bfd242b5693b5e6ba",
    source: "docs/aptio-iv/samples/cross-vendor-intake.md",
    generation: "aptio-iv",
    container: "vendor-image",
  },
  {
    brand: "ASRock",
    sha256: "3bddf9d2f6d86e8102be4bb2cd54c49876349859c0d50a7cb7aaa7eec6870761",
    source: "docs/aptio-iv/samples/cross-vendor-intake.md",
    container: "intel-flash",
  },
  {
    brand: "Supermicro",
    sha256: "3b4f01b4fb3361bf0ed8fe290225303172a72bb3ce479e83ca28c0bcff5d5b9c",
    source: "docs/aptio-iv/samples/supermicro-x9dr3-if-34.md",
    generation: "aptio-iv",
    container: "intel-flash",
  },
];

const filenameBrands: { brand: FirmwareBrand; pattern: RegExp }[] = [
  { brand: "Intel", pattern: /(?:^|[^a-z0-9])(?:intel|fncml357)(?:[^a-z0-9]|$)/i },
  { brand: "ASUS", pattern: /(?:^|[^a-z])(?:asus|asustek)(?:[^a-z]|$)/i },
  { brand: "HP", pattern: /(?:^|[^a-z])(?:hp|hewlett.packard)(?:[^a-z]|$)/i },
  { brand: "MSI", pattern: /(?:^|[^a-z])(?:msi|micro.star)(?:[^a-z]|$)/i },
  { brand: "ASRock", pattern: /(?:^|[^a-z])asrock(?:[^a-z]|$)/i },
  { brand: "Supermicro", pattern: /(?:^|[^a-z])supermicro(?:[^a-z]|$)/i },
  { brand: "Gigabyte", pattern: /(?:^|[^a-z])gigabyte(?:[^a-z]|$)/i },
  { brand: "Dell", pattern: /(?:^|[^a-z])dell(?:[^a-z]|$)/i },
];

function counts<T extends string>(values: T[]) {
  const counted = new Map<T, number>();
  for (const value of values) counted.set(value, (counted.get(value) ?? 0) + 1);
  return [...counted].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
}

// Evidence precedence: an exact SHA-256 match to a documented sample beats
// an explicit user selection, which beats a firmware-marker byte match,
// which beats a filename token - and disagreement at the strongest
// available level leaves the brand unresolved rather than guessed.
export function classifyBrand(
  fileName: string,
  sha256: string,
  markers: BrandMarker[],
  declaredBrand?: FirmwareBrand,
): BrandClassification {
  const documented = documentedSamples.find(
    (sample) => sample.sha256 === sha256.toLowerCase(),
  );
  const signals: BrandSignal[] = [
    ...(documented
      ? [
          {
            brand: documented.brand,
            source: "documented-hash" as const,
            detail: `Exact SHA-256 in ${documented.source}`,
          },
        ]
      : []),
    ...(declaredBrand
      ? [
          {
            brand: declaredBrand,
            source: "user-supplied" as const,
            detail: "Manufacturer selected for this input",
          },
        ]
      : []),
    ...markers.map((marker) => ({
      brand: marker.brand,
      source: "firmware-marker" as const,
      detail: marker.marker,
      offset: marker.offset,
    })),
    ...filenameBrands
      .filter((entry) => entry.pattern.test(fileName))
      .map((entry) => ({
        brand: entry.brand,
        source: "filename" as const,
        detail: `Brand token in filename ${fileName}`,
      })),
  ];
  const highest = documented
    ? "documented-hash"
    : declaredBrand
      ? "user-supplied"
      : markers.length > 0
        ? "firmware-marker"
        : signals.length > 0
          ? "filename"
          : "unknown";
  const candidates = [
    ...new Set(signals.filter((signal) => signal.source === highest).map((s) => s.brand)),
  ];
  const brand = candidates.length === 1 ? candidates[0] : null;
  const basis = candidates.length > 1 ? "conflict" : highest;
  const observations = documentedSamples.filter((sample) => sample.brand === brand);
  return {
    brand,
    basis,
    signals,
    documentedSamples: observations.length,
    observedGenerations: counts(
      observations.flatMap((sample) => (sample.generation ? [sample.generation] : [])),
    ).map(([generation, samples]) => ({ generation, samples })),
    observedContainers: counts(
      observations.flatMap((sample) => (sample.container ? [sample.container] : [])),
    ).map(([container, samples]) => ({ container, samples })),
    observedLayouts: counts(
      observations.flatMap((sample) => (sample.layout ? [sample.layout] : [])),
    ).map(([layout, samples]) => ({ layout, samples })),
    navigationPrior: counts(
      observations.flatMap((sample) => (sample.navigation ? [sample.navigation] : [])),
    ).map(([mechanism, samples]) => ({ mechanism, samples })),
    navigationOutcome: "unmeasured",
  };
}

// Compares this image's actually-proven navigation mechanism(s) against the
// brand's documented prior - a lead confirmed or a genuinely new pattern
// worth documenting, never a reason to prefer the prior over the evidence.
export function compareBrandNavigation(
  classification: BrandClassification,
  observed: (BrandNavigation | "unresolved")[],
): BrandClassification {
  const known = observed.filter(
    (mechanism): mechanism is BrandNavigation => mechanism !== "unresolved",
  );
  if (classification.navigationPrior.length === 0 || known.length === 0) {
    return classification;
  }
  const predicted = new Set(classification.navigationPrior.map((item) => item.mechanism));
  return {
    ...classification,
    navigationOutcome: known.every((mechanism) => predicted.has(mechanism))
      ? "matches-prior"
      : "new-pattern",
  };
}
