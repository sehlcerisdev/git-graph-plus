import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import RebaseBranchModal from '../RebaseBranchModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

beforeEach(() => { i18n.setLocale('en'); });

describe('RebaseBranchModal', () => {
  it('on mount, posts predictConflicts with mode=rebase and ours=branch, theirs=onto', () => {
    render(RebaseBranchModal, {
      branch: 'topic', onto: 'main',
      onClose: vi.fn(), onRebase: vi.fn(),
    });
    const posted = globalThis.__postedMessages.map(m => m.data) as Array<{ type: string; payload?: Record<string, unknown> }>;
    const predict = posted.find(p => p.type === 'predictConflicts');
    expect(predict).toBeDefined();
    expect(predict!.payload!.ours).toBe('topic');
    expect(predict!.payload!.theirs).toBe('main');
    expect(predict!.payload!.mode).toBe('rebase');
  });

  it('shows spinner before conflict response arrives', () => {
    const { container } = render(RebaseBranchModal, {
      branch: 'topic', onto: 'main',
      onClose: vi.fn(), onRebase: vi.fn(),
    });
    expect(container.querySelector('.spinner')).not.toBeNull();
  });

  it('switches to success class when prediction reports no conflict', async () => {
    const { container } = render(RebaseBranchModal, {
      branch: 'topic', onto: 'main',
      onClose: vi.fn(), onRebase: vi.fn(),
    });
    const requestId = (globalThis.__postedMessages.find(m =>
      (m.data as { type: string }).type === 'predictConflicts',
    )!.data as { payload: { requestId: string } }).payload.requestId;

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'conflictPrediction', payload: { hasConflict: false, files: [], requestId } },
    }));
    await tick();

    expect(container.querySelector('.conflict-status.is-success')).not.toBeNull();
  });

  it('forwards autostash flag to onRebase', async () => {
    const onRebase = vi.fn();
    const { container } = render(RebaseBranchModal, {
      branch: 'topic', onto: 'main',
      onClose: vi.fn(), onRebase,
    });
    const autostash = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await fireEvent.click(autostash);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onRebase).toHaveBeenCalledWith({ autostash: true });
  });
});
