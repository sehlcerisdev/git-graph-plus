export function tooltip(node: HTMLElement, text: string | undefined) {
  let el: HTMLDivElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let mouseX = 0;
  let mouseY = 0;

  function position() {
    if (!el) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const { width, height } = el.getBoundingClientRect();

    const OFFSET_X = 8;
    const OFFSET_Y = 14;

    let x = mouseX + OFFSET_X;
    let y = mouseY + OFFSET_Y;

    if (x + width > vw - 4) x = mouseX - width - OFFSET_X;
    if (y + height > vh - 4) y = mouseY - height - 4;

    el.style.left = `${Math.max(4, x)}px`;
    el.style.top = `${Math.max(4, y)}px`;
  }

  function onMouseMove(e: MouseEvent) {
    mouseX = e.clientX;
    mouseY = e.clientY;
    position();
  }

  function show(e: MouseEvent) {
    if (!text) return;
    mouseX = e.clientX;
    mouseY = e.clientY;
    timer = setTimeout(() => {
      el = document.createElement('div');
      el.className = 'vsg-tooltip';
      el.textContent = text ?? null;
      document.body.appendChild(el);
      position();
    }, 500);
  }

  function hide() {
    if (timer) { clearTimeout(timer); timer = null; }
    el?.remove();
    el = null;
  }

  node.addEventListener('mouseenter', show);
  node.addEventListener('mousemove', onMouseMove);
  node.addEventListener('mouseleave', hide);

  return {
    update(t: string | undefined) {
      text = t;
      if (el) { el.textContent = t ?? null; position(); }
    },
    destroy() {
      hide();
      node.removeEventListener('mouseenter', show);
      node.removeEventListener('mousemove', onMouseMove);
      node.removeEventListener('mouseleave', hide);
    }
  };
}
