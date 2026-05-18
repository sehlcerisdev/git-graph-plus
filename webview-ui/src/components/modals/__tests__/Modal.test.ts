import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
// Modal expects a Snippet child; CreateBranchModal renders Modal internally
// so reuse it as the harness — keeps us testing the real wiring without a
// per-test wrapper component.
import CreateBranchModal from '../CreateBranchModal.svelte';

describe('Modal (close behavior, exercised via CreateBranchModal)', () => {
  it('Escape key triggers onClose', async () => {
    const onClose = vi.fn();
    render(CreateBranchModal, { startPoint: 'main', onClose, onCreate: vi.fn() });
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape only fires onClose once even if the user mashes the key', async () => {
    const onClose = vi.fn();
    render(CreateBranchModal, { startPoint: 'main', onClose, onCreate: vi.fn() });
    await fireEvent.keyDown(window, { key: 'Escape' });
    await fireEvent.keyDown(window, { key: 'Escape' });
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the dedicated close button triggers onClose', async () => {
    const onClose = vi.fn();
    const { container } = render(CreateBranchModal, { startPoint: 'main', onClose, onCreate: vi.fn() });
    const closeBtn = container.querySelector<HTMLButtonElement>('.modal-close');
    await fireEvent.click(closeBtn!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicks inside the dialog do NOT bubble to the overlay close handler', async () => {
    const onClose = vi.fn();
    const { container } = render(CreateBranchModal, { startPoint: 'main', onClose, onCreate: vi.fn() });
    const dialog = container.querySelector<HTMLDivElement>('.modal');
    await fireEvent.click(dialog!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders the title from the i18n key', () => {
    const { container } = render(CreateBranchModal, { startPoint: 'main', onClose: vi.fn(), onCreate: vi.fn() });
    const title = container.querySelector('.modal-title');
    expect(title?.textContent?.trim().length).toBeGreaterThan(0);
  });
});
