import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import CherryPickModal from '../CherryPickModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

beforeEach(() => { i18n.setLocale('en'); });

describe('CherryPickModal', () => {
  it('on mount, posts predictConflicts with mergeBase = commit^', () => {
    render(CherryPickModal, {
      commit: 'abc1234',
      branch: 'main',
      onClose: vi.fn(),
      onCherryPick: vi.fn(),
    });
    const posted = globalThis.__postedMessages.map(m => m.data) as Array<{ type: string; payload?: Record<string, unknown> }>;
    const predict = posted.find(p => p.type === 'predictConflicts');
    expect(predict).toBeDefined();
    expect(predict!.payload!.ours).toBe('HEAD');
    expect(predict!.payload!.theirs).toBe('abc1234');
    expect(predict!.payload!.mergeBase).toBe('abc1234^');
    expect(typeof predict!.payload!.requestId).toBe('string');
  });

  it('shows the checking-conflicts spinner before a response arrives', () => {
    const { container } = render(CherryPickModal, {
      commit: 'abc1234', branch: 'main',
      onClose: vi.fn(), onCherryPick: vi.fn(),
    });
    expect(container.querySelector('.spinner')).not.toBeNull();
  });

  it('updates the banner when a matching conflictPrediction response arrives', async () => {
    const { container } = render(CherryPickModal, {
      commit: 'abc1234', branch: 'main',
      onClose: vi.fn(), onCherryPick: vi.fn(),
    });
    const posted = globalThis.__postedMessages.map(m => m.data) as Array<{ type: string; payload?: Record<string, unknown> }>;
    const requestId = posted.find(p => p.type === 'predictConflicts')!.payload!.requestId;

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'conflictPrediction', payload: { hasConflict: true, files: ['a.ts', 'b.ts'], requestId } },
    }));
    await tick();

    expect(container.querySelector('.spinner')).toBeNull();
    expect(container.querySelector('.conflict-status.is-warning')).not.toBeNull();
  });

  it('ignores responses with a non-matching requestId (stale from prior mount)', async () => {
    const { container } = render(CherryPickModal, {
      commit: 'abc1234', branch: 'main',
      onClose: vi.fn(), onCherryPick: vi.fn(),
    });

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'conflictPrediction', payload: { hasConflict: true, files: ['x'], requestId: 'stale-id' } },
    }));
    await tick();
    // Spinner should still be visible because the response was rejected.
    expect(container.querySelector('.spinner')).not.toBeNull();
  });

  it('forwards the noCommit checkbox state to onCherryPick', async () => {
    const onCherryPick = vi.fn();
    const { container } = render(CherryPickModal, {
      commit: 'abc1234', branch: 'main',
      onClose: vi.fn(), onCherryPick,
    });
    const checkbox = container.querySelector<HTMLInputElement>('.modal-checkbox input[type="checkbox"]')!;
    await fireEvent.click(checkbox);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onCherryPick).toHaveBeenCalledWith(true);
  });
});
