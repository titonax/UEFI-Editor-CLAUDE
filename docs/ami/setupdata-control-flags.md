# AMI SetupData control flags

## The byte, and what it is not

Every HII question with a SetupData record carries a byte at record offset
+16 that this editor (like the upstream one) exposes as **Access Level**. It
is a flag byte, not a level, but no bit's meaning is established.

An earlier version of this document and of `setupDataFlags.ts` read bit 0 as
the AMITSE control-flag layout's own visibility switch - the one AMIBCP
presents as Show/Hide - and had the editor report a clear bit 0 as
"Hidden by SetupData flags". That reading has been withdrawn after testing
it against 14 images from five vendors and two Aptio generations.

## The corpus

| Image | Board / family | Aptio | Records |
| --- | --- | --- | --- |
| `IPISBCH2W25Q32_20170616_155538.BIN` | HP IPISB-CH2 | IV | 584 |
| `PRIME-Z370-P-ASUS-3004.CAP` | ASUS PRIME Z370-P | V | 4,263 |
| `ROG-STRIX-Z390-E-GAMING-ASUS-2203.CAP` | ASUS ROG STRIX Z390-E | V | 4,611 |
| `FNCML357.0067.CAP` | Intel NUC 10 | V | 4,014 |
| `BIOS_H12SSL-1B95_20260513_3.7_STDsp.bin` | Supermicro H12SSL | V | 716 |
| `E7B09AMS.1C0` / `.1D9` | Gigabyte (AM5) | V | 948 / 953 |
| `X399AG7.F12`, `X399AORUSGaming7.F13d`, `X399TC3.90`, `X399TC4.03` | Gigabyte X399 (four boards) | V | 573–663 each |
| `image1.bin`, `image2.bin`, `image3.bin` | (unlabeled Aptio V, intel-flash) | V | ~3,835 each |

33,551 matched question records total.

## Why the Show/Hide reading does not hold up

1. **It never fires.** Bit 0 is set on all 33,551 records; there is no
   counter-example anywhere in the corpus, across five vendors.
2. **It does not separate a known case either way.** The Intel NUC 10 image
   has five AMI reference pages under its `Setup` hub: four are always
   hidden by a constant-true `SuppressIf` and one (`Main`, `0x271B`) carries
   no hide at all. Neither bit 0 (set on both groups, no exceptions) nor any
   other record byte with non-degenerate variance (offsets 4, 8, 22, 30, 44,
   46 - checked because they show small, low-cardinality value sets rather
   than per-question identifiers) separates the hidden group from the
   visible one. Those bytes instead track the control's own type or kind:
   offset 30, for instance, takes value `0x02` for 298 of the 343 records in
   the visible Intel pages and also for the majority of the records checked
   elsewhere, tracking alongside offset 8's value `0x0B` rather than with
   any hidden/visible split.

A record's own "this slot is populated" marker is at least as good a
reading of a bit that is unconditionally set: every question the IFR
compiler emits presumably gets a SetupData record regardless of whether
anything currently hides it. Nothing in the corpus distinguishes the two
readings, so neither is reported as a verdict.

## What is actually known

| Value | Count | Bits set |
| --- | ---: | --- |
| 0x09 | 21,956 | 0, 3 |
| 0x01 | 8,751 | 0 |
| 0x29 | 2,182 | 0, 3, 5 |
| 0x21 | 625 | 0, 5 |
| 0x49 | 35 | 0, 3, 6 |
| 0x41 | 1 | 0, 6 |
| 0x11 | 1 | 0, 4 |

- **Bit 0**: always set (see above).
- **Bit 3**: set on interactive questions (OneOf, CheckBox, most Numerics),
  never on a plain page `Ref`. Corroborated only by this co-occurrence, not
  by any visibility check.
- **Bit 5**: appears on items with dynamic content - HDD security entries,
  Secure Boot state and key actions, System Information, fan tuning,
  storage ports, OC profiles - across several boards. Same caveat as bit 3.
- **Bits 4 and 6**: one occurrence each in the whole corpus (a Secure Boot
  mode selector and a GT power option), with no interpretation at all.

## Page records

SetupData also holds one page record per Form (24-byte header, then the
byte offsets of its own controls): `handle, formId, parent, title token,
pageId, parentPageId, …, control count`. This is a different structure from
the per-question record above and was not part of this investigation beyond
confirming, in the NUC image, that the four always-hidden AMI reference
pages have ordinary page records identical in shape to the visible ones -
nothing there flags them as hidden either.

## What the editor does with it

- `decodeControlFlags()` / `describeControlFlags()` in `setupDataFlags.ts`
  are purely informational: they report which bits are set, nothing more.
  The Access Level field's tooltip shows this.
- `childVisibility()` no longer derives a status from this byte. Item
  visibility is IFR-only (`SuppressIf`/`GrayOutIf`/`DisableIf`); a page
  AMIBCP would show as hidden through a constant-true `SuppressIf` is
  exactly the case this editor already supports forcing visible.
- Editing the byte is still the existing Access Level field; export patches
  the same byte it always did. Nothing here changes what gets written.

Revisiting this needs a firmware image with a record whose bit 0 actually
clears, ideally paired with independent knowledge (from AMIBCP or the OEM)
of which of its items are hidden.
