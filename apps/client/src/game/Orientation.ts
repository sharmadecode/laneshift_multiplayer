/**
 * Mobile: forces the game into landscape.
 * Browsers can't hard-lock orientation outside fullscreen, so we
 * request fullscreen + screen.orientation.lock('landscape') on the
 * first tap (Chrome Android applies the real lock there), and show a
 * "rotate your device" overlay whenever portrait is detected.
 */
export function initOrientationLock(): void {
  if (!window.matchMedia('(pointer: coarse)').matches) return;

  const overlay = document.createElement('div');
  overlay.className = 'rotate-overlay';
  overlay.innerHTML =
    '<div class="rotate-icon">&#8635;</div>' +
    '<div class="rotate-box">Rotate your device<br/>to landscape</div>';
  document.body.appendChild(overlay);

  function tryLock(): void {
    if (!document.fullscreenElement) return;
    const o = screen.orientation as { lock?: (type: string) => Promise<void> } | undefined;
    if (o && o.lock) {
      o.lock('landscape').catch(() => undefined);
    }
  }

  function update(): void {
    const portrait = window.innerHeight > window.innerWidth;
    overlay.style.display = portrait ? 'flex' : 'none';
    if (!portrait) tryLock();
  }

  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
  update();

  document.addEventListener(
    'pointerdown',
    () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => undefined);
      }
      tryLock();
    },
    { passive: true }
  );
}
