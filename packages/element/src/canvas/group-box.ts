import type { WorkflowNode } from '@draflow/core';
import { cardHeight, cardWidth, type Point } from './scene.js';

export interface Box extends Point { width: number; height: number }
export function groupBox(members: string[], nodes: ReadonlyMap<string, WorkflowNode>, moving?: Set<string>, offset?: Point): Box {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const id of members) {
    const { position } = nodes.get(id)!;
    const shift = moving?.has(id) ? offset : undefined;
    const x = position.x + (shift?.x ?? 0), y = position.y + (shift?.y ?? 0);
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x + cardWidth); bottom = Math.max(bottom, y + cardHeight);
  }
  return { x: left - 16, y: top - 48, width: right - left + 32, height: bottom - top + 64 };
}

export function visibleBox(box: Box, collapsed: boolean): Box {
  return collapsed ? { ...box, width: 212, height: 48 } : box;
}
