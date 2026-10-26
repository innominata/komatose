/**
 * Calls `onclose` when the backdrop itself is clicked, but only when the press
 * also started on the backdrop. A drag that begins inside the modal (such as
 * selecting text) and is released outside it no longer closes the modal.
 */
export function backdropClose(node: HTMLElement, onclose: () => void) {
  let close = onclose;
  let pressedBackdrop = false;
  const down = (e: PointerEvent) => { pressedBackdrop = e.target === node; };
  const click = (e: MouseEvent) => {
    const fromBackdrop = pressedBackdrop && e.target === node;
    pressedBackdrop = false;
    if (fromBackdrop) close();
  };
  node.addEventListener('pointerdown', down);
  node.addEventListener('click', click);
  return {
    update(next: () => void) { close = next; },
    destroy() {
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('click', click);
    },
  };
}
