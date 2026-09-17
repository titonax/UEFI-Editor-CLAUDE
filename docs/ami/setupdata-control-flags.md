# AMI SetupData control flags

## The byte

Every HII question with a SetupData record carries a byte at record offset
+16 that this editor (like the upstream one) exposes as **Access Level**.
Across the three reference images it is a flag byte, never a level:

| Image | Records | 0x01 | 0x09 | 0x21 | 0x29 | 0x49 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| HP IPISB-CH2 (Aptio IV) | 584 | 172 | 403 | 9 | 0 | 0 |
| ASUS ROG STRIX Z390-E 2203 (Aptio V) | 4,611 | 1,236 | 2,802 | 149 | 423 | 1 |
| Intel NUC 10 FNCML357.0067 (Aptio V) | 4,014 | 1,024 | 2,783 | 35 | 172 | 0 |

- **Bit 0** is set on every record of every image. It is the control's
  visibility flag in the AMITSE control-flag layout, the switch AMIBCP shows
  as Show/Hide. The editor reports a clear bit 0 as "Hidden by SetupData
  flags"; no reference image contains such a record, so the verdict is
  evidence-based but not yet confirmed on hardware.
- **Bit 3** is set on interactive questions (OneOf, CheckBox, most Numerics)
  and never on a plain page Ref.
- **Bit 5** appears on items with dynamic content: HDD security entries,
  Secure Boot state and key actions, System Information, fan tuning,
  storage ports, OC profiles. It is either the refresh flag or an access
  level; the name is tentative.
- **Bit 6** appears once (a render-standby option) and is unresolved.

## Page records

SetupData also holds one page record per Form (24-byte header followed by
the offsets of its controls): `handle, formId, parent, title token, page id,
parent page id, …, control count`. In the NUC image the five AMI reference
pages the `Setup` hub links to (`0x271B`-`0x271F`) have page records with the
hub as parent exactly like the Intel pages, so SetupData does not hide them;
four of them are hidden by an always-true `SuppressIf` in the IFR and the
fifth (`Main 0x271B`) carries no hide anywhere the editor can see.

## What the editor does with it

- The Access Level field's tooltip decodes the byte.
- A clear bit 0 turns the item's HII effect into "Hidden by SetupData
  flags", in the form table and in the menu tree, with the IFR gates still
  taking precedence when both apply.
- Editing the byte is the existing Access Level edit; the export patches
  the same byte it always did.
