import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import CreateBranchModal from '../CreateBranchModal.svelte';
import { branchStore } from '../../../lib/stores/branches.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import type { BranchData, BranchInfo, TagInfo } from '../../../lib/types';

function setBranches(branches: BranchInfo[] = [], tags: TagInfo[] = []) {
  const data: BranchData = { branches, tags, remotes: [], stashes: [], worktrees: [] };
  branchStore.setData(data);
}

function makeBranch(name: string): BranchInfo {
  return { name, current: false, hash: 'abc123', ahead: 0, behind: 0 };
}

beforeEach(() => {
  i18n.setLocale('en');
  setBranches();
});

describe('CreateBranchModal', () => {
  it('disables the primary button until a name is entered', async () => {
    const { container } = render(CreateBranchModal, {
      startPoint: 'main',
      onClose: vi.fn(),
      onCreate: vi.fn(),
    });
    const submit = container.querySelector<HTMLButtonElement>('button.primary');
    expect(submit).not.toBeNull();
    expect(submit!.disabled).toBe(true);
  });

  it('enables the primary button when a valid name is typed', async () => {
    const { container } = render(CreateBranchModal, {
      startPoint: 'main',
      onClose: vi.fn(),
      onCreate: vi.fn(),
    });
    const nameInput = container.querySelector<HTMLInputElement>('#create-branch-name');
    await fireEvent.input(nameInput!, { target: { value: 'feature/login' } });
    const submit = container.querySelector<HTMLButtonElement>('button.primary');
    expect(submit!.disabled).toBe(false);
  });

  it('shows a warning and disables submit when name collides with an existing branch', async () => {
    setBranches([makeBranch('feature/login')]);
    const { container } = render(CreateBranchModal, {
      startPoint: 'main',
      onClose: vi.fn(),
      onCreate: vi.fn(),
    });
    const nameInput = container.querySelector<HTMLInputElement>('#create-branch-name');
    await fireEvent.input(nameInput!, { target: { value: 'feature/login' } });

    expect(container.querySelector('.modal-warning')).not.toBeNull();
    const submit = container.querySelector<HTMLButtonElement>('button.primary');
    expect(submit!.disabled).toBe(true);
  });

  it('shows a warning when name collides with an existing tag', async () => {
    setBranches([], [{ name: 'v1.0', hash: 'abc', isAnnotated: false }]);
    const { container } = render(CreateBranchModal, {
      startPoint: 'main',
      onClose: vi.fn(),
      onCreate: vi.fn(),
    });
    const nameInput = container.querySelector<HTMLInputElement>('#create-branch-name');
    await fireEvent.input(nameInput!, { target: { value: 'v1.0' } });

    expect(container.querySelector('.modal-warning')).not.toBeNull();
    const submit = container.querySelector<HTMLButtonElement>('button.primary');
    expect(submit!.disabled).toBe(true);
  });

  it('shows a warning for invalid ref characters (^, ~, etc.)', async () => {
    const { container } = render(CreateBranchModal, {
      startPoint: 'main',
      onClose: vi.fn(),
      onCreate: vi.fn(),
    });
    const nameInput = container.querySelector<HTMLInputElement>('#create-branch-name');
    await fireEvent.input(nameInput!, { target: { value: 'bad^name' } });

    expect(container.querySelector('.modal-warning')).not.toBeNull();
    const submit = container.querySelector<HTMLButtonElement>('button.primary');
    expect(submit!.disabled).toBe(true);
  });

  it('calls onCreate with trimmed name, start point, and checkout flag', async () => {
    const onCreate = vi.fn();
    const { container } = render(CreateBranchModal, {
      startPoint: 'main',
      onClose: vi.fn(),
      onCreate,
    });
    const nameInput = container.querySelector<HTMLInputElement>('#create-branch-name');
    await fireEvent.input(nameInput!, { target: { value: '  feature/x  ' } });

    const submit = container.querySelector<HTMLButtonElement>('button.primary');
    await fireEvent.click(submit!);

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith('feature/x', 'main', true);
  });

  it('does NOT call onCreate when submit is attempted with empty name', async () => {
    const onCreate = vi.fn();
    const { container } = render(CreateBranchModal, {
      startPoint: 'main',
      onClose: vi.fn(),
      onCreate,
    });
    const nameInput = container.querySelector<HTMLInputElement>('#create-branch-name');
    // Simulate Enter on the input with no name typed.
    await fireEvent.keyDown(nameInput!, { key: 'Enter' });

    expect(onCreate).not.toHaveBeenCalled();
  });

  it('submits via Enter key when name is valid', async () => {
    const onCreate = vi.fn();
    const { container } = render(CreateBranchModal, {
      startPoint: 'main',
      onClose: vi.fn(),
      onCreate,
    });
    const nameInput = container.querySelector<HTMLInputElement>('#create-branch-name');
    await fireEvent.input(nameInput!, { target: { value: 'feature/x' } });
    await fireEvent.keyDown(nameInput!, { key: 'Enter' });

    expect(onCreate).toHaveBeenCalledWith('feature/x', 'main', true);
  });

  it('shows the start-point input only when editableStartPoint=true', async () => {
    const { container, rerender } = render(CreateBranchModal, {
      startPoint: 'main',
      onClose: vi.fn(),
      onCreate: vi.fn(),
      editableStartPoint: false,
    });
    expect(container.querySelector('#create-branch-start-point')).toBeNull();

    await rerender({
      startPoint: 'main',
      onClose: vi.fn(),
      onCreate: vi.fn(),
      editableStartPoint: true,
    });
    expect(container.querySelector('#create-branch-start-point')).not.toBeNull();
  });

  it('passes the user-edited start point to onCreate', async () => {
    const onCreate = vi.fn();
    const { container } = render(CreateBranchModal, {
      startPoint: 'main',
      editableStartPoint: true,
      onClose: vi.fn(),
      onCreate,
    });
    const nameInput = container.querySelector<HTMLInputElement>('#create-branch-name');
    const startInput = container.querySelector<HTMLInputElement>('#create-branch-start-point');
    await fireEvent.input(nameInput!, { target: { value: 'feature/x' } });
    await fireEvent.input(startInput!, { target: { value: 'origin/develop' } });

    const submit = container.querySelector<HTMLButtonElement>('button.primary');
    await fireEvent.click(submit!);

    expect(onCreate).toHaveBeenCalledWith('feature/x', 'origin/develop', true);
  });

  it('falls back to HEAD when start point is blanked out', async () => {
    const onCreate = vi.fn();
    const { container } = render(CreateBranchModal, {
      startPoint: '',
      editableStartPoint: true,
      onClose: vi.fn(),
      onCreate,
    });
    const nameInput = container.querySelector<HTMLInputElement>('#create-branch-name');
    await fireEvent.input(nameInput!, { target: { value: 'wip' } });

    const submit = container.querySelector<HTMLButtonElement>('button.primary');
    await fireEvent.click(submit!);

    expect(onCreate).toHaveBeenCalledWith('wip', 'HEAD', true);
  });

  it('reflects the checkout toggle in the onCreate call', async () => {
    const onCreate = vi.fn();
    const { container } = render(CreateBranchModal, {
      startPoint: 'main',
      onClose: vi.fn(),
      onCreate,
    });
    const nameInput = container.querySelector<HTMLInputElement>('#create-branch-name');
    await fireEvent.input(nameInput!, { target: { value: 'feature/x' } });

    const checkbox = container.querySelector<HTMLInputElement>('.modal-checkbox input[type="checkbox"]');
    await fireEvent.click(checkbox!);

    const submit = container.querySelector<HTMLButtonElement>('button.primary');
    await fireEvent.click(submit!);

    expect(onCreate).toHaveBeenCalledWith('feature/x', 'main', false);
  });
});
