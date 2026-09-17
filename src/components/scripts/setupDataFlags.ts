// The AMI SetupData byte this app has always exposed as "Access Level" (see
// setupData.ts, record offset +16) is a control flag byte, not a level.
// Across the three reference images (HP IPISB-CH2, ASUS ROG STRIX Z390-E,
// Intel NUC 10) it takes only the values 0x01, 0x09, 0x21, 0x29 and 0x49:
// bit 0 is set on every one of the 9,209 records, bit 3 on interactive
// questions (OneOf/CheckBox/Numeric) but never on a plain Ref, bit 5 on
// items with dynamic content (HDD security entries, Secure Boot state,
// System Information, fan tuning, storage ports) and bit 6 once. That
// matches the AMITSE control-flag layout, whose first bit is the control's
// visibility - the switch AMIBCP presents as Show/Hide - so a clear bit 0
// is reported as a SetupData-level hide. No reference image clears it, so
// that verdict is evidence-based but unconfirmed on hardware. Bits 5 and 6
// are named tentatively.

export interface SetupDataControlFlags {
  value: number;
  shown: boolean;
  interactive: boolean;
  refreshOrAccess: boolean;
  unresolved: number[];
}

const KNOWN_BITS = new Map<number, string>([
  [0, "shown"],
  [3, "interactive"],
  [5, "refresh / access (tentative)"],
]);

export function decodeControlFlags(accessLevel: string | null): SetupDataControlFlags | null {
  if (accessLevel === null || !/^[0-9a-f]{1,2}$/i.test(accessLevel)) return null;
  const value = Number.parseInt(accessLevel, 16);
  const unresolved: number[] = [];
  for (let bit = 0; bit < 8; bit++) {
    if ((value & (1 << bit)) !== 0 && !KNOWN_BITS.has(bit)) unresolved.push(bit);
  }
  return {
    value,
    shown: (value & 0x01) !== 0,
    interactive: (value & 0x08) !== 0,
    refreshOrAccess: (value & 0x20) !== 0,
    unresolved,
  };
}

// True when SetupData itself keeps the control off the page (bit 0 clear).
export function hiddenBySetupData(accessLevel: string | null) {
  const flags = decodeControlFlags(accessLevel);
  return flags !== null && !flags.shown;
}

export function describeControlFlags(accessLevel: string | null) {
  const flags = decodeControlFlags(accessLevel);
  if (!flags) return "No SetupData control record was matched for this item.";
  const parts = [...KNOWN_BITS]
    .filter(([bit]) => (flags.value & (1 << bit)) !== 0)
    .map(([, name]) => name);
  if (flags.unresolved.length > 0) {
    parts.push(`bit${flags.unresolved.length === 1 ? "" : "s"} ${flags.unresolved.join(", ")} (unresolved)`);
  }
  return `SetupData control flags 0x${accessLevel ?? ""}: ${parts.length > 0 ? parts.join(", ") : "no flag set"}. Bit 0 is the Show/Hide switch; clearing it hides the item in SetupData without touching the IFR.`;
}
