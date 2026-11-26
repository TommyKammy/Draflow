import type { Item, JsonObject, NodeType } from '@draflow/core';
import { getPath, pairing } from './helpers.js';

export const mergeNode: NodeType = {
  type: 'draflow.merge',
  version: 1,
  meta: {
    label: 'Merge',
    category: 'flow',
    description: 'Combine items from two inputs',
    icon: 'git-merge',
  },
  ports: {
    inputs: [
      { type: 'main', required: true, label: 'Input 1' },
      { type: 'main', required: true, label: 'Input 2' },
    ],
    outputs: [{ type: 'main' }],
  },
  parameters: [
    {
      name: 'mode',
      label: 'Mode',
      type: 'select',
      default: 'append',
      options: [
        { label: 'Append', value: 'append' },
        { label: 'Merge By Key', value: 'mergeByKey' },
        { label: 'Choose Branch', value: 'chooseBranch' },
      ],
    },
    {
      name: 'key',
      label: 'Key Field',
      type: 'string',
      default: 'id',
      displayOptions: { show: { mode: ['mergeByKey'] } },
    },
    {
      name: 'joinMode',
      label: 'Join Mode',
      type: 'select',
      default: 'outer',
      displayOptions: { show: { mode: ['mergeByKey'] } },
      options: [
        { label: 'Inner', value: 'inner' },
        { label: 'Left', value: 'left' },
        { label: 'Outer', value: 'outer' },
      ],
    },
    {
      name: 'branch',
      label: 'Branch',
      type: 'select',
      default: 'input1',
      displayOptions: { show: { mode: ['chooseBranch'] } },
      options: [
        { label: 'Input 1', value: 'input1' },
        { label: 'Input 2', value: 'input2' },
      ],
    },
  ],
  async execute(ctx) {
    const mode = ctx.param<string>('mode', 0, 'append');
    const left = ctx.input('main', 0);
    const right = ctx.input('main', 1);

    if (mode === 'chooseBranch') {
      const branch = ctx.param<string>('branch', 0, 'input1');
      return branch === 'input2' ? [...right] : [...left];
    }

    if (mode === 'append') {
      return [...left, ...right];
    }

    const key = ctx.param<string>('key', 0, 'id');
    const joinMode = ctx.param<string>('joinMode', 0, 'outer');
    const output: Item[] = [];
    const usedRight = new Set<number>();

    left.forEach((leftItem, leftIndex) => {
      const leftKey = getPath(leftItem.json, key);
      const rightIndex =
        leftKey === undefined
          ? -1
          : right.findIndex(
              (rightItem, index) =>
                !usedRight.has(index) && getPath(rightItem.json, key) === leftKey,
            );

      if (rightIndex >= 0) {
        const rightItem = right[rightIndex];
        usedRight.add(rightIndex);
        if (rightItem === undefined) return;
        const merged: Item = {
          json: { ...leftItem.json, ...rightItem.json },
          pairedItem: combinePairings(
            pairing(leftItem, leftIndex, 0),
            pairing(rightItem, rightIndex, 1),
          ),
        };
        const binary = mergeBinary(leftItem.binary, rightItem.binary);
        if (binary !== undefined) merged.binary = binary;
        const error = leftItem.error ?? rightItem.error;
        if (error !== undefined) merged.error = error;
        output.push(merged);
        return;
      }

      if (joinMode !== 'inner') {
        output.push({
          ...leftItem,
          json: { ...leftItem.json },
          pairedItem: pairing(leftItem, leftIndex, 0),
        });
      }
    });

    if (joinMode === 'outer') {
      right.forEach((rightItem, rightIndex) => {
        if (!usedRight.has(rightIndex)) {
          output.push({
            ...rightItem,
            json: { ...rightItem.json } as JsonObject,
            pairedItem: pairing(rightItem, rightIndex, 1),
          });
        }
      });
    }

    return output;
  },
};

function mergeBinary(
  left: Item['binary'],
  right: Item['binary'],
): Item['binary'] {
  if (left === undefined && right === undefined) return undefined;
  return { ...left, ...right };
}

function combinePairings(
  left: ReturnType<typeof pairing>,
  right: ReturnType<typeof pairing>,
): Array<{ item: number; input?: number; run?: number }> {
  return [
    ...(Array.isArray(left) ? left : [left]),
    ...(Array.isArray(right) ? right : [right]),
  ];
}
