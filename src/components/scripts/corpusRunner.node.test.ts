import { describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseData } from "./ifrParser";
import { buildCorpusReport, summarizeCorpusReports, type CorpusReport } from "./corpusReport";
import type { PopulatedFiles } from "../FileUploads/fileModel";

// A repeatable regression runner over a local corpus of real firmware
// extracts. Never commits firmware: point CORPUS_DIR at a directory
// outside the repo holding one subdirectory per image, each with the four
// files this app's own "Four separate files" manual mode already accepts
// (see README.md). Skips cleanly - reports nothing, fails nothing - when
// CORPUS_DIR isn't set, so normal `npm test`/CI runs are unaffected: this
// is a tool a contributor runs on demand against their own local samples,
// not part of the committed regression suite itself.
//
// Usage:
//   CORPUS_DIR=/path/to/corpus npx vitest run src/components/scripts/corpusRunner.node.test.ts
//   CORPUS_OUT defaults to <CORPUS_DIR>/reports; set it to write elsewhere.
//
// Each <CORPUS_DIR>/<image-name>/ subdirectory must contain:
//   setup.sct       - the Setup module's PE32/SCT section (binary)
//   amitse.sct      - the AMITSE module's PE32/SCT section (binary)
//   setupdata.bin   - the SetupData freeform section body (binary)
//   setup.ifr.txt   - IFRExtractor-RS `verbose` output for setup.sct

const CORPUS_DIR = process.env.CORPUS_DIR;

// A real corpus can hold dozens of multi-megabyte HII dumps; the default
// 5s per-test timeout is sized for unit tests, not this.
const RUNNER_TIMEOUT_MS = 10 * 60 * 1000;

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join("");
}

function buildFiles(dir: string): PopulatedFiles {
  const hii = new Uint8Array(readFileSync(path.join(dir, "setup.sct")));
  const amitse = new Uint8Array(readFileSync(path.join(dir, "amitse.sct")));
  const setupData = new Uint8Array(readFileSync(path.join(dir, "setupdata.bin")));
  const ifrTxt = readFileSync(path.join(dir, "setup.ifr.txt"), "utf-8");
  return {
    setupSctContainer: { file: new File([hii], "Setup.sct"), textContent: toHex(hii), isWrongFile: false },
    setupTxtContainer: { file: new File([ifrTxt], "setup.ifr.txt"), textContent: ifrTxt, isWrongFile: false },
    amitseSctContainer: {
      file: new File([amitse], "AmiTseSct.sct"),
      textContent: toHex(amitse),
      isWrongFile: false,
    },
    setupdataBinContainer: {
      file: new File([setupData], "SetupData.bin"),
      textContent: toHex(setupData),
      isWrongFile: false,
    },
  };
}

describe.skipIf(!CORPUS_DIR)("local corpus regression runner", () => {
  it(
    "parses and classifies every image under CORPUS_DIR, writing one report each",
    async () => {
      if (!CORPUS_DIR) return;
      const corpusDir = CORPUS_DIR;
      const outDir = process.env.CORPUS_OUT ?? path.join(corpusDir, "reports");

      const images = readdirSync(corpusDir).filter(
        (entry) => statSync(path.join(corpusDir, entry)).isDirectory() && entry !== "reports",
      );
      expect(images.length, `no image subdirectories found under ${corpusDir}`).toBeGreaterThan(0);

      const reports: CorpusReport[] = [];
      const failures: { label: string; error: string }[] = [];

      for (const image of images) {
        try {
          const files = buildFiles(path.join(corpusDir, image));
          const data = await parseData(files);
          reports.push(buildCorpusReport(data, image));
        } catch (error) {
          failures.push({
            label: image,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const summary =
        summarizeCorpusReports(reports) +
        (failures.length > 0
          ? `\n\nFailed to parse:\n${failures
              .map((failure) => `${failure.label}: ${failure.error}`)
              .join("\n")}`
          : "");

      mkdirSync(outDir, { recursive: true });
      for (const report of reports) {
        writeFileSync(path.join(outDir, `${report.label}.json`), JSON.stringify(report, null, 2));
      }
      writeFileSync(path.join(outDir, "summary.txt"), summary);

      console.log(summary);

      expect(
        failures,
        `${String(failures.length)} image(s) failed to parse - see log above`,
      ).toEqual([]);
    },
    RUNNER_TIMEOUT_MS,
  );
});
