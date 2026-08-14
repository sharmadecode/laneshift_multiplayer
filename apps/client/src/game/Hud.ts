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
  onWeather?: (w: 'day' | 'sunset' | 'night' | 'rain') => void;
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

  autoThrottle = true;
  sensitivity = 1;
  sound = true;
  preset: Preset = 'medium';
  name = '';
  settings: RoomSettings = { mode: 40, density: 0.8 };

  private speedEl: HTMLElement;
  private tachSegs: HTMLElement[] = [];
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
      <div class="orientation-overlay" style="display:none">
        <div class="orientation-card aaa-card">
          <div class="rotate-phone-anim">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="4" y="2" width="16" height="20" rx="3" />
              <path d="M12 18h.01" />
              <path d="M19 9a6 6 0 0 0-6-6" stroke-dasharray="3 3" />
              <path d="M15 3l-2-2-2 2" />
            </svg>
          </div>
          <div class="orientation-title">PLEASE ROTATE TO LANDSCAPE</div>
          <div class="orientation-sub">Widescreen arcade display required for optimal racing view</div>
        </div>
      </div>

      <div class="hud-top-left">
        <div class="hud-gauge-card aaa-gauge">
          <div class="gauge-header">
            <span class="gauge-label">SPEED</span>
            <div class="hud-speed">0<small>KM/H</small></div>
          </div>
          <div class="tach-bar">
            <span class="tach-seg"></span>
            <span class="tach-seg"></span>
            <span class="tach-seg"></span>
            <span class="tach-seg"></span>
            <span class="tach-seg"></span>
            <span class="tach-seg"></span>
            <span class="tach-seg"></span>
            <span class="tach-seg"></span>
            <span class="tach-seg"></span>
            <span class="tach-seg"></span>
          </div>
          <div class="gauge-footer">
            <div class="hud-distance">0 M</div>
            <div class="race-meta hidden"></div>
          </div>
        </div>
        <div class="net-chip">OFFLINE</div>
      </div>

      <button class="settings-btn aaa-btn-icon" aria-label="Settings">&#9881;</button>
      <button class="pause-btn aaa-btn-icon" aria-label="Pause">&#10073;&#10073;</button>

      <div class="settings-panel aaa-modal" style="display:none">
        <div class="panel-header">
          <span class="panel-title">SYSTEM SETTINGS</span>
          <button class="panel-close-btn">&times;</button>
        </div>
        <div class="setting-row">
          <label for="hr-preset">GRAPHICS LEVEL</label>
          <div class="select-wrap">
            <select id="hr-preset">
              <option value="low">LOW — 30 FPS</option>
              <option value="medium">MEDIUM — 60 FPS</option>
              <option value="high">ULTRA — MAX FX</option>
            </select>
          </div>
        </div>
        <div class="setting-row">
          <label for="hr-weather">WEATHER &amp; ATMOSPHERE</label>
          <div class="select-wrap">
            <select id="hr-weather">
              <option value="day">☀️ CLEAR DAYLIGHT</option>
              <option value="sunset">🌅 SUNSET GOLDEN HOUR</option>
              <option value="night">🌃 CYBERPUNK NIGHT</option>
              <option value="rain">🌧️ STORMY RAIN</option>
            </select>
          </div>
        </div>
        <div class="setting-row switch-row">
          <label for="hr-auto">AUTO THROTTLE</label>
          <label class="switch">
            <input type="checkbox" id="hr-auto" />
            <span class="switch-track"></span>
          </label>
        </div>
        <div class="setting-row switch-row">
          <label for="hr-sound">ENGINE SOUND &amp; SFX</label>
          <label class="switch">
            <input type="checkbox" id="hr-sound" />
            <span class="switch-track"></span>
          </label>
        </div>
        <div class="setting-row">
          <label for="hr-sens">STEERING RESPONSE <span class="setting-val" id="hr-sens-val"></span></label>
          <input type="range" id="hr-sens" min="0.5" max="1.5" step="0.05" />
        </div>
        <div class="credits-section" style="margin-top: 16px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.1); font-size: 11px; color: #94a3b8; line-height: 1.45; max-height: 160px; overflow-y: auto;">
          <div style="font-weight: 700; color: #f1f5f9; margin-bottom: 6px; letter-spacing: 0.5px;">3D MODEL ATTRIBUTIONS (CC-BY / CC0)</div>
          <div>• <b>Toyota AE86</b> by <a href="https://poly.pizza/m/ZEFWmOPSgh" target="_blank" style="color:#38bdf8;text-decoration:none;">IvOfficial</a> (CC-BY 3.0)</div>
          <div>• <b>CAR Model</b> by <a href="https://poly.pizza/m/5zUWP5UsLg-" target="_blank" style="color:#38bdf8;text-decoration:none;">Ignition Labs</a> (CC-BY 3.0)</div>
          <div>• <b>City Pack</b> by <a href="https://poly.pizza/bundle/City-Pack-q11onRvPoJ" target="_blank" style="color:#38bdf8;text-decoration:none;">dreamdev</a> (CC-BY 3.0)</div>
          <div>• <b>Race Kit</b> by <a href="https://poly.pizza/bundle/Race-kit-LcWNxpyXuL" target="_blank" style="color:#38bdf8;text-decoration:none;">Player11132</a> (CC-BY 3.0)</div>
          <div>• <b>Tree Collection</b> by <a href="https://poly.pizza/bundle/Tree-Collection-zdry8l7ugJ" target="_blank" style="color:#38bdf8;text-decoration:none;">NicolasBrueckner</a> (CC-BY 3.0)</div>
          <div>• <b>City Kit &amp; Suburban Houses</b> by <a href="https://kenney.nl" target="_blank" style="color:#38bdf8;text-decoration:none;">Kenney</a> (CC0)</div>
          <div>• <b>Vehicles &amp; Medieval/Farm Bundles</b> by <a href="https://poly.pizza/u/Quaternius" target="_blank" style="color:#38bdf8;text-decoration:none;">Quaternius</a> (CC0)</div>
        </div>
      </div>

      <div class="touch-controls">
        <div class="touch-steer-group">
          <button class="ctl-btn ctl-left" aria-label="Steer Left"><span class="ctl-icon">&#9664;</span></button>
          <button class="ctl-btn ctl-right" aria-label="Steer Right"><span class="ctl-icon">&#9654;</span></button>
        </div>
        <div class="touch-pedal-group">
          <button class="ctl-btn ctl-brake" aria-label="Brake"><span class="ctl-label">BRAKE</span></button>
          <button class="ctl-btn ctl-throttle" aria-label="Throttle"><span class="ctl-label">THROTTLE</span></button>
        </div>
      </div>

      <div class="crash-overlay hidden">
        <div class="crash-box aaa-card">
          <div class="crash-badge">COLLISION IMPACT</div>
          <div class="title">WRECKED</div>
          <div class="sub">RESTARTING IN <span class="crash-t">3.0</span>S</div>
        </div>
      </div>

      <div class="pause-overlay hidden">
        <div class="pause-card aaa-card">
          <div class="card-tag">STATUS: HALTED</div>
          <div class="panel-title">RACE PAUSED</div>
          <div class="stat-display">
            <span class="stat-label">DISTANCE LOGGED</span>
            <div class="pause-dist" id="hr-pause-dist">0 M</div>
          </div>
          <div class="pause-actions">
            <button class="menu-btn aaa-btn-cyan" id="hr-resume"><span>▶ RESUME RACE</span></button>
            <button class="menu-btn aaa-btn-amber" id="hr-restart"><span>↻ RESTART</span></button>
            <button class="menu-btn aaa-btn-red" id="hr-pause-menu"><span>⏏ MAIN MENU</span></button>
          </div>
        </div>
      </div>

      <div class="menu-overlay">
        <div class="menu-card aaa-card">
          <div class="hero-brand">
            <div class="brand-top-row">
              <span class="brand-pill">ARCADE MULTIPLAYER</span>
              <span class="brand-version">v2.0</span>
            </div>
            <div class="game-title">LANESHIFTER</div>
            <div class="game-sub">HIGH-SPEED MULTIPLAYER HIGHWAY RACING</div>
          </div>
          
          <div class="menu-section">
            <div class="input-wrap">
              <span class="input-icon">🏎️</span>
              <input class="name-input" maxlength="16" placeholder="ENTER DRIVER NAME..." spellcheck="false" autocomplete="off" />
            </div>
            
            <div class="match-actions">
              <button class="menu-btn aaa-btn-hero quickjoin-btn">
                <span class="btn-glow"></span>
                <span class="btn-text">⚡ QUICK MATCH</span>
              </button>
              
              <div class="room-action-row">
                <button class="menu-btn aaa-btn-secondary create-btn"><span>CREATE ROOM</span></button>
                <div class="join-row">
                  <input class="code-input" maxlength="5" placeholder="CODE" spellcheck="false" autocomplete="off" />
                  <button class="menu-btn aaa-btn-cyan join-btn"><span>JOIN</span></button>
                </div>
              </div>
              
              <button class="menu-btn aaa-btn-ghost solo-btn solo-ghost"><span>🏁 SOLO TIME-TRIAL</span></button>
            </div>
            
            <div class="menu-err"></div>
          </div>
        </div>
      </div>

      <div class="lobby-overlay hidden">
        <div class="lobby-card aaa-card">
          <div class="card-tag">MULTIPLAYER LOBBY</div>
          <div class="room-code-badge">
            <span class="room-code-label">ROOM:</span>
            <div class="room-code"></div>
            <button class="copy-btn aaa-btn-copy" title="Copy room code">COPY</button>
          </div>
          <div class="room-code-hint">Share code with friends to join room</div>
          <div class="lobby-count-row">
            <span>DRIVERS ON GRID</span>
            <span class="lobby-count">0/6</span>
          </div>
          <div class="lobby-players"></div>
          <div class="host-settings hidden">
            <div class="setting-row">
              <label for="hr-mode">RACE LENGTH</label>
              <div class="select-wrap">
                <select id="hr-mode">
                  <option value="endless">Endless Highway</option>
                  <option value="40">Sprint (40 km)</option>
                  <option value="60">Circuit (60 km)</option>
                  <option value="100">Endurance (100 km)</option>
                </select>
              </div>
            </div>
            <div class="setting-row">
              <label for="hr-density">TRAFFIC DENSITY <span class="setting-val" id="hr-density-val"></span></label>
              <input type="range" id="hr-density" min="0.55" max="1.3" step="0.05" />
            </div>
          </div>
          <div class="lobby-actions">
            <button class="menu-btn aaa-btn-green start-btn lobby-start hidden"><span>START RACE</span></button>
            <button class="menu-btn aaa-btn-red lobby-leave"><span>LEAVE ROOM</span></button>
          </div>
          <div class="lobby-err"></div>
        </div>
      </div>

      <div class="countdown-overlay hidden">
        <div class="countdown-card aaa-card">
          <div class="countdown-num">3</div>
          <div class="countdown-hint">GET READY</div>
        </div>
      </div>

      <div class="finish-overlay hidden">
        <div class="finish-box aaa-card">
          <div class="finish-badge">CHECKERED FLAG</div>
          <div class="finish-title">RACE FINISHED</div>
          <div class="finish-rank">#1</div>
          <div class="finish-sub">WAITING FOR OTHER RACERS…</div>
        </div>
      </div>

      <div class="result-overlay hidden">
        <div class="result-card aaa-card">
          <div class="card-tag">RACE CLASSIFICATION</div>
          <div class="panel-title">LEADERBOARD</div>
          <div class="result-rows"></div>
          <div class="result-actions">
            <button class="menu-btn aaa-btn-hero result-rematch hidden"><span>REMATCH</span></button>
            <button class="menu-btn aaa-btn-ghost result-menu"><span>MAIN MENU</span></button>
          </div>
        </div>
      </div>

      <div class="steer-indicator">&#9664; TAP OR HOLD TO STEER &#9654;</div>
      <div class="hud-hint">A / D or &#8592;&#8594; Steer &middot; W / Space Throttle &amp; Brake</div>
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
      ? (this.autoThrottle ? 'steer with arrows \u00b7 tap BRAKE to slow down' : 'steer with arrow buttons, drive with BRAKE/THROTTLE')
      : (this.autoThrottle ? 'A/D or \u2190\u2192 steer \u00b7 S / Space to brake' : 'A/D or \u2190\u2192 steer \u00b7 W/S throttle');
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

    // settings close button
    hud.querySelector('.panel-close-btn')!.addEventListener('click', () => {
      panel.style.display = 'none';
    });

    // pause overlay buttons
    hud.querySelector('#hr-resume')!.addEventListener('click', () => this.cb.onPauseToggle());
    hud.querySelector('#hr-restart')!.addEventListener('click', () => this.cb.onRestart());
    hud.querySelector('#hr-pause-menu')!.addEventListener('click', () => {
      this.hidePause();
      this.cb.onToMenu();
    });

    this.initOrientationCheck(hud);

    const presetSel = hud.querySelector('#hr-preset') as HTMLSelectElement;
    presetSel.value = this.preset;
    presetSel.addEventListener('change', () => {
      this.preset = presetSel.value as Preset;
      localStorage.setItem(LS_PRESET, this.preset);
      this.cb.onPreset(this.preset);
    });

    const weatherSel = hud.querySelector('#hr-weather') as HTMLSelectElement;
    const savedWeather = (localStorage.getItem('hr_weather') || 'day') as 'day' | 'sunset' | 'night' | 'rain';
    weatherSel.value = savedWeather;
    weatherSel.addEventListener('change', () => {
      const w = weatherSel.value as 'day' | 'sunset' | 'night' | 'rain';
      localStorage.setItem('hr_weather', w);
      this.cb.onWeather?.(w);
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

    this.tachSegs = Array.from(hud.querySelectorAll('.tach-seg'));
  }

  update(state: { speed: number; distance: number; rpm?: number; gear?: number }): void {
    this.lastDistance = state.distance;
    const kmh = Math.round(state.speed * MS_TO_KMH);
    const gearText = state.gear ? ` \u00b7 G${state.gear}` : '';
    this.speedEl.innerHTML = `${kmh}<small>KM/H${gearText}</small>`;
    const km = state.distance >= 1000;
    this.distEl.textContent = km
      ? `${(state.distance / 1000).toFixed(2)} KM`
      : `${Math.round(state.distance)} M`;

    // Tachometer segments follow real engine RPM
    const rpmNorm = state.rpm ? Math.min(1, Math.max(0, (state.rpm - 1000) / 7200)) : Math.min(1, Math.max(0, kmh / 209));
    const activeCount = Math.round(rpmNorm * this.tachSegs.length);
    for (let i = 0; i < this.tachSegs.length; i++) {
      this.tachSegs[i].classList.toggle('active', i < activeCount);
    }
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

  hidePause(): void {
    this.pauseOverlay.classList.add('hidden');
  }

  private initOrientationCheck(hud: HTMLElement): void {
    const overlay = hud.querySelector('.orientation-overlay') as HTMLElement;
    if (!overlay) return;
    const check = () => {
      const isTouch = window.matchMedia('(pointer: coarse)').matches;
      const isPortrait = window.innerHeight > window.innerWidth;
      overlay.style.display = isTouch && isPortrait ? 'flex' : 'none';
    };
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
    check();
  }

  requestLandscapeLock(): void {
    try {
      const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      if (typeof orientation?.lock === 'function') {
        orientation.lock('landscape').catch(() => undefined);
      }
    } catch {
      // Ignored if unsupported by browser
    }
  }

  resetRun(): void {
    this.lastDistance = 0;
    this.speedEl.innerHTML = `0<small>KM/H</small>`;
    this.distEl.textContent = '0 M';
    for (const seg of this.tachSegs) seg.classList.remove('active');
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
    this.autoThrottle = a !== null ? a === 'true' : true;
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
