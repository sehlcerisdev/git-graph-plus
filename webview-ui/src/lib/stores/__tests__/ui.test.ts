import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { uiStore } from '../ui.svelte';

beforeEach(() => {
  // Reset to defaults — singleton leaks between tests otherwise.
  uiStore.selectedCommitHash = null;
  uiStore.comparing = false;
  uiStore.compareRef1 = null;
  uiStore.compareRef2 = null;
  uiStore.showBottomPanel = false;
  uiStore.errorMessage = null;
  uiStore.viewMode = 'graph';
});

describe('uiStore.selectCommit', () => {
  it('updates selected hash and exits comparison mode', () => {
    uiStore.comparing = true;
    uiStore.compareRef1 = 'a';
    uiStore.compareRef2 = 'b';

    uiStore.selectCommit('abc123');

    expect(uiStore.selectedCommitHash).toBe('abc123');
    expect(uiStore.comparing).toBe(false);
    expect(uiStore.compareRef1).toBeNull();
    expect(uiStore.compareRef2).toBeNull();
  });

  it('opens the bottom panel when selecting a real commit', () => {
    uiStore.showBottomPanel = false;
    uiStore.selectCommit('abc123');
    expect(uiStore.showBottomPanel).toBe(true);
  });

  it('does NOT force-open the panel when deselecting (null)', () => {
    uiStore.showBottomPanel = false;
    uiStore.selectCommit(null);
    expect(uiStore.showBottomPanel).toBe(false);
  });
});

describe('uiStore.setViewMode', () => {
  it('switches to log view', () => {
    uiStore.setViewMode('log');
    expect(uiStore.viewMode).toBe('log');
  });

  it('switches to stats view', () => {
    uiStore.setViewMode('stats');
    expect(uiStore.viewMode).toBe('stats');
  });
});

describe('uiStore.setError', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets the error message', () => {
    uiStore.setError('boom');
    expect(uiStore.errorMessage).toBe('boom');
  });

  it('clears the error after 8 seconds', () => {
    uiStore.setError('boom');
    vi.advanceTimersByTime(7999);
    expect(uiStore.errorMessage).toBe('boom');
    vi.advanceTimersByTime(1);
    expect(uiStore.errorMessage).toBeNull();
  });

  it('resets the timer when a new error arrives (does not let an old timer clear the new message)', () => {
    uiStore.setError('first');
    vi.advanceTimersByTime(7000);
    uiStore.setError('second');
    vi.advanceTimersByTime(7000);
    // 14s total since first error, but only 7s since the second one — must
    // still be visible. If the first timer wasn't cleared, the message
    // would have been wiped at t=8000.
    expect(uiStore.errorMessage).toBe('second');
    vi.advanceTimersByTime(1000);
    expect(uiStore.errorMessage).toBeNull();
  });

  it('clearing the error (null) stops any pending timer', () => {
    uiStore.setError('boom');
    uiStore.setError(null);
    vi.advanceTimersByTime(10000);
    expect(uiStore.errorMessage).toBeNull();
  });
});
