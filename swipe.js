// Only the pad grid owns swipe navigation; normal taps still reach each pad.
export function attachSwipePages(element, { onPage }) {
  const document = element.ownerDocument;
  const window = document.defaultView;
  const listeners = [];
  let gesture = null;
  let suppressClickUntil = 0;
  const isTouch = event => event.pointerType === 'touch' || event.pointerType === 'pen';
  const listen = (target, type, handler, options) => {
    target?.addEventListener(type, handler, options);
    listeners.push(() => target?.removeEventListener(type, handler, options));
  };
  const suppressClick = () => { suppressClickUntil = Date.now() + 800; };
  const updatePosition = event => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    gesture.x = event.clientX;
    gesture.y = event.clientY;
    if (Math.hypot(gesture.x - gesture.startX, gesture.y - gesture.startY) > 10) gesture.dragged = true;
  };
  const cancel = () => {
    if (gesture) suppressClick();
    gesture = null;
  };

  // Observe extra fingers even if they land outside the grid. These listeners
  // never cancel pointer events or interfere with scrolling elsewhere.
  listen(document, 'pointerdown', event => {
    if (gesture && isTouch(event) && event.pointerId !== gesture.pointerId) {
      gesture.pointers.add(event.pointerId);
      gesture.cancelled = true;
      suppressClick();
    }
  }, { capture: true, passive: true });
  listen(element, 'pointerdown', event => {
    if (!isTouch(event)) {
      if (!gesture) suppressClickUntil = 0;
      return;
    }
    if (event.isPrimary === false || event.button !== 0 || gesture) return;
    suppressClickUntil = 0;
    gesture = {
      pointerId: event.pointerId, pointers: new Set([event.pointerId]),
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
      dragged: false, cancelled: false
    };
  }, { passive: true });
  listen(document, 'pointermove', updatePosition, { capture: true, passive: true });
  listen(document, 'pointerup', event => {
    if (!gesture || !gesture.pointers.has(event.pointerId)) return;
    updatePosition(event);
    gesture.pointers.delete(event.pointerId);
    if (gesture.dragged || gesture.cancelled) suppressClick();
    if (gesture.pointers.size) return;
    const completed = gesture;
    gesture = null;
    const dx = completed.x - completed.startX;
    const dy = completed.y - completed.startY;
    if (!completed.cancelled && Math.abs(dx) >= 45 && Math.abs(dx) >= Math.abs(dy) * 1.4) {
      // Install the guard before the callback replaces the page's buttons.
      suppressClick();
      onPage(dx < 0 ? 1 : -1);
    }
  }, { capture: true, passive: true });
  listen(document, 'pointercancel', event => {
    if (!gesture || !gesture.pointers.has(event.pointerId)) return;
    gesture.cancelled = true;
    gesture.pointers.delete(event.pointerId);
    suppressClick();
    if (!gesture.pointers.size) gesture = null;
  }, { capture: true, passive: true });
  listen(element, 'click', event => {
    // Keyboard activation has detail 0. A fresh pointerdown also clears the
    // guard, so the next intentional tap never has to wait for this timeout.
    if (Date.now() < suppressClickUntil && (event.detail > 0 || isTouch(event))) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, { capture: true });
  listen(window, 'blur', cancel);
  listen(document, 'visibilitychange', () => { if (document.hidden) cancel(); });

  return () => {
    listeners.forEach(remove => remove());
    gesture = null;
    suppressClickUntil = 0;
  };
}
