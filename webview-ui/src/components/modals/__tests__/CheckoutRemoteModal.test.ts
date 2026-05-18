import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import CheckoutRemoteModal from '../CheckoutRemoteModal.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

beforeEach(() => { i18n.setLocale('en'); });

describe('CheckoutRemoteModal', () => {
  it('seeds the local name field from defaultLocalName', () => {
    const { container } = render(CheckoutRemoteModal, {
      remoteName: 'origin/feature/x',
      defaultLocalName: 'feature/x',
      dirty: false,
      onClose: vi.fn(),
      onCheckout: vi.fn(),
    });
    const input = container.querySelector<HTMLInputElement>('#checkout-local-name')!;
    expect(input.value).toBe('feature/x');
  });

  it('hides the dirty radio group when dirty=false', () => {
    const { container } = render(CheckoutRemoteModal, {
      remoteName: 'origin/x', defaultLocalName: 'x', dirty: false,
      onClose: vi.fn(), onCheckout: vi.fn(),
    });
    expect(container.querySelector('input[type="radio"]')).toBeNull();
  });

  it('shows three dirty options when dirty=true', () => {
    const { container } = render(CheckoutRemoteModal, {
      remoteName: 'origin/x', defaultLocalName: 'x', dirty: true,
      onClose: vi.fn(), onCheckout: vi.fn(),
    });
    expect(container.querySelectorAll('input[type="radio"]').length).toBe(3);
  });

  it('disables submit when local name is blank', async () => {
    const { container } = render(CheckoutRemoteModal, {
      remoteName: 'origin/x', defaultLocalName: '', dirty: false,
      onClose: vi.fn(), onCheckout: vi.fn(),
    });
    expect(container.querySelector<HTMLButtonElement>('button.primary')!.disabled).toBe(true);
  });

  it('forwards trimmed local name and chosen dirty option', async () => {
    const onCheckout = vi.fn();
    const { container } = render(CheckoutRemoteModal, {
      remoteName: 'origin/x', defaultLocalName: '  feature/x  ', dirty: true,
      onClose: vi.fn(), onCheckout,
    });
    const stash = container.querySelector<HTMLInputElement>('input[type="radio"][value="stash"]')!;
    await fireEvent.click(stash);
    await tick();
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onCheckout).toHaveBeenCalledWith('feature/x', 'stash');
  });
});
