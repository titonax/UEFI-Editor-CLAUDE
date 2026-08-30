import { parseHexId } from "./hexId";
import type { Form, FormChildren } from "./types";

export interface ChildBlock {
  startIndex: number;
  endIndex: number; // exclusive
  // The outermost enclosing condition's own opcode offset, present only
  // when 2+ consecutive children share it. They were all declared inside
  // the same SuppressIf/GrayOutIf/DisableIf ... EndIf and have to move as
  // one atomic unit - splitting them apart would leave that condition
  // wrapping the wrong content, or nothing at all.
  conditionOffset?: string;
}

// Partitions a Form's children into the atomic units a reorder can move.
// Every leaf without a condition wrapper is its own block; consecutive
// leaves sharing the same outermost condition (conditions[0] - a condition
// scope, once opened, stays open only for as long as it's on the parser's
// scope stack, so two children can only share an offset by actually having
// been inside the same scope, which makes them contiguous by construction)
// are grouped into one. Together the returned blocks partition `children`
// with no gaps and no overlaps.
export function computeChildBlocks(children: FormChildren[]): ChildBlock[] {
  const blocks: ChildBlock[] = [];
  let index = 0;

  while (index < children.length) {
    const conditionOffset = children[index].conditions?.[0];
    let end = index + 1;
    if (conditionOffset !== undefined) {
      while (
        end < children.length &&
        children[end].conditions?.[0] === conditionOffset
      ) {
        end++;
      }
    }
    blocks.push({ startIndex: index, endIndex: end, conditionOffset });
    index = end;
  }

  return blocks;
}

// Moves the block at `blockIndex` past its immediate neighbor in the given
// direction, keeping every other block untouched and every block's own
// internal child order intact. Returns `children` unchanged (same
// reference) if there's no neighbor to swap with - the UI is expected to
// disable the "up"/"down" control in that case, but this stays a safe no-op
// either way.
export function swapAdjacentBlocks(
  children: FormChildren[],
  blocks: ChildBlock[],
  blockIndex: number,
  direction: "up" | "down",
): FormChildren[] {
  const otherIndex = direction === "up" ? blockIndex - 1 : blockIndex + 1;
  if (otherIndex < 0 || otherIndex >= blocks.length) {
    return children;
  }

  const [first, second] =
    blockIndex < otherIndex
      ? [blocks[blockIndex], blocks[otherIndex]]
      : [blocks[otherIndex], blocks[blockIndex]];

  return [
    ...children.slice(0, first.startIndex),
    ...children.slice(second.startIndex, second.endIndex),
    ...children.slice(first.startIndex, first.endIndex),
    ...children.slice(second.endIndex),
  ];
}

function blockStartOffset(form: Form, block: ChildBlock): number {
  return parseHexId(block.conditionOffset ?? form.children[block.startIndex].sctOffset);
}

export interface ReorderPiece {
  oldStart: number;
  length: number;
  newStart: number;
}

// A block's byte length is never stored anywhere - it's derived from the
// pristine, never-mutated sctOffset/conditionOffset values, by finding the
// next such value above it (or the Form's own End, for whichever block
// happens to be pristine-last). This holds regardless of how many times the
// children have been reordered in memory, since it only depends on the SET
// of boundary offsets, not their current array position.
function blockLength(sortedStarts: number[], start: number, formEndOffset: number) {
  const index = sortedStarts.indexOf(start);
  const next =
    index + 1 < sortedStarts.length ? sortedStarts[index + 1] : formEndOffset;
  return next - start;
}

// Computes the pristine-byte-range "pieces" a reorder needs to physically
// apply: for each block, in the Form's CURRENT (possibly already reordered)
// children order, where its bytes currently live (oldStart/length, both
// pristine and unaffected by any in-memory reordering) and where they need
// to end up (newStart) to realize that current order in the actual file.
// Returns null when the current order already matches the pristine byte
// layout - nothing to patch.
export function computeReorderPieces(form: Form): ReorderPiece[] | null {
  const blocks = computeChildBlocks(form.children);
  if (blocks.length === 0) {
    return null;
  }

  const starts = blocks.map((block) => blockStartOffset(form, block));
  const sortedStarts = [...starts].sort((a, b) => a - b);
  const formEndOffset = parseHexId(form.endOffset);

  let cursor = sortedStarts[0];
  let anyMoved = false;
  const pieces: ReorderPiece[] = [];
  for (const start of starts) {
    const length = blockLength(sortedStarts, start, formEndOffset);
    pieces.push({ oldStart: start, length, newStart: cursor });
    if (cursor !== start) {
      anyMoved = true;
    }
    cursor += length;
  }

  return anyMoved ? pieces : null;
}

// Where a pristine absolute offset (a Suppression's own offset/start/end)
// ends up after applying `pieces` - unchanged if it doesn't fall inside any
// moved piece (it belongs to a different Form, or that Form wasn't
// reordered at all).
export function remapOffsetIfMoved(offset: number, pieces: ReorderPiece[]) {
  for (const piece of pieces) {
    if (offset >= piece.oldStart && offset < piece.oldStart + piece.length) {
      return offset + (piece.newStart - piece.oldStart);
    }
  }
  return offset;
}
