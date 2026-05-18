import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import RemoveWorktreeModal from '../RemoveWorktreeModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

const baseProps = {
  path: '/repo/wt-feat',
  branch: 'feat/x',
  onClose: vi.fn(),
  onRemove: vi.fn(),
};

beforeEach(() => { i18n.setLocale('en'); });

describe('RemoveWorktreeModal', () => {
  it('default remove passes deleteBranch=false', async () => {
    const onRemove = vi.fn();
    const { container } = render(RemoveWorktreeModal, { ...baseProps, onRemove });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.danger-btn')!);
    expect(onRemove).toHaveBeenCalledWith(false);
  });

  it('checking deleteBranch propagates true', async () => {
    const onRemove = vi.fn();
    const { container } = render(RemoveWorktreeModal, { ...baseProps, onRemove });
    await fireEvent.click(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.danger-btn')!);
    expect(onRemove).toHaveBeenCalledWith(true);
  });

  it('hides the deleteBranch checkbox when branch is empty (detached worktree)', () => {
    const { container } = render(RemoveWorktreeModal, { ...baseProps, branch: '' });
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('cancel fires onClose, not onRemove', async () => {
    const onClose = vi.fn();
    const onRemove = vi.fn();
    const { container } = render(RemoveWorktreeModal, { ...baseProps, onClose, onRemove });
    await fireEvent.click(container.querySelectorAll('button')[0]);
    expect(onClose).toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
  });
});
