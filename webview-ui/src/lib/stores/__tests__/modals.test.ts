import { describe, it, expect, beforeEach } from 'vitest';
import { modalStore } from '../modals.svelte';

// modalStore is a singleton, so each test must close everything before it
// touches state — otherwise leakage between tests masks bugs.
beforeEach(() => {
  modalStore.closeAll();
});

describe('modalStore.open/close', () => {
  it('openDeleteBranch sets show and name', () => {
    modalStore.openDeleteBranch('feature/login');
    expect(modalStore.deleteBranch).toEqual({ show: true, name: 'feature/login' });
  });

  it('closeDeleteBranch clears the name too (no stale leak)', () => {
    modalStore.openDeleteBranch('feature/login');
    modalStore.closeDeleteBranch();
    expect(modalStore.deleteBranch).toEqual({ show: false, name: '' });
  });

  it('openCreateBranch defaults subject to empty string', () => {
    modalStore.openCreateBranch('main');
    expect(modalStore.createBranch.startPoint).toBe('main');
    expect(modalStore.createBranch.subject).toBe('');
  });

  it('openMerge captures both source and target', () => {
    modalStore.openMerge('feature/x', 'main');
    expect(modalStore.merge).toEqual({ show: true, source: 'feature/x', target: 'main' });
  });

  it('openPush defaults to origin and no force', () => {
    modalStore.openPush();
    expect(modalStore.push.remote).toBe('origin');
    expect(modalStore.push.forceMode).toBe('none');
    expect(modalStore.push.setUpstream).toBe(true);
  });

  it('openPush honours custom remote', () => {
    modalStore.openPush('upstream');
    expect(modalStore.push.remote).toBe('upstream');
  });

  it('openPull defaults to rebase=true, stash=false', () => {
    modalStore.openPull();
    expect(modalStore.pull).toEqual({ show: true, rebase: true, stash: false });
  });
});

describe('modalStore.anyOpen', () => {
  it('returns false when nothing is open', () => {
    expect(modalStore.anyOpen).toBe(false);
  });

  it('returns true when any modal is open', () => {
    modalStore.openDeleteBranch('x');
    expect(modalStore.anyOpen).toBe(true);
  });

  it('returns true for each modal individually', () => {
    // Spot-check several different modals to confirm the getter actually
    // ORs across all the show flags it claims to.
    const checks: Array<[() => void, () => void]> = [
      [() => modalStore.openCreateBranch('main'), () => modalStore.closeCreateBranch()],
      [() => modalStore.openMerge('a', 'b'), () => modalStore.closeMerge()],
      [() => modalStore.openFetch(), () => modalStore.closeFetch()],
      [() => modalStore.openPush(), () => modalStore.closePush()],
      [() => modalStore.openFlowInit(), () => modalStore.closeFlowInit()],
    ];
    for (const [open, close] of checks) {
      open();
      expect(modalStore.anyOpen).toBe(true);
      close();
      expect(modalStore.anyOpen).toBe(false);
    }
  });
});

describe('modalStore — remaining open methods', () => {
  it('openStashRename captures index and message', () => {
    modalStore.openStashRename(3, 'wip thing');
    expect(modalStore.stashRename).toEqual({ show: true, index: 3, message: 'wip thing' });
  });

  it('openSetUpstream captures branch and currentUpstream (defaults blank)', () => {
    modalStore.openSetUpstream('feat');
    expect(modalStore.setUpstream).toEqual({ show: true, branchName: 'feat', currentUpstream: '' });
    modalStore.closeSetUpstream();
    modalStore.openSetUpstream('feat', 'origin/feat');
    expect(modalStore.setUpstream.currentUpstream).toBe('origin/feat');
  });

  it('openFlowStart captures the flow type', () => {
    modalStore.openFlowStart('release');
    expect(modalStore.flowStart).toEqual({ show: true, flowType: 'release' });
  });

  it('openPushTag defaults remote to origin', () => {
    modalStore.openPushTag('v1.0');
    expect(modalStore.pushTag).toEqual({ show: true, tagName: 'v1.0', remote: 'origin' });
    modalStore.closePushTag();
    modalStore.openPushTag('v1.0', 'fork');
    expect(modalStore.pushTag.remote).toBe('fork');
  });
});

describe('modalStore.closeAll', () => {
  it('closes every open modal in one call (used on extension error)', () => {
    modalStore.openCreateBranch('main');
    modalStore.openMerge('x', 'y');
    modalStore.openPush();
    modalStore.openFlowFinish('feature', 'feature/x');
    expect(modalStore.anyOpen).toBe(true);

    modalStore.closeAll();

    expect(modalStore.anyOpen).toBe(false);
    expect(modalStore.createBranch.show).toBe(false);
    expect(modalStore.merge.show).toBe(false);
    expect(modalStore.push.show).toBe(false);
    expect(modalStore.flowFinish.show).toBe(false);
  });
});
