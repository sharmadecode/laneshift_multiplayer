import {
  DENSITY_MAX,
  DENSITY_MIN,
  MS_TO_KMH,
  ROOM_MAX_PLAYERS,
  ROOM_MODES,
  type FinishMsg,
  type MatchResultMsg,
  type RoomSettings,
  type RoomStateMsg
} from '@hr/shared';

export type Preset = 'low' | 'medium' | 'high';

export interface HudCallbacks {
  onPreset: (p: Preset) => void;
  onAutoThrottle: (b: boolean) => void;
  onSensitivity: (n: number) => void;
  onSound: (b: boolean) => void;
  onSolo: () => void;
  onQuickJoin: () => void;
  onCreateRoom: () => void;
  onJoinRoom: (code: string) => void;
  onLeaveRoom: () => void;
  onStartMatch: (settings: RoomSettings) => void;
  onRematch: () => void;
  onToMenu: () => void;
  onPauseToggle: () => void;
  onRestart: () => void;
}

const LS_PRESET = 'hr.preset';
const LS_AUTO = 'hr.autoThrottle.v2'; // v2: invalidates the old inverted default
const LS_SENS = 'hr.sensitivity';
const LS_SOUND = 'hr.sound';
const LS_NAME = 'hr.name';
const LS_MODE = 'hr.mode';
const LS_DENSITY = 'hr.density';

function fmtTime(ms: number): string {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}

export class Hud {
  readonly steerLeftBtn: HTMLElement;
  readonly steerRightBtn: HTMLElement;
  readonly brakeBtn: HTMLElement;
  readonly throttleBtn: HTMLElement;

  autoThrottle = false;
  sensitivity = 1;
  sound = true;
  preset: Preset = 'medium';
  name = '';
  settings: RoomSettings = { mode: 40, density: 0.8 };

  private speedEl: HTMLElement;
  private distEl: HTMLElement;
  private metaEl: HTMLElement;
  private crashOverlay: HTMLElement;
  private crashSub: HTMLElement;
  private steerHint: HTMLElement;
  private netChip: HTMLElement;
  private pauseOverlay: HTMLElement;
  private pauseDist: HTMLElement;
  private lastDistance = 0;
  private menuOverlay: HTMLElement;
  private nameInput: HTMLInputElement;
  private menuErr: HTMLElement;
  private codeInput: HTMLInputElement;
  private lobbyOverlay: HTMLElement;
  private lobbyCode: HTMLElement;
  private lobbyCount: HTMLElement;
  private copyBtn: HTMLButtonElement;
  private lobbyPlayers: HTMLElement;
  private lobbyStart: HTMLElement;
  private hostSettings: HTMLElement;
  private modeSel: HTMLSelectElement;
  private densitySlider: HTMLInputElement;
  private densityVal: HTMLElement;
  private lobbyErr: HTMLElement;
  private countdownOverlay: HTMLElement;
  private countdownNum: HTMLElement;
  private finishOverlay: HTMLElement;
  private finishRank: HTMLElement;
  private resultOverlay: HTMLElement;
  private resultRows: HTMLElement;
  private resultRematch: HTMLElement;
  private isHost = false;
  /** Set by Game before any showLobby call, so HOST badges resolve for rejoined players. */
  myPlayerId = '';

  constructor(private root: HTMLElement, private cb: HudCallbacks) {
    this.loadSettings();

    const hud = document.createElement('div');
    hud.className = 'hud';
    hud.innerHTML = `
      <div class="hud-top-left">
        <div class="hud-speed">0<small>km/h</small></div>
        <div class="hud-distance">0 m</div>
        <div class="race-meta hidden"></div>
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
      <div class="menu-overlay">
        <div class="menu-card">
          <div class="game-title">HIGHWAY RUSH</div>
          <div class="game-sub">neon arcade racing</div>
          <input class="name-input" maxlength="16" placeholder="your name" spellcheck="false" autocomplete="off" />
          <button class="menu-btn glass quickjoin-btn">QUICK JOIN</button>
          <button class="menu-btn glass create-btn">CREATE ROOM</button>
          <div class="join-row">
            <input class="code-input" maxlength="5" placeholder="CODE" spellcheck="false" autocomplete="off" />
            <button class="menu-btn glass join-btn">JOIN</button>
          </div>
          <button class="menu-btn glass solo-btn solo-ghost">SOLO RACE</button>
          <div class="menu-err"></div>
        </div>
      </div>
      <div class="lobby-overlay hidden">
        <div class="lobby-card glass">
          <div class="panel-title">Room</div>
          <div class="room-code"></div>
          <div class="room-code-hint">share this code to race together</div>
          <div class="lobby-count-row">
            <span class="lobby-count">0/6</span>
            <button class="copy-btn glass">COPY CODE</button>
          </div>
          <div class="lobby-players"></div>
          <div class="host-settings hidden">
            <div class="setting-row">
              <label for="hr-mode">Race length</label>
              <div class="select-wrap">
                <select id="hr-mode">
                  <option value="endless">Endless</option>
                  <option value="40">40 km</option>
                  <option value="60">60 km</option>
                  <option value="100">100 km</option>
                </select>
              </div>
            </div>
            <div class="setting-row">
              <label for="hr-density">Traffic <span class="setting-val" id="hr-density-val"></span></label>
              <input type="range" id="hr-density" min="0.55" max="1.3" step="0.05" />
            </div>
          </div>
          <button class="menu-btn glass start-btn lobby-start hidden">START RACE</button>
          <button class="menu-btn glass lobby-leave">LEAVE</button>
          <div class="lobby-err"></div>
        </div>
      </div>
      <div class="countdown-overlay hidden">
        <div class="countdown-num">3</div>
      </div>
      <div class="finish-overlay hidden">
        <div class="finish-box">
          <div class="finish-title">FINISHED</div>
          <div class="finish-rank">#2</div>
          <div class="finish-sub">waiting for other racers&#8230;</div>
        </div>
      </div>
      <div class="result-overlay hidden">
        <div class="result-card glass">
          <div class="panel-title">Race results</div>
          <div class="result-rows"></div>
          <button class="menu-btn glass result-rematch hidden">REMATCH</button>
          <button class="menu-btn glass result-menu">MENU</button>
        </div>
      </div>
      <div class="steer-indicator">&#9664; HOLD TO STEER &#9654;</div>
      <div class="hud-hint">A/D or &#8592;&#8594; steer &middot; W/S throttle</div>
    `;
    this.root.appendChild(hud);

    this.speedEl = hud.querySelector('.hud-speed')!;
    this.distEl = hud.querySelector('.hud-distance')!;
    this.metaEl = hud.querySelector('.race-meta')!;
    this.crashOverlay = hud.querySelector('.crash-overlay')!;
    this.crashSub = hud.querySelector('.crash-t')!;
    this.steerLeftBtn = hud.querySelector('.ctl-left')!;
    this.steerRightBtn = hud.querySelector('.ctl-right')!;
    this.brakeBtn = hud.querySelector('.ctl-brake')!;
    this.throttleBtn = hud.querySelector('.ctl-throttle')!;
    this.steerHint = hud.querySelector('.steer-indicator')!;
    this.pauseOverlay = hud.querySelector('.pause-overlay')!;
    this.pauseDist = hud.querySelector('#hr-pause-dist')!;
    this.netChip = hud.querySelector('.net-chip')!;
    this.menuOverlay = hud.querySelector('.menu-overlay')!;
    this.nameInput = hud.querySelector('.name-input')!;
    this.menuErr = hud.querySelector('.menu-err')!;
    this.codeInput = hud.querySelector('.code-input')!;
    this.lobbyOverlay = hud.querySelector('.lobby-overlay')!;
    this.lobbyCode = hud.querySelector('.room-code')!;
    this.lobbyCount = hud.querySelector('.lobby-count')!;
    this.copyBtn = hud.querySelector('.copy-btn')!;
    this.lobbyPlayers = hud.querySelector('.lobby-players')!;
    this.lobbyStart = hud.querySelector('.lobby-start')!;
    this.hostSettings = hud.querySelector('.host-settings')!;
    this.modeSel = hud.querySelector('#hr-mode')!;
    this.densitySlider = hud.querySelector('#hr-density')!;
    this.densityVal = hud.querySelector('#hr-density-val')!;
    this.lobbyErr = hud.querySelector('.lobby-err')!;
    this.countdownOverlay = hud.querySelector('.countdown-overlay')!;
    this.countdownNum = hud.querySelector('.countdown-num')!;
    this.finishOverlay = hud.querySelector('.finish-overlay')!;
    this.finishRank = hud.querySelector('.finish-rank')!;
    this.resultOverlay = hud.querySelector('.result-overlay')!;
    this.resultRows = hud.querySelector('.result-rows')!;
    this.resultRematch = hud.querySelector('.result-rematch')!;

    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    for (const b of [this.steerLeftBtn, this.steerRightBtn, this.brakeBtn, this.throttleBtn]) {
      b.style.display = isTouch ? 'flex' : 'none';
    }
    this.steerHint.style.display = isTouch ? 'block' : 'none';
    const hint = isTouch
      ? 'steer with the arrow buttons, drive with BRAKE/THROTTLE'
      : 'A/D or \u2190\u2192 steer \u00b7 W/S throttle';
    hud.querySelector('.hud-hint')!.textContent = hint;

    // settings wiring
    const panel = hud.querySelector('.settings-panel') as HTMLElement;
    const gear = hud.querySelector('.settings-btn') as HTMLButtonElement;
    gear.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    });

    hud.querySelector('.pause-btn')!.addEventListener('click', () => this.cb.onPauseToggle());

    // menu wiring
    this.nameInput.value = this.name;
    this.nameInput.addEventListener('input', () => {
      this.name = this.nameInput.value;
      localStorage.setItem(LS_NAME, this.name);
      this.menuErr.textContent = '';
    });
    hud.querySelector('.solo-btn')!.addEventListener('click', () => {
      if (this.requireName()) this.cb.onSolo();
    });
    hud.querySelector('.quickjoin-btn')!.addEventListener('click', () => {
      if (this.requireName()) this.cb.onQuickJoin();
    });
    hud.querySelector('.create-btn')!.addEventListener('click', () => {
      if (this.requireName()) this.cb.onCreateRoom();
    });
    this.codeInput.addEventListener('input', () => {
      this.codeInput.value = this.codeInput.value.toUpperCase().replace(/[^A-Z2-9]/g, '');
      this.menuErr.textContent = '';
    });
    this.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this.codeInput.value.length === 5 && this.requireName()) this.cb.onJoinRoom(this.codeInput.value);
    });
    hud.querySelector('.join-btn')!.addEventListener('click', () => {
      if (this.codeInput.value.length !== 5) {
        this.menuErr.textContent = 'enter the 5-letter room code';
        return;
      }
      if (this.requireName()) this.cb.onJoinRoom(this.codeInput.value);
    });

    // lobby wiring
    this.modeSel.value = String(this.settings.mode);
    this.modeSel.addEventListener('change', () => {
      this.settings.mode = this.modeSel.value === 'endless' ? 'endless' : (Number(this.modeSel.value) as RoomSettings['mode']);
      localStorage.setItem(LS_MODE, this.modeSel.value);
    });
    this.densitySlider.value = String(this.settings.density);
    this.densityVal.textContent = `x${this.settings.density.toFixed(2)}`;
    this.densitySlider.addEventListener('input', () => {
      this.settings.density = Number(this.densitySlider.value);
      this.densityVal.textContent = `x${this.settings.density.toFixed(2)}`;
      localStorage.setItem(LS_DENSITY, this.densitySlider.value);
    });
    this.copyBtn.addEventListener('click', () => this.copyCode());
    hud.querySelector('.lobby-leave')!.addEventListener('click', () => this.cb.onLeaveRoom());
    hud.querySelector('.lobby-start')!.addEventListener('click', () => this.cb.onStartMatch({ ...this.settings }));

    // result wiring
    hud.querySelector('.result-rematch')!.addEventListener('click', () => this.cb.onRematch());
    hud.querySelector('.result-menu')!.addEventListener('click', () => this.cb.onToMenu());

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

  setMeta(kmChip: string, rank: number): void {
    this.metaEl.classList.remove('hidden');
    this.metaEl.textContent = `${kmChip} \u00b7 #${rank}`;
  }

  hideMeta(): void {
    this.metaEl.classList.add('hidden');
  }

  showMenu(): void {
    this.menuOverlay.style.display = 'flex';
    this.lobbyOverlay.classList.add('hidden');
    this.countdownOverlay.classList.add('hidden');
    this.finishOverlay.classList.add('hidden');
    this.resultOverlay.classList.add('hidden');
    this.hideMeta();
    this.menuErr.textContent = '';
  }

  hideMenu(): void {
    this.menuOverlay.style.display = 'none';
  }

  menuError(msg: string): void {
    this.menuErr.textContent = msg;
  }

  showLobby(state: RoomStateMsg): void {
    // The lobby is the active screen: every race ephemera must leave, or the
    // result card (highest z-index, full-screen) would sit on top of the lobby
    // after the 8 s auto-return and trap all clients on the result screen.
    this.resultOverlay.classList.add('hidden');
    this.finishOverlay.classList.add('hidden');
    this.countdownOverlay.classList.add('hidden');
    this.lobbyOverlay.classList.remove('hidden');
    this.menuOverlay.style.display = 'none';
    this.lobbyCode.textContent = state.code;
    this.lobbyCount.textContent = `${state.players.length}/${ROOM_MAX_PLAYERS}`;
    this.isHost = state.hostId === this.myPlayerId;
    this.lobbyPlayers.innerHTML = '';
    for (const p of state.players) {
      const row = document.createElement('div');
      row.className = 'lobby-player';
      const name = document.createElement('span');
      name.textContent = p.name;
      row.appendChild(name);
      if (p.id === state.hostId) {
        const badge = document.createElement('span');
        badge.className = 'host-badge';
        badge.textContent = 'HOST';
        row.appendChild(badge);
      }
      this.lobbyPlayers.appendChild(row);
    }
    this.hostSettings.classList.toggle('hidden', !this.isHost);
    this.lobbyStart.classList.toggle('hidden', !this.isHost);
    this.lobbyErr.textContent = '';
  }

  lobbyError(msg: string): void {
    this.lobbyErr.textContent = msg;
  }

  private copyCode(): void {
    const done = (): void => {
      this.copyBtn.textContent = 'COPIED';
      this.copyBtn.classList.add('ok');
      setTimeout(() => {
        this.copyBtn.textContent = 'COPY CODE';
        this.copyBtn.classList.remove('ok');
      }, 1200);
    };
    const code = this.lobbyCode.textContent;
    if (!code) return;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(done).catch(() => {
        this.copyCodeFallback(code);
        done();
      });
    } else {
      this.copyCodeFallback(code);
      done();
    }
  }

  /** http LAN pages are not a secure context; clipboard.writeText may be missing. */
  private copyCodeFallback(code: string): void {
    const ta = document.createElement('textarea');
    ta.value = code;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {
      // best effort — the code is still visible to type
    }
    ta.remove();
  }

  showCountdown(t: number): void {
    this.countdownOverlay.classList.remove('hidden');
    this.countdownNum.textContent = String(t);
    // Restart the pop animation for every number: swapping textContent alone
    // does not re-trigger a CSS animation on the same element.
    const el = this.countdownNum;
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
  }

  hideCountdown(): void {
    this.countdownOverlay.classList.add('hidden');
  }

  showFinish(msg: FinishMsg): void {
    this.finishOverlay.classList.remove('hidden');
    this.finishRank.textContent = `#${msg.rank} \u00b7 ${fmtTime(msg.timeMs)}`;
  }

  hideFinish(): void {
    this.finishOverlay.classList.add('hidden');
  }

  showResult(result: MatchResultMsg, isHost: boolean): void {
    this.resultOverlay.classList.remove('hidden');
    this.finishOverlay.classList.add('hidden');
    this.resultRows.innerHTML = '';
    for (const r of result.rankings) {
      const row = document.createElement('div');
      row.className = 'result-row';
      const pos = document.createElement('span');
      pos.className = 'result-pos';
      pos.textContent = `#${r.rank}`;
      const name = document.createElement('span');
      name.className = 'result-name';
      name.textContent = r.name;
      const time = document.createElement('span');
      time.className = 'result-time';
      if (r.timeMs < 0) time.textContent = 'DNF';
      else time.textContent = result.mode === 'endless' ? `${(r.distance / 1000).toFixed(2)} km` : fmtTime(r.timeMs);
      row.append(pos, name, time);
      this.resultRows.appendChild(row);
    }
    this.resultRematch.classList.toggle('hidden', !isHost);
  }

  hideResult(): void {
    this.resultOverlay.classList.add('hidden');
  }

  hideLobby(): void {
    this.lobbyOverlay.classList.add('hidden');
  }

  setReconnecting(b: boolean): void {
    this.netChip.textContent = b ? 'RECONNECTING…' : 'ONLINE';
    this.netChip.classList.toggle('ok', !b);
  }

  startGame(): void {
    this.menuOverlay.style.display = 'none';
    this.lobbyOverlay.classList.add('hidden');
    this.countdownOverlay.classList.add('hidden');
    this.finishOverlay.classList.add('hidden');
    this.resultOverlay.classList.add('hidden');
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
    this.hideMeta();
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

  private requireName(): boolean {
    if (this.nameInput.value.trim().length === 0) {
      this.menuErr.textContent = 'enter your name first';
      this.nameInput.focus();
      return false;
    }
    return true;
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
    const n = localStorage.getItem(LS_NAME);
    if (n !== null) this.name = n;
    const mode = localStorage.getItem(LS_MODE);
    if (mode !== null && (mode === 'endless' || ROOM_MODES.includes(Number(mode) as RoomSettings['mode']))) {
      this.settings.mode = mode === 'endless' ? 'endless' : (Number(mode) as RoomSettings['mode']);
    }
    const d = Number(localStorage.getItem(LS_DENSITY));
    if (Number.isFinite(d) && d >= DENSITY_MIN && d <= DENSITY_MAX) this.settings.density = d;
  }
}
