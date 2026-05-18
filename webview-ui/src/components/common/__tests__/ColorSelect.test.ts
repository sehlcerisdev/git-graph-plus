import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import ColorSelect from '../ColorSelect.svelte';

const options = [
  { value: 'main', label: 'main', color: '#4caf50' },
  { value: 'feature/x', label: 'feature/x', color: '#2196f3' },
  { value: 'develop', label: 'develop', color: '#9c27b0' },
];

describe('ColorSelect', () => {
  it('shows the option matching `value` as the current selection', () => {
    const { container } = render(ColorSelect, {
      options, value: 'develop', onChange: vi.fn(),
    });
    const label = container.querySelector('.color-select-btn .label');
    expect(label?.textContent).toBe('develop');
  });

  it('falls back to the first option when value matches nothing', () => {
    const { container } = render(ColorSelect, {
      options, value: 'unknown', onChange: vi.fn(),
    });
    const label = container.querySelector('.color-select-btn .label');
    expect(label?.textContent).toBe('main');
  });

  it('does not render the dropdown until the button is clicked', () => {
    const { container } = render(ColorSelect, {
      options, value: 'main', onChange: vi.fn(),
    });
    expect(container.querySelector('.color-select-dropdown')).toBeNull();
  });

  it('clicking the button opens the dropdown with one row per option', async () => {
    const { container } = render(ColorSelect, {
      options, value: 'main', onChange: vi.fn(),
    });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.color-select-btn')!);
    const dropdown = container.querySelector('.color-select-dropdown');
    expect(dropdown).not.toBeNull();
    expect(dropdown!.querySelectorAll('.color-select-option').length).toBe(3);
  });

  it('selecting an option calls onChange and closes the dropdown', async () => {
    const onChange = vi.fn();
    const { container } = render(ColorSelect, {
      options, value: 'main', onChange,
    });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.color-select-btn')!);
    const opts = container.querySelectorAll<HTMLButtonElement>('.color-select-dropdown .color-select-option');
    await fireEvent.click(opts[1]); // feature/x
    expect(onChange).toHaveBeenCalledWith('feature/x');
    expect(container.querySelector('.color-select-dropdown')).toBeNull();
  });

  it('marks the currently-selected option with .selected inside the open dropdown', async () => {
    const { container } = render(ColorSelect, {
      options, value: 'feature/x', onChange: vi.fn(),
    });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.color-select-btn')!);
    const selected = container.querySelector('.color-select-dropdown .color-select-option.selected');
    expect(selected?.textContent).toContain('feature/x');
  });

  it('clicking outside the component closes the open dropdown', async () => {
    const { container } = render(ColorSelect, {
      options, value: 'main', onChange: vi.fn(),
    });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.color-select-btn')!);
    expect(container.querySelector('.color-select-dropdown')).not.toBeNull();
    // capture-phase outside click handler.
    await fireEvent.click(document.body);
    expect(container.querySelector('.color-select-dropdown')).toBeNull();
  });

  it('renders the warning panel for the currently-selected option only when it carries warning text', () => {
    const optsWithWarn = [
      { value: 'safe', label: 'safe', color: '#4caf50' },
      { value: 'hard', label: 'hard', color: '#f44336', warning: 'Destructive — will discard changes' },
    ];
    const { container, rerender } = render(ColorSelect, {
      options: optsWithWarn, value: 'safe', onChange: vi.fn(),
    });
    expect(container.querySelector('.warning-message')).toBeNull();

    rerender({ options: optsWithWarn, value: 'hard', onChange: vi.fn() });
    const warn = container.querySelector('.warning-message');
    expect(warn?.textContent).toContain('Destructive');
  });
});
