import { MS_TO_KMH } from '@hr/shared';

export type Preset = 'low' | 'medium' | 'high';

export interface HudCallbacks {
  onPreset: (p: Preset) => void;
  onAutoThrottle: (b: boolean) => void;
  onSensitivity: (n: number) => void;
  onSound: (b: boolean) => void;
  onStart: () => void;
  onPauseToggle: () => void;
  onRestart: () => void;
}

const LS_PRESET = 'hr.preset';
const LS_AUTO = 'hr.autoThrottle.v2'; // v2: invalidates the old inverted default
const LS_SENS = 'hr.sensitivity';
const LS_SOUND = 'hr.sound';

export class Hud {
  readonly steerLeftBtn: HTMLElement;
  readonly steerRightBtn: HTMLElement;
  readonly brakeBtn: HTMLElement;
  readonly throttleBtn: HTMLElement;

  autoThrottle = false;
  sensitivity = 1;
  sound = true;
  preset: Preset = 'medium';

  private speedEl: HTMLElement;
  private distEl: HTMLElement;
  private crashOverlay: HTMLElement;
  private crashSub: HTMLElement;
  private steerHint: HTMLElement;
  private netChip: HTMLElement;
  private startOverlay: HTMLElement;
  private pauseOverlay: HTMLElement;
  private pauseDist: HTMLElement;
  private lastDistance = 0;

  constructor(private root: HTMLElement, private cb: HudCallbacks) {
    this.loadSettings();

    const hud = document.createElement('div');
    hud.className = 'hud';
    hud.innerHTML = `
      <div class="hud-top-left">
        <div class="hud-speed">0<small>km/h</small></div>
        <div class="hud-distance">0 m</div>
        <div class="net-chip">OFFLINE</div>
      </div>
      <button class="settings-btn glass">&#9881;</button>
      <button class="pause-btn glass" aria-label="Pause">&#10073;&#10073;</button>
      <div class="settings-panel glass" style="display:none">
        <div class="panel-title">Settings</div>
        <div class="setting-row">
          <label for="hr-preset">Graphics</label>
          <div class="select-wrap">
            <select id="hr-preset">
              <option value="low">Low — 30 FPS</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
        </div>
        <div class="setting-row switch-row">
          <label for="hr-auto">Auto throttle</label>
          <label class="switch">
            <input type="checkbox" id="hr-auto" />
            <span class="switch-track"></span>
          </label>
        </div>
        <div class="setting-row switch-row">
          <label for="hr-sound">Sound</label>
          <label class="switch">
            <input type="checkbox" id="hr-sound" />
            <span class="switch-track"></span>
          </label>
        </div>
        <div class="setting-row">
          <label for="hr-sens">Steering <span class="setting-val" id="hr-sens-val"></span></label>
          <input type="range" id="hr-sens" min="0.5" max="1.5" step="0.05" />
        </div>
      </div>
      <button class="ctl-btn glass ctl-left"><span class="ctl-icon">&#9664;</span></button>
      <button class="ctl-btn glass ctl-right"><span class="ctl-icon">&#9654;</span></button>
      <button class="ctl-btn glass ctl-brake"><span class="ctl-label">BRAKE</span></button>
      <button class="ctl-btn glass ctl-throttle"><span class="ctl-label">THROTTLE</span></button>
      <div class="crash-overlay hidden">
        <div class="crash-box">
          <div class="title">WRECKED</div>
          <div class="sub">Respawn in <span class="crash-t">3.0</span>s</div>
        </div>
      </div>
      <div class="pause-overlay hidden">
        <div class="pause-card glass">
          <div class="panel-title">Paused</div>
          <div class="pause-dist" id="hr-pause-dist">0 m</div>
          <button class="menu-btn glass" id="hr-resume">RESUME</button>
          <button class="menu-btn glass" id="hr-restart">RESTART</button>
        </div>
      </div>
      <div class="start-overlay">
        <div class="start-card">
          <div class="game-title">HIGHWAY RUSH</div>
          <div class="game-sub">neon arcade racing</div>
          <button class="menu-btn glass start-btn">TAP TO START</button>
          <div class="start-hint"></div>
        </div>
      </div>
      <div class="steer-indicator">&#9664; HOLD TO STEER &#9654;</div>
      <div class="hud-hint">A/D or &#8592;&#8594; steer &middot; W/S throttle</div>
    `;
    this.root.appendChild(hud);

    this.speedEl = hud.querySelector('.hud-speed')!;
    this.distEl = hud.querySelector('.hud-distance')!;
    this.crashOverlay = hud.querySelector('.crash-overlay')!;
    this.crashSub = hud.querySelector('.crash-t')!;
    this.steerLeftBtn = hud.querySelector('.ctl-left')!;
    this.steerRightBtn = hud.querySelector('.ctl-right')!;
    this.brakeBtn = hud.querySelector('.ctl-brake')!;
    this.throttleBtn = hud.querySelector('.ctl-throttle')!;
    this.steerHint = hud.querySelector('.steer-indicator')!;
    this.startOverlay = hud.querySelector('.start-overlay')!;
    this.pauseOverlay = hud.querySelector('.pause-overlay')!;
    this.pauseDist = hud.querySelector('#hr-pause-dist')!;
    this.netChip = hud.querySelector('.net-chip')!;

    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    for (const b of [this.steerLeftBtn, this.steerRightBtn, this.brakeBtn, this.throttleBtn]) {
      b.style.display = isTouch ? 'flex' : 'none';
    }
    this.steerHint.style.display = isTouch ? 'block' : 'none';
    const hint = isTouch
      ? 'steer with the arrow buttons, drive with BRAKE/THROTTLE'
      : 'A/D or \u2190\u2192 steer \u00b7 W/S throttle';
    hud.querySelector('.hud-hint')!.textContent = hint;
    hud.querySelector('.start-hint')!.textContent = isTouch
      ? 'tap to race \u00b7 \u23F8 to pause'
      : 'click or press any key \u00b7 P to pause';

    // settings wiring
    const panel = hud.querySelector('.settings-panel') as HTMLElement;
    const gear = hud.querySelector('.settings-btn') as HTMLButtonElement;
    gear.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    });

    hud.querySelector('.pause-btn')!.addEventListener('click', () => this.cb.onPauseToggle());

    // start overlay: any tap on it starts the run
    this.startOverlay.addEventListener('pointerdown', () => this.cb.onStart());

    // pause overlay buttons
    hud.querySelector('#hr-resume')!.addEventListener('click', () => this.cb.onPauseToggle());
    hud.querySelector('#hr-restart')!.addEventListener('click', () => this.cb.onRestart());

    const presetSel = hud.querySelector('#hr-preset') as HTMLSelectElement;
    presetSel.value = this.preset;
    presetSel.addEventListener('change', () => {
      this.preset = presetSel.value as Preset;
      localStorage.setItem(LS_PRESET, this.preset);
      this.cb.onPreset(this.preset);
    });

    const autoBox = hud.querySelector('#hr-auto') as HTMLInputElement;
    autoBox.checked = this.autoThrottle;
    autoBox.addEventListener('change', () => {
      this.autoThrottle = autoBox.checked;
      localStorage.setItem(LS_AUTO, String(this.autoThrottle));
      this.cb.onAutoThrottle(this.autoThrottle);
    });

    const soundBox = hud.querySelector('#hr-sound') as HTMLInputElement;
    soundBox.checked = this.sound;
    soundBox.addEventListener('change', () => {
      this.sound = soundBox.checked;
      localStorage.setItem(LS_SOUND, String(this.sound));
      this.cb.onSound(this.sound);
    });

    const sens = hud.querySelector('#hr-sens') as HTMLInputElement;
    const sensVal = hud.querySelector('#hr-sens-val') as HTMLElement;
    sens.value = String(this.sensitivity);
    sensVal.textContent = `x${this.sensitivity.toFixed(2)}`;
    sens.addEventListener('input', () => {
      this.sensitivity = Number(sens.value);
      sensVal.textContent = `x${this.sensitivity.toFixed(2)}`;
      localStorage.setItem(LS_SENS, String(this.sensitivity));
      this.cb.onSensitivity(this.sensitivity);
    });
  }

  update(state: { speed: number; distance: number }): void {
    this.lastDistance = state.distance;
    this.speedEl.innerHTML = `${Math.round(state.speed * MS_TO_KMH)}<small>km/h</small>`;
    const km = state.distance >= 1000;
    this.distEl.textContent = km
      ? `${(state.distance / 1000).toFixed(2)} km`
      : `${Math.round(state.distance)} m`;
  }

  startGame(): void {
    this.startOverlay.style.display = 'none';
  }

  setPaused(paused: boolean): void {
    this.pauseOverlay.classList.toggle('hidden', !paused);
    if (paused) {
      const km = this.lastDistance >= 1000;
      this.pauseDist.textContent = km
        ? `${(this.lastDistance / 1000).toFixed(2)} km`
        : `${Math.round(this.lastDistance)} m`;
    }
  }

  resetRun(): void {
    this.lastDistance = 0;
    this.speedEl.innerHTML = `0<small>km/h</small>`;
    this.distEl.textContent = '0 m';
    this.crashOverlay.classList.add('hidden');
  }

  setNet(text: string, ok: boolean): void {
    if (this.netChip.textContent === text) return;
    this.netChip.textContent = text;
    this.netChip.classList.toggle('ok', ok);
  }

  showCrash(timer: number): void {
    this.crashOverlay.classList.remove('hidden');
    this.crashSub.textContent = timer.toFixed(1);
  }

  updateCrashTimer(timer: number): void {
    if (!this.crashOverlay.classList.contains('hidden')) {
      this.crashSub.textContent = timer.toFixed(1);
    }
  }

  hideCrash(): void {
    this.crashOverlay.classList.add('hidden');
  }

  private loadSettings(): void {
    const p = localStorage.getItem(LS_PRESET);
    if (p === 'low' || p === 'medium' || p === 'high') this.preset = p;
    const a = localStorage.getItem(LS_AUTO);
    if (a !== null) this.autoThrottle = a === 'true';
    const s = Number(localStorage.getItem(LS_SENS));
    if (Number.isFinite(s) && s > 0) this.sensitivity = s;
    const so = localStorage.getItem(LS_SOUND);
    if (so !== null) this.sound = so === 'true';
  }
}
