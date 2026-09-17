# AMI single-FormSet IFR navigation

## Scope

Some later AMI Setup layouts (ASUS Z370/Z390 boards, for instance) keep every
navigation page inside one HII FormSet and do not use the per-FormSet root
byte vector described in the root visibility analysis. In this layout the
FormSet entry Form is a navigation hub, and its direct IFR `Ref` opcodes, in
opcode order, declare the current top-level tabs.

Three concepts stay separate:

1. a page registered in the AMITSE table;
2. a Form reachable in the IFR graph;
3. a direct child of the IFR navigation hub.

Only the third relationship is structural evidence that a page is a current
top-level tab. Registration is useful corroboration, but does not promote a
descendant or detached page.

## Reference samples

The firmware files are not committed. Their identity and the results reproduced
locally with the upstream detector are:

| Property       | PRIME Z370-P 3004                                                  | ROG STRIX Z390-E GAMING                                            |
| -------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| File           | `PRIME-Z370-P-ASUS-3004.CAP`                                       | `SZ390E.CAP`                                                       |
| Bytes          | 16,779,264                                                         | 16,781,312                                                         |
| SHA-256        | `e862e5b0fdce10e44764be6072dd5b8017544264353dbfa02c8074e0ccc15190` | `9344b904cd319b3d385ffdf74d232a5e3999a2963cc74937af95a631a87f1454` |
| Outer layout   | `0x800` vendor capsule header plus a 16 MiB image                  | `0x1000` vendor capsule header plus a 16 MiB image                 |
| HII FormSets   | 1                                                                  | 1                                                                  |
| FormSet GUID   | `7B59104A-C00D-4158-87FF-F04D6396A915`                             | `7B59104A-C00D-4158-87FF-F04D6396A915`                             |
| Parsed Forms   | 205                                                                | 229                                                                |
| Navigation hub | `Setup`, FormId `0x2711`                                           | `Setup`, FormId `0x2710`                                           |

Z370-P hub Refs, in IFR order: My Favorites `0x2713` (`0x44944`), Main `0x2714`
(`0x44953`), Ai Tweaker `0x2719` (`0x44962`), Advanced `0x271A` (`0x44971`),
Monitor `0x271D` (`0x44980`), Boot `0x271F` (`0x4498F`), Tool `0x2721`
(`0x4499E`), Exit `0x2722` (`0x449AD`). AMITSE contains 15 matching registration
occurrences, including duplicates and three registered pages that are not direct
hub tabs; `Security` (`0x2716`) is registered but is an IFR descendant of `Main`.

Z390-E hub Refs: My Favorites `0x2712`, Main `0x2713`, Ai Tweaker `0x2714`,
Advanced `0x2715`, Monitor `0x2716`, Chipset `0x2717`, Boot `0x2718`, Tool
`0x2719`, Exit `0x271A`. AMITSE corroborates every direct tab and also registers
`Security` (`0x27E5`, a descendant of `Main`) and a detached `Exit` (`0x271B`);
neither is promoted. The unit test `singleFormSetNavigation.test.ts` reproduces
this graph.

## Detector invariants

`inspectSingleFormSetNavigation()` reports the layout only when:

1. the IFR contains exactly one unambiguous FormSet entry;
2. that entry resolves to exactly one Form;
3. the entry has at least two direct, same-FormSet Refs on initial detection;
4. every direct Ref resolves to exactly one Form;
5. direct target identities are unique;
6. tab order comes from Ref order, never from AMITSE occurrence order.

AMITSE matches are collapsed by FormSet GUID and FormId while retaining every
registration offset. Pages are then labelled hub, direct tab, reachable
descendant, or registered-only. A missing or duplicate direct target makes the
result ambiguous, which disables the stronger classification.

## Effective state

Being a direct hub Ref is a structural fact; whether the tab shows is still
decided by that Ref's own conditions. The Intel NUC 10 firmware
(`FNCML357.0067`) keeps 13 direct Refs in its `Setup` hub: the eight Intel
pages (Main, Advanced, Cooling, Performance, Security, Power, Boot, Save &
Exit) plus five AMI reference pages, four of which sit under a constant-true
`SuppressIf`. The inventory therefore reports 13 direct tabs, 9 shown and 4
hidden by IFR, with the tree's verdict next to each page. AMITSE registration
is absent in that image (its table does not use the FormSet GUID + FormId
pattern), so the report is `ifr-only`. SetupData page metadata is not
evaluated.

## Editing boundary

This layout needs no new FormSet and no guessed visibility byte. A page is
promoted by moving its existing direct `Ref` to the proven hub; a current tab is
demoted by moving its hub `Ref` under another existing Form. The move dialog
keeps its scope, duplicate, cycle, package-boundary and byte checks; the tab
inventory only opens it with the right intent and, for a promotion, the hub
preselected.

The move is recorded in the IFR graph immediately and the tab inventory is
recomputed from that graph after every move and after a `data.json` import.
AMITSE registration is kept as evidence and never rewritten because IFR
parentage changed. The bytes move at export, like every other edit.

A current direct tab can be relocated away from the hub, and a uniquely
referenced descendant can be moved back to it. An AMITSE-only registration
stays disabled when no unique IFR Ref exists; the editor never invents an
opcode to make such a page movable.
