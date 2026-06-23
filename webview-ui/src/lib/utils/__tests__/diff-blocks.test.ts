import { describe, it, expect } from 'vitest';
import { getChangeBlock } from '../diff-blocks';
import type { DiffLine } from '../../types';

const ctx = (content: string): DiffLine => ({ type: 'context', content });
const add = (content: string): DiffLine => ({ type: 'add', content });
const del = (content: string): DiffLine => ({ type: 'delete', content });

describe('getChangeBlock', () => {
  it('returns a single-line block for one added line', () => {
    const lines = [ctx('a'), add('b'), ctx('c')];
    const block = getChangeBlock(lines, 1);
    expect(block).not.toBeNull();
    expect(block!.lineIndices).toEqual([1]);
    expect(block!.adds).toBe(1);
    expect(block!.dels).toBe(0);
    expect(block!.isSingleLine).toBe(true);
  });

  it('returns a single-line block for one deleted line', () => {
    const lines = [ctx('a'), del('b'), ctx('c')];
    const block = getChangeBlock(lines, 1);
    expect(block!.lineIndices).toEqual([1]);
    expect(block!.adds).toBe(0);
    expect(block!.dels).toBe(1);
    expect(block!.isSingleLine).toBe(true);
  });

  it('treats a delete+add modify pair as a single-line change', () => {
    const lines = [ctx('a'), del('b'), add('b2'), ctx('c')];
    const block = getChangeBlock(lines, 2);
    expect(block!.lineIndices).toEqual([1, 2]);
    expect(block!.adds).toBe(1);
    expect(block!.dels).toBe(1);
    expect(block!.isSingleLine).toBe(true);
  });

  it('returns a multi-line block for a 3-line addition', () => {
    const lines = [ctx('a'), add('x'), add('y'), add('z'), ctx('b')];
    const block = getChangeBlock(lines, 2);
    expect(block!.lineIndices).toEqual([1, 2, 3]);
    expect(block!.adds).toBe(3);
    expect(block!.dels).toBe(0);
    expect(block!.isSingleLine).toBe(false);
  });

  it('does not merge two change blocks separated by a context line', () => {
    // ctx, add, add, ctx, add, ctx
    const lines = [ctx('a'), add('b1'), add('b2'), ctx('c'), add('d1'), ctx('e')];
    const first = getChangeBlock(lines, 1);
    expect(first!.lineIndices).toEqual([1, 2]);
    const firstFromOther = getChangeBlock(lines, 2);
    expect(firstFromOther!.lineIndices).toEqual([1, 2]);
    const second = getChangeBlock(lines, 4);
    expect(second!.lineIndices).toEqual([4]);
  });

  it('returns null for a context line', () => {
    const lines = [ctx('a'), add('b'), ctx('c')];
    expect(getChangeBlock(lines, 0)).toBeNull();
    expect(getChangeBlock(lines, 2)).toBeNull();
  });

  it('returns null for an out-of-range index', () => {
    const lines = [ctx('a'), add('b')];
    expect(getChangeBlock(lines, 5)).toBeNull();
    expect(getChangeBlock(lines, -1)).toBeNull();
  });
});
