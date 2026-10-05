---
name: add-firmware-case
description: Use when the user brings a new firmware image, its corpus-runner result or a downloaded case file and wants it understood or recorded. Decides known, similar or new from the recorded cases, records a metadata-only case, and proposes a rule only when several recorded cases back it. Never commits firmware and never generalises from one image.
---

# Adding a firmware case

This project records what it has learned about firmware images as **cases**
(one observed image, metadata only) and, separately, **rules** (generalisations
backed by several cases). The structural analysers still decide what an image
is by reading it; a case or a vendor family never selects a code path. Read
`src/knowledge/README.md` first: it is the reference this skill follows.

## Ground rules

- **Never commit firmware**, and never ask for an image to be pasted into the
  repository (see "Sample intake" in `docs/aptio-iv/README.md`). A case holds
  the SHA-256, sizes, counts, stage outcomes and short codes, nothing else.
- **You do not analyse the image by hand.** The analysis runs in the browser
  (the local corpus runner) or, for four extracted files, in
  `src/components/scripts/corpusRunner.node.test.ts`. Work from what that
  produced. If the user only has the image, tell them to run it through the
  corpus runner and send you the downloaded case file or the CSV export.
- **Evidence is not fact.** Shared AMI structures are never proof of an Aptio
  generation: keep `generation: "unresolved"` unless the documented evidence
  resolves it (see `docs/ami/sample-corpus.md`). A manufacturer or vendor family
  is informational only.
- **Omit what was not observed.** An absent field means unknown. Do not fill it
  from the file name, the vendor or a similar image.
- **Never generalise from one case.** One image is a case, not a rule.

## What you may be given

1. A `<id>.json` downloaded with the **Add case** button.
2. The corpus runner CSV export (columns `knowledge` and `knowledge_case` hold
   the verdict and the case it matched) or a copy of the dashboard.
3. The text of an image's detail panel ("Closest recorded case", "Agree",
   "Differ") and the failure reason when the run failed.

## Steps

1. **Read the verdict.** The corpus runner reports one of three:
   - **Known case**: the SHA-256 is already recorded. Nothing to add. If the
     file has a new name, add it to that case's `names` instead of creating a
     second case.
   - **Similar** (`≈ N% like <id>`): no recorded case has this SHA-256, but one
     agrees on at least 80% of at least 3 comparable fields.
   - **New case**: nothing resembles it closely enough, or there was too little
     observed to compare. See `src/knowledge/corpusKnowledge.ts`.
2. **Explain the difference, not a verdict.** For a similar or new image, use
   the closest case, the fields that agree and the fields that differ with both
   values. Say where to look ("same volumes and container, different
   navigation mechanism"). Similarity is the share of comparable fields that
   agree, not a probability that the image is a given vendor or generation.
3. **Check the failure, if there was one.** A "Setup FFS was not found" that
   also says sections `could not be decoded` or buffers `were not searched` is
   a failure to investigate, not proof the image is non-AMI. Do not record such
   an image as a structurally understood non-AMI case.
4. **Record the case** (skip it when the image is already a known case):
   - Put the downloaded file at `src/knowledge/cases/<family>/<id>.json`
     (`ami-aptio` images go under `ami/`). The id is `<family>-<first 8 hex of
     the SHA-256>`. The button prints the exact path; `src/knowledge/caseFromEntry.ts`
     builds the file.
   - Keep `source: "corpus-runner"` for a case that came from the runner. Cases
     recorded from a documented table keep that document as their `source`.
   - Do not hand-edit values the runner measured. If a value is wrong, the
     analysis is what needs fixing, with a test, not the case.
5. **Validate.** Run `npm run cases:check`. It rejects unknown fields, bad
   vocabulary, text over 200 characters, two cases for one image, and a file in
   the wrong place. Then run `npm run lint`, `npm test` and `npm run build` as
   `CLAUDE.md` requires.
6. **Decide whether a rule is justified.** Only if all of these hold:
   - at least two recorded cases show the same behaviour;
   - the behaviour is implemented and has a test;
   - it is documented under `docs/`.
   Then add `src/knowledge/rules/<AREA>-<TOPIC>-<NNN>.json` (see
   `src/knowledge/ruleSchema.ts` for the evidence levels). If any of these is
   missing, do not add a rule: write the observation as a note on the case and
   say what a second case would need to show. `npm run cases:check` prints a
   warning for a rule that rests on a single case.
7. **If the image needs the analysis to change,** write the regression test
   first, from a small synthetic fixture and never from the firmware itself,
   then the smallest change that passes. Propose the change as a rule-in-waiting,
   not as `if (looks like this vendor) ...`. Run the `silent-failure-hunter` agent
   on the parsers you touched and the `binary-patch-reviewer` agent on anything
   that writes bytes.
8. **Tell the user what you did and did not do** (see below).

## Never

- Never infer the Aptio generation, the vendor logic or an editable layout from
  a single image or from a file name.
- Never turn a case into a code path ("it is an ASUS board, so use parser X").
- Never record a rule from one case, or list a case as validating a rule it was
  not documented to exhibit. Cases are linked to documented images by file name,
  so state that when you rely on it.
- Never open a PR without being asked, and never merge one.

## Report

End with a short summary the user can act on:

- **Verdict** for each image (known, similar, new) and the closest case.
- **What differs**, with both values, and what it suggests looking at.
- **What was recorded**: the case file path, or why nothing was added.
- **What was deliberately not generalised**, and what a second case would need
  to show before it could become a rule.
- **Checks run** and their result, and any limit you could not verify (for
  example that two cases may not be independent: two firmware versions of one
  board count as two cases, and only the user can judge that).
