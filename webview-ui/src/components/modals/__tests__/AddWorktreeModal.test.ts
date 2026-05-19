import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import AddWorktreeModal from '../AddWorktreeModal.svelte';
import { branchStore } from '../../../lib/stores/branches.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import type { BranchInfo } from '../../../lib/types';

function setBranches(branches: BranchInfo[]) {
  branchStore.setData({ branches, tags: [], remotes: [], stashes: [], worktrees: [] });
}

beforeEach(() => {
  i18n.setLocale('en');
  setBranches([
    { name: 'main', current: true, hash: 'abc', ahead: 0, behind: 0 },
    { name: 'develop', current: false, hash: 'def', ahead: 0, behind: 0 },
  ]);
});

describe('AddWorktreeModal', () => {
  it('submit disabled until both branch name and location are filled', async () => {
    const { container } = render(AddWorktreeModal, {
      defaultPath: '',
      onClose: vi.fn(),
      onAdd: vi.fn(),
    });
    const submit = container.querySelector<HTMLButtonElement>('button.primary')!;
    expect(submit.disabled).toBe(true);

    const branchInput = container.querySelector<HTMLInputElement>('#wt-branch')!;
    const locationInput = container.querySelector<HTMLInputElement>('#wt-location')!;
    await fireEvent.input(branchInput, { target: { value: 'feature-x' } });
    await fireEvent.input(locationInput, { target: { value: '/tmp/wt' } });
    await tick();
    expect(submit.disabled).toBe(false);
  });

  it('auto-fills location = defaultPath + branchName (slashes replaced with dashes)', async () => {
    const { container } = render(AddWorktreeModal, {
      defaultPath: '/Users/me/worktrees/',
      onClose: vi.fn(),
      onAdd: vi.fn(),
    });
    const branchInput = container.querySelector<HTMLInputElement>('#wt-branch')!;
    const locationInput = container.querySelector<HTMLInputElement>('#wt-location')!;
    await fireEvent.input(branchInput, { target: { value: 'feature/login' } });
    await tick();
    expect(locationInput.value).toBe('/Users/me/worktrees/feature-login');
  });

  it('keeps location at defaultPath when branch name is cleared', async () => {
    const { container } = render(AddWorktreeModal, {
      defaultPath: '/Users/me/wt/',
      onClose: vi.fn(),
      onAdd: vi.fn(),
    });
    const branchInput = container.querySelector<HTMLInputElement>('#wt-branch')!;
    const locationInput = container.querySelector<HTMLInputElement>('#wt-location')!;
    await fireEvent.input(branchInput, { target: { value: 'feat' } });
    await tick();
    expect(locationInput.value).toBe('/Users/me/wt/feat');

    await fireEvent.input(branchInput, { target: { value: '' } });
    await tick();
    expect(locationInput.value).toBe('/Users/me/wt/');
  });

  it('does NOT auto-overwrite location when defaultPath is empty (user-controlled mode)', async () => {
    const { container } = render(AddWorktreeModal, {
      defaultPath: '',
      onClose: vi.fn(),
      onAdd: vi.fn(),
    });
    const branchInput = container.querySelector<HTMLInputElement>('#wt-branch')!;
    const locationInput = container.querySelector<HTMLInputElement>('#wt-location')!;
    await fireEvent.input(locationInput, { target: { value: '/my/custom/path' } });
    await fireEvent.input(branchInput, { target: { value: 'feature' } });
    await tick();
    // Location remains the user-typed value — no auto-overwrite.
    expect(locationInput.value).toBe('/my/custom/path');
  });

  it('Enter on the branch input submits when ready', async () => {
    const onAdd = vi.fn();
    const { container } = render(AddWorktreeModal, {
      defaultPath: '/wt/',
      onClose: vi.fn(),
      onAdd,
    });
    const branchInput = container.querySelector<HTMLInputElement>('#wt-branch')!;
    await fireEvent.input(branchInput, { target: { value: 'feat' } });
    await tick();
    await fireEvent.keyDown(branchInput, { key: 'Enter' });
    expect(onAdd).toHaveBeenCalled();
  });

  it('switching startAt branch via the dropdown propagates to onAdd', async () => {
    const onAdd = vi.fn();
    const { container } = render(AddWorktreeModal, {
      defaultPath: '/wt/',
      onClose: vi.fn(),
      onAdd,
    });
    // Open the startAt ColorSelect and pick "develop"
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.color-select-btn')!);
    const opts = container.querySelectorAll<HTMLButtonElement>('.color-select-option');
    const develop = Array.from(opts).find(o => o.textContent?.includes('develop'))!;
    await fireEvent.click(develop);
    const branchInput = container.querySelector<HTMLInputElement>('#wt-branch')!;
    await fireEvent.input(branchInput, { target: { value: 'feat' } });
    await tick();
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onAdd).toHaveBeenCalledWith('/wt/feat', 'develop', 'feat');
  });

  it('rejects an invalid branch name and shows the warning', async () => {
    const { container } = render(AddWorktreeModal, {
      defaultPath: '/wt/',
      onClose: vi.fn(),
      onAdd: vi.fn(),
    });
    const submit = container.querySelector<HTMLButtonElement>('button.primary')!;
    const branchInput = container.querySelector<HTMLInputElement>('#wt-branch')!;
    // Leading dash would otherwise reach git as an option-style positional arg.
    await fireEvent.input(branchInput, { target: { value: '-evil' } });
    await tick();
    expect(submit.disabled).toBe(true);
    expect(container.querySelector('.modal-warning')).not.toBeNull();

    await fireEvent.input(branchInput, { target: { value: 'foo..bar' } });
    await tick();
    expect(submit.disabled).toBe(true);

    await fireEvent.input(branchInput, { target: { value: 'ok-name' } });
    await tick();
    expect(submit.disabled).toBe(false);
    expect(container.querySelector('.modal-warning')).toBeNull();
  });

  it('submit forwards (location, startAt, branchName) trimmed', async () => {
    const onAdd = vi.fn();
    const { container } = render(AddWorktreeModal, {
      defaultPath: '',
      onClose: vi.fn(),
      onAdd,
    });
    const branchInput = container.querySelector<HTMLInputElement>('#wt-branch')!;
    const locationInput = container.querySelector<HTMLInputElement>('#wt-location')!;
    await fireEvent.input(branchInput, { target: { value: '  feature/x  ' } });
    await fireEvent.input(locationInput, { target: { value: '  /tmp/wt  ' } });
    await tick();
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);

    // startAt defaults to currentBranch.name = 'main'.
    expect(onAdd).toHaveBeenCalledWith('/tmp/wt', 'main', 'feature/x');
  });
});
