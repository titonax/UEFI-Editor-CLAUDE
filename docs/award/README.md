# Phoenix-Award 6.00PG inventory

Read-only. This editor lists an Award image's modules and decodes its setup
item table; it cannot edit, repack or export any of it. Everything below was
recovered from one sample (an ECS M61A1 evaluation ROM, `R01A2.BIN`, 1 MiB,
AGESA 3.1.9.0, 2008) and is not verified against hardware.

## Module chain

The image holds a chain of LHA **level-1** entries (`-lh5-` compressed or
`-lh0-` stored), each header followed directly by its payload:

- `[len][checksum]` then `-lh5-`/`-lh0-`, skip size, original size, time, date,
  attribute, level `1`, name, CRC16, OS id, and the size of the first extended
  header. The checksum is the byte sum of the `len` bytes after it.
- In a level-1 header the *skip size* covers the extended headers as well as the
  payload, so the payload starts after the extended-header chain and its packed
  size is `skip size - extended headers`.
- The sample chains 23 modules: `R01A2.BIN` (the 128 KB system BIOS),
  `awardext.rom`, `_EN_CODE.BIN` (setup strings), `_ITEM.BIN` (setup items),
  `_DMI.BIN`, `ACPITBL.BIN`, option ROMs, AGESA blobs and logos.
- Every `-lh5-` module decompresses to exactly its declared size with the Phoenix
  FFV decoder, and its CRC16 matches. The three stored AGESA modules
  (`MEMINIT.BIN`, `HT.DLL`, `HT32GATE.BIN`) fail their CRC16, so a CRC mismatch
  is not treated as an error.
- There is no LH5 **encoder** in this repo, so nothing here can be rewritten.

`inspectAwardBytes` (`src/components/scripts/awardFirmware.ts`) needs at least
three checksum-verified entries before it reports an inventory.

## `_ITEM.BIN`

After a 16-byte name header it is a run of 25-byte records. The stride and the
fields come from the setup code itself (`awardext.rom` and `R01A2.BIN`
disassembled with `objdump -b binary -mi8086`), not from guessing at the data:

| Offset | Field | Evidence |
| --- | --- | --- |
| +0 | flags word | `test word [bx],8` / `0x8008` / `0x8040` in the item loops |
| +2 / +3 | item id / group | links elsewhere are `(id, group)` pairs |
| +6 | bit mask | repeated at +9 |
| +8 | CMOS address (`0xfd` = none) | `mov al,[bx+8]` feeding the CMOS reader |
| +0x0f | maximum value | agrees with the mask (`0x70` -> 7) |
| +0x11 | page (low 6 bits), column (next 4) | page builder: `and al,3fh ; cmp al,dl` |
| +0x13 / +0x15 | fail-safe / optimized value | aligned with the mask |

The decoder explains about 83% of the sample's table (201 records); the rest is
filler or layouts the heuristic does not recognise. The sample's boot-device
items (two nibbles of CMOS `0x65`/`0x66`) decode as expected.

### Hidden items

The setup page builder skips an item when bit `0x0008` of its flags word is
set, and a second pass skips `0x8008`. The code also sets that bit **at run
time** (`or word [item],8`) for hardware-dependent items. So:

- clearing the bit in the table could only reveal a *statically* hidden item;
  the sample has two (virtual items, no CMOS byte);
- an item the code hides for missing hardware would be hidden again.

Other flag bits are seen in the table (`0x4`, `0x10`, `0x40`, `0x80`, ...) and
tested by the code, but their meaning is not worked out.

## What is not known

- Whether a hidden item shows once the bit is cleared: never tried on hardware.
- How an item maps to its title in `_EN_CODE.BIN`.
- What the `b2`/`b3` bytes at +4/+5 mean.
- Whether Award accepts a repacked module: it would need an LH5 encoder, the
  rebuilt header checksum and CRC16, and no other module to move.
- Other Award generations (4.51PG, 2 MiB mirrored images) are untested.
