// The AMI SetupData byte this app has always exposed as "Access Level" (see
// setupData.ts, record offset +16) is a control flag byte, not a level.
//
// Across 14 reference images (HP IPISB-CH2, ASUS PRIME Z370-P and ROG
// STRIX Z390-E, Intel NUC 10 FNCML357, Supermicro H12SSL, Gigabyte
// E7B09AMS x2, Gigabyte X399 AORUS/Designare/Taichi x4, and three more
// Aptio V images) it takes only 0x01, 0x09, 0x11, 0x21, 0x29, 0x41 and
// 0x49, over 33,551 matched records:
//
//   value  count   bits set
//   0x09   21,956  0,3
//   0x01    8,751  0
//   0x29    2,182  0,3,5
//   0x21      625  0,5
//   0x49       35  0,3,6
//   0x41        1  0,6
//   0x11        1  0,4
//
// Bit 0 is set on every single record - no counter-example anywhere in the
// corpus. An earlier version of this file read that as the AMITSE
// control-flag layout's own visibility bit (AMIBCP's Show/Hide switch) and
// reported a clear bit 0 as a SetupData-level hide. Two things argue
// against that reading and it has been withdrawn:
//
// 1. It never fires: not one of 33,551 records clears it, across boards
//    from five different vendors and two Aptio generations.
// 2. It does not separate known cases either way. The Intel NUC 10 image
//    has five AMI reference pages under the Setup hub, four of them always
//    hidden by a constant-true SuppressIf and one with no hide at all; none
//    of bit 0 (always set) or any other record byte checked (offsets 4, 8,
//    22, 30, 44, 46 - the only ones with non-degenerate, non-identifier-
//    like variance) separates the hidden group from the visible one. Those
//    bytes instead track the control's own type/kind, not its page's
//    visibility.
//
// A record's own "valid entry" marker is at least as plausible a reading
// of a bit that is unconditionally set on every anchor-matched record:
// every question the IFR compiler emits presumably gets a populated
// SetupData record regardless of whether anything currently hides it, so
// bit 0 could just mean "this slot is in use." Nothing in the corpus
// distinguishes the two readings.
//
// Bits 3 (interactive questions - OneOf/CheckBox/Numeric - never a plain
// Ref) and 5 (items with dynamic content: HDD security entries, Secure
// Boot state and key actions, System Information, fan tuning, storage
// ports, OC profiles) are corroborated only by co-occurrence with control
// type, not by any visibility check, and bits 4 and 6 are single
// occurrences with no interpretation at all. None of this is exposed as a
// verdict; decodeControlFlags is purely informational.

export interface SetupDataControlFlags {
  value: number;
  bits: number[];
}

export function decodeControlFlags(accessLevel: string | null): SetupDataControlFlags | null {
  if (accessLevel === null || !/^[0-9a-f]{1,2}$/i.test(accessLevel)) return null;
  const value = Number.parseInt(accessLevel, 16);
  const bits: number[] = [];
  for (let bit = 0; bit < 8; bit++) {
    if ((value & (1 << bit)) !== 0) bits.push(bit);
  }
  return { value, bits };
}

export function describeControlFlags(accessLevel: string | null) {
  const flags = decodeControlFlags(accessLevel);
  if (!flags) return "No SetupData control record was matched for this item.";
  return `SetupData control flags 0x${accessLevel ?? ""}: bit${flags.bits.length === 1 ? "" : "s"} ${flags.bits.join(", ")} set. This byte's meaning is not established - see docs/ami/setupdata-control-flags.md - and is reported for reference only.`;
}
