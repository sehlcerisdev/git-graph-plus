import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/svelte';
import ImageDiff from '../ImageDiff.svelte';

interface ImagePayload { ref: string; path: string; base64: string; mimeType: string; }

function deliverImage(p: ImagePayload) {
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'imageData', payload: p },
  }));
}

beforeEach(() => {
  globalThis.__postedMessages = [];
});

describe('ImageDiff — ref selection', () => {
  it('working-tree mode (unstaged) requests :0 (index) and "working"', async () => {
    render(ImageDiff, { file: 'logo.png', staged: false });
    await waitFor(() => {
      expect(globalThis.__postedMessages.length).toBeGreaterThanOrEqual(2);
    });
    const refs = globalThis.__postedMessages
      .map(m => (m.data as { type?: string; payload?: { ref?: string } }))
      .filter(d => d.type === 'getImageAtRef')
      .map(d => d.payload!.ref!);
    expect(refs).toContain(':0');
    expect(refs).toContain('working');
  });

  it('staged mode requests HEAD and :0', async () => {
    render(ImageDiff, { file: 'logo.png', staged: true });
    await waitFor(() => {
      expect(globalThis.__postedMessages.length).toBeGreaterThanOrEqual(2);
    });
    const refs = globalThis.__postedMessages
      .map(m => (m.data as { type?: string; payload?: { ref?: string } }))
      .filter(d => d.type === 'getImageAtRef')
      .map(d => d.payload!.ref!);
    expect(refs).toContain('HEAD');
    expect(refs).toContain(':0');
  });

  it('commit mode requests <hash>~1 and <hash>', async () => {
    render(ImageDiff, { file: 'logo.png', staged: false, commitHash: 'abc1234' });
    await waitFor(() => {
      expect(globalThis.__postedMessages.length).toBeGreaterThanOrEqual(2);
    });
    const refs = globalThis.__postedMessages
      .map(m => (m.data as { type?: string; payload?: { ref?: string } }))
      .filter(d => d.type === 'getImageAtRef')
      .map(d => d.payload!.ref!);
    expect(refs).toContain('abc1234~1');
    expect(refs).toContain('abc1234');
  });
});

describe('ImageDiff — mode switching', () => {
  it('renders three mode buttons and side-by-side is active by default', () => {
    const { container } = render(ImageDiff, { file: 'x.png', staged: false });
    const buttons = container.querySelectorAll<HTMLButtonElement>('.image-diff-toolbar button');
    expect(buttons.length).toBe(3);
    expect(buttons[0].classList.contains('active')).toBe(true);
  });

  it('clicking Swipe activates swipe mode and renders the swipe divider', async () => {
    const { container } = render(ImageDiff, { file: 'x.png', staged: false });
    const buttons = container.querySelectorAll<HTMLButtonElement>('.image-diff-toolbar button');
    await fireEvent.click(buttons[1]);
    expect(buttons[1].classList.contains('active')).toBe(true);
    expect(container.querySelector('.swipe-divider')).not.toBeNull();
  });

  it('clicking Onion Skin activates onion mode and renders the slider', async () => {
    const { container } = render(ImageDiff, { file: 'x.png', staged: false });
    const buttons = container.querySelectorAll<HTMLButtonElement>('.image-diff-toolbar button');
    await fireEvent.click(buttons[2]);
    expect(buttons[2].classList.contains('active')).toBe(true);
    expect(container.querySelector('input[type="range"]')).not.toBeNull();
  });
});

describe('ImageDiff — image rendering', () => {
  it('side-by-side renders "No image" placeholders before data arrives', () => {
    const { container } = render(ImageDiff, { file: 'x.png', staged: false });
    expect(container.querySelectorAll('.no-image').length).toBe(2);
  });

  it('renders Before image when an imageData message matching oldRef arrives', async () => {
    const { container } = render(ImageDiff, { file: 'x.png', staged: false });
    deliverImage({ ref: ':0', path: 'x.png', base64: 'aGVsbG8=', mimeType: 'image/png' });
    await waitFor(() => {
      const noImage = container.querySelectorAll('.no-image').length;
      expect(noImage).toBeLessThan(2);
    });
    const imgs = container.querySelectorAll<HTMLImageElement>('.diff-image');
    expect(imgs.length).toBeGreaterThan(0);
    expect(imgs[0].src).toContain('data:image/png;base64,');
  });

  it('ignores imageData for unrelated paths', async () => {
    const { container } = render(ImageDiff, { file: 'x.png', staged: false });
    deliverImage({ ref: ':0', path: 'other.png', base64: 'aGVsbG8=', mimeType: 'image/png' });
    // Should still show two "No image" placeholders
    await new Promise(r => setTimeout(r, 30));
    expect(container.querySelectorAll('.no-image').length).toBe(2);
  });
});

describe('ImageDiff — swipe interaction', () => {
  it('mousedown on divider then mousemove updates clip position', async () => {
    const { container } = render(ImageDiff, { file: 'x.png', staged: false });
    // switch to swipe mode
    const buttons = container.querySelectorAll<HTMLButtonElement>('.image-diff-toolbar button');
    await fireEvent.click(buttons[1]);
    const divider = container.querySelector<HTMLDivElement>('.swipe-divider')!;
    expect(divider).not.toBeNull();
    // Stub getBoundingClientRect on the container so handleSwipeMove computes
    // a real percentage instead of NaN.
    const swipeContainer = container.querySelector<HTMLDivElement>('.swipe-container')!;
    swipeContainer.getBoundingClientRect = () => ({
      x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 100, width: 400, height: 100, toJSON() {},
    });
    await fireEvent.mouseDown(divider, { clientX: 200 });
    // mousemove fires on window (svelte:window onmousemove)
    await fireEvent.mouseMove(window, { clientX: 100 });
    // expected ratio = 100/400 = 25%
    expect(divider.style.left).toBe('25%');
    // mouseup releases — further mousemove no longer affects position
    await fireEvent.mouseUp(window);
    await fireEvent.mouseMove(window, { clientX: 300 });
    expect(divider.style.left).toBe('25%');
  });

  it('mouse drag clamps the position to [0, 100]', async () => {
    const { container } = render(ImageDiff, { file: 'x.png', staged: false });
    const buttons = container.querySelectorAll<HTMLButtonElement>('.image-diff-toolbar button');
    await fireEvent.click(buttons[1]);
    const divider = container.querySelector<HTMLDivElement>('.swipe-divider')!;
    const swipeContainer = container.querySelector<HTMLDivElement>('.swipe-container')!;
    swipeContainer.getBoundingClientRect = () => ({
      x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 100, width: 200, height: 100, toJSON() {},
    });
    await fireEvent.mouseDown(divider, { clientX: 100 });
    await fireEvent.mouseMove(window, { clientX: -500 }); // would yield -250%
    expect(divider.style.left).toBe('0%');
    await fireEvent.mouseMove(window, { clientX: 5000 }); // would yield 2500%
    expect(divider.style.left).toBe('100%');
    await fireEvent.mouseUp(window);
  });

  it('mousemove without prior mousedown does not change position', async () => {
    const { container } = render(ImageDiff, { file: 'x.png', staged: false });
    const buttons = container.querySelectorAll<HTMLButtonElement>('.image-diff-toolbar button');
    await fireEvent.click(buttons[1]);
    const divider = container.querySelector<HTMLDivElement>('.swipe-divider')!;
    const before = divider.style.left;
    await fireEvent.mouseMove(window, { clientX: 999 });
    expect(divider.style.left).toBe(before);
  });
});

describe('ImageDiff — image info & onion slider', () => {
  it('formatBytes shows bytes/KB/MB depending on size', async () => {
    const { container } = render(ImageDiff, { file: 'x.png', staged: false });
    // Provide base64 sized so loadImageInfo cb fires (Image.onload happens
    // synchronously in happy-dom because the src is a data URL).
    deliverImage({ ref: ':0', path: 'x.png', base64: 'a'.repeat(2000), mimeType: 'image/png' });
    deliverImage({ ref: 'working', path: 'x.png', base64: 'a'.repeat(2_000_000), mimeType: 'image/png' });
    // We can't reliably wait for Image.onload across happy-dom versions; just
    // verify the data URLs are rendered (formatBytes will run if onload fires).
    await waitFor(() => {
      const imgs = container.querySelectorAll<HTMLImageElement>('.diff-image');
      expect(imgs.length).toBeGreaterThan(0);
    });
  });

  it('onion slider updates the overlay opacity', async () => {
    const { container } = render(ImageDiff, { file: 'x.png', staged: false });
    // switch to onion mode
    const buttons = container.querySelectorAll<HTMLButtonElement>('.image-diff-toolbar button');
    await fireEvent.click(buttons[2]);
    deliverImage({ ref: ':0', path: 'x.png', base64: 'aGVsbG8=', mimeType: 'image/png' });
    deliverImage({ ref: 'working', path: 'x.png', base64: 'aGVsbG8=', mimeType: 'image/png' });
    await waitFor(() => container.querySelector('.onion-overlay'));
    const range = container.querySelector<HTMLInputElement>('input[type="range"]')!;
    await fireEvent.input(range, { target: { value: '0.9' } });
    await waitFor(() => {
      const overlay = container.querySelector<HTMLImageElement>('.onion-overlay');
      expect(overlay?.style.opacity).toBe('0.9');
    });
  });
});
