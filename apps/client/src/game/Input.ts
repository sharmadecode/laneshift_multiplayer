import type { InputState } from '@hr/simulation';

export interface InputOptions {
  onSteerVisual?: (dir: -1 | 0 | 1) => void;
}

export class Input {
  autoThrottle = true;
  sensitivity = 1;

  private keys = new Set<string>();
  private leftHeld = false;
  private rightHeld = false;
  private brakeHeld = false;
  private throttleHeld = false;
  private onSteerVisual?: (dir: -1 | 0 | 1) => void;

  constructor(
    steerLeftBtn: HTMLElement,
    steerRightBtn: HTMLElement,
    brakeBtn: HTMLElement,
    throttleBtn: HTMLElement,
    opts: InputOptions = {}
  ) {
    this.onSteerVisual = opts.onSteerVisual;

    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
      }
      this.emitSteer();
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      this.emitSteer();
    });
    window.addEventListener('blur', () => this.keys.clear());

    this.attachHold(steerLeftBtn, (v) => (this.leftHeld = v));
    this.attachHold(steerRightBtn, (v) => (this.rightHeld = v));
    this.attachHold(brakeBtn, (v) => (this.brakeHeld = v));
    this.attachHold(throttleBtn, (v) => (this.throttleHeld = v));
  }

  private attachHold(el: HTMLElement, set: (v: boolean) => void): void {
    const down = (e: PointerEvent) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add('active');
      set(true);
      this.emitSteer();
    };
    const up = (e: PointerEvent) => {
      e.preventDefault();
      el.classList.remove('active');
      set(false);
      this.emitSteer();
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', up);
  }

  private emitSteer(): void {
    if (this.onSteerVisual) this.onSteerVisual(this.steerFromKeysOrTouch());
  }

  private steerFromKeysOrTouch(): -1 | 0 | 1 {
    const k = this.keys;
    const kb = (k.has('ArrowLeft') || k.has('KeyA') ? -1 : 0) + (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0);
    const t = (this.leftHeld ? -1 : 0) + (this.rightHeld ? 1 : 0);
    const steer = kb + t;
    return Math.max(-1, Math.min(1, steer)) as -1 | 0 | 1;
  }

  /** Current input state for the simulation. */
  read(): InputState {
    const k = this.keys;
    const rawSteer = this.steerFromKeysOrTouch();
    const steering = Math.max(-1, Math.min(1, rawSteer * this.sensitivity));
    const brake =
      this.brakeHeld || k.has('ArrowDown') || k.has('KeyS') || k.has('Space') ? 1 : 0;
    const throttle =
      brake > 0
        ? 0
        : this.autoThrottle
          ? 1
          : k.has('ArrowUp') || k.has('KeyW') || this.throttleHeld
            ? 1
            : 0;
    return {
      steering,
      throttle,
      brake
    };
  }
}
