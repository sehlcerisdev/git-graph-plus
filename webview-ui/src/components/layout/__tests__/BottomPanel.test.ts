import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/svelte';
import BottomPanel from '../BottomPanel.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import { uiStore } from '../../../lib/stores/ui.svelte';
import { commitStore } from '../../../lib/stores/commits.svelte';
import type { Commit } from '../../../lib/types';

function commit(over: Partial<Commit> = {}): Commit {
  return {
    hash: 'h',
    abbreviatedHash: 'h',
    author: { name: 'A', email: 'a@x.com', date: '' },
    committer: { name: 'A', email: 'a@x.com', date: '' },
    subject: 's',
    body: '',
    parents: [],
    refs: [],
    ...over,
  };
}

beforeEach(() => {
  i18n.setLocale('en');
  uiStore.selectedCommitHash = null;
  uiStore.comparing = false;
  commitStore.commits = [];
});

describe('BottomPanel', () => {
  it('shows the empty-state hint when nothing is selected', () => {
    const { container } = render(BottomPanel);
    expect(container.querySelector('.empty')).not.toBeNull();
  });

  it('renders CommitDetails when a commit is selected', () => {
    commitStore.commits = [commit({ hash: 'h1', subject: 'fix' })];
    uiStore.selectedCommitHash = 'h1';
    const { container } = render(BottomPanel);
    expect(container.querySelector('.empty')).toBeNull();
  });

  it('renders CommitDetails (in compare mode) when comparing is true', () => {
    uiStore.comparing = true;
    const { container } = render(BottomPanel);
    expect(container.querySelector('.empty')).toBeNull();
  });
});
