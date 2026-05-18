import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import DeleteTagModal from '../DeleteTagModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

const baseProps = { tagName: 'v1.0', onClose: vi.fn(), onDelete: vi.fn() };

beforeEach(() => { i18n.setLocale('en'); });

describe('DeleteTagModal', () => {
  it('renders the tag name in the description', () => {
    const { container } = render(DeleteTagModal, baseProps);
    expect(container.querySelector('.modal-desc')?.innerHTML).toContain('v1.0');
  });

  it('passes deleteRemote=false by default', async () => {
    const onDelete = vi.fn();
    const { container } = render(DeleteTagModal, { ...baseProps, onDelete });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.danger-btn')!);
    expect(onDelete).toHaveBeenCalledWith(false);
  });

  it('shows the remote checkbox only when hasRemote=true', () => {
    const noRemote = render(DeleteTagModal, baseProps);
    expect(noRemote.container.querySelector('.modal-checkbox')).toBeNull();
    noRemote.unmount();

    const hasRemote = render(DeleteTagModal, { ...baseProps, hasRemote: true });
    expect(hasRemote.container.querySelector('.modal-checkbox')).not.toBeNull();
  });

  it('checking the remote box propagates deleteRemote=true', async () => {
    const onDelete = vi.fn();
    const { container } = render(DeleteTagModal, { ...baseProps, hasRemote: true, onDelete });
    await fireEvent.click(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.danger-btn')!);
    expect(onDelete).toHaveBeenCalledWith(true);
  });

  it('cancel fires onClose, not onDelete', async () => {
    const onClose = vi.fn();
    const onDelete = vi.fn();
    const { container } = render(DeleteTagModal, { ...baseProps, onClose, onDelete });
    await fireEvent.click(container.querySelectorAll('button')[0]);
    expect(onClose).toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });
});
