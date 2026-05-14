// ==UserScript==
// @name         AOWeb HUD
// @namespace    achalay.aoweb
// @version      1.11
// @description  Auto-Ataque fijo arriba (sticky) + double-tap Space para toggle + slider desde 0ms con presets + multi-target CC con click-to-lock y colores por instancia + auto-renovar Celeridad piloto.
// @match        https://aoweb.app/play
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/augustolj/AO-Rafa/main/src/aoweb-hud.user.js
// @downloadURL  https://raw.githubusercontent.com/augustolj/AO-Rafa/main/src/aoweb-hud.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ===== FIX fullscreen (de v0.4.1) =====
  const origRF = HTMLElement.prototype.requestFullscreen;
  if (origRF) {
    HTMLElement.prototype.requestFullscreen = function(opts) {
      if (this.tagName === 'CANVAS') return origRF.call(document.documentElement, opts);
      return origRF.call(this, opts);
    };
  }
  ['webkitRequestFullscreen', 'mozRequestFullScreen', 'msRequestFullscreen'].forEach(fn => {
    const orig = HTMLElement.prototype[fn];
    if (orig) HTMLElement.prototype[fn] = function(opts) {
      if (this.tagName === 'CANVAS') return document.documentElement[fn](opts);
      return orig.call(this, opts);
    };
  });

  // ===== Estado =====
  const entities = new Map();
  const activeBuffs = new Map();
  const mobStats = new Map();
  const wsTraffic = [];
  const consoleLog = [];
  const MAX = 20000;
  let observerActive = false;
  let globalObs = null;
  let playerName = null;
  let playerClass = null;
  let playerLevel = null;
  let buffTickerId = null;
  let currentTarget = null;
  let targetTimeoutId = null;
  let gameCanvas = null;
  let resizeRaf = null;
  let lastCombatAt = 0;
  let currentTab = 'manual';
  const session = {
    startedAt: Date.now(),
    kills: 0,
    totalXP: 0,
    totalGold: 0,
    killsByMob: {},
    damageDealt: 0,
    damageReceived: 0,
    playerHits: [],
    recentHits: [],
    manaRecovered: 0,
    meditations: 0,
    drops: [],
    hitsBySpell: {},
  };
  let playerXPCurrent = 0;
  let playerXPNeeded = 0;
  let playerHP = 0;
  let playerMaxHP = 0;
  let playerMP = 0;
  let playerMaxMP = 0;
  let currentMapName = '';
  let currentMapNum = 0;
  let buffAlertedSet = new Set();

  let sessionHistory = [];
  try { sessionHistory = JSON.parse(localStorage.getItem('aoweb-hud-sessions') || '[]'); } catch (e) {}

  const STALE_MS = 60000;
  const TARGET_TIMEOUT_MS = 12000;
  const COMBAT_RECENT_MS = 5000;

  // Spell → State mapping (for timer reset on recast)
  const SPELL_TO_STATE = { 'Paralizar': 'Paralizado', 'Inmovilizar': 'Inmovilizado' };
  const STATE_EST_DURATION = { 'Paralizado': 50, 'Inmovilizado': 50 };

  // Persistencia
  let learnedDurations = {};
  try { learnedDurations = JSON.parse(localStorage.getItem('aoweb-hud-durations') || '{}'); } catch (e) {}
  let learnedMobStats = {};
  try { learnedMobStats = JSON.parse(localStorage.getItem('aoweb-hud-mobs') || '{}'); } catch (e) {}
  let learnedStates = {};
  try { learnedStates = JSON.parse(localStorage.getItem('aoweb-hud-states') || '{}'); } catch (e) {}

  // Migration v2: full reset of learned state durations (bad data from old algorithm)
  {
    const STATES_VERSION = 5;
    const storedVer = learnedStates._v || 0;
    if (storedVer < STATES_VERSION) {
      for (const [state, data] of Object.entries(learnedStates)) {
        if (state === '_v') continue;
        if (typeof data === 'object') {
          data.knownDuration = null;
          data.samples = [];
        }
      }
      learnedStates._v = STATES_VERSION;
      localStorage.setItem('aoweb-hud-states', JSON.stringify(learnedStates));
      console.log('[AOWeb HUD] Migration v2: reset ALL learned durations (bad data cleanup)');
    }
  }

  const SPELL_DURATIONS = {
    'Fuerza': 180, 'Agilidad': 180, 'Inteligencia': 180,
    'Constitución': 180, 'Carisma': 180,
    'Celeridad': 90, 'Bendición': 120, 'Resistencia mágica': 120,
    'Inmovilizar': 50, 'Paralizar': 50, 'Detectar Invisible': 60,
  };
  const DEFAULT_DURATION = 60;
  function getDuration(spell) {
    return learnedDurations[spell] || SPELL_DURATIONS[spell] || DEFAULT_DURATION;
  }

  const SPELL_ICONS = {
    'Fuerza': '💪', 'Agilidad': '🏃', 'Celeridad': '🐇',
    'Inteligencia': '✦', 'Constitución': '◈', 'Carisma': '✧',
    'Bendición': '✝️', 'Inmovilizar': '⏱', 'Paralizar': '⏱',
    'Resistencia mágica': '◇',
    'Tormenta de Fuego': '🔥', 'Proyectil Mágico': '💠', 'Dardo Mágico': '🎯',
    'Misil Mágico': '✨', 'Descarga Eléctrica': '⚡', 'Rayo': '⚡',
    'Apocalipsis': '☄', 'Explosión': '💥', 'Infierno': '🔥',
    'Toxina': '☣', 'Ataque de Hambre': '🦴', 'Drenaje de Maná': '🌀',
    'Llamado Nigromante': '🧟', 'Drenaje de Vida': '🩸',
    'Curar Heridas Graves': '✚',
  };
  let lastOffensiveSpell = null;
  let lastOffensiveSpellAt = 0;

  const SPELL_SPRITES = {};
  const SPELL_SPRITE_FRAMES = 5;
  const SPELL_SPRITE_FRAME_MS = 180;

  // ===== Sound alerts (AudioContext, no external files) =====
  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }
  const ALERT_COOLDOWN = 4000;
  const CC_ALERT_COOLDOWN = 1000;
  let lastBuffAlert = 0;
  let lastCCAlert = 0;

  function playBuffAlert() {
    if (!soundAlertsEnabled) return;
    const now = Date.now();
    if (now - lastBuffAlert < ALERT_COOLDOWN) return;
    lastBuffAlert = now;
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(660, ctx.currentTime + 0.15);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.3);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.45);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.45);
  }

  function playCCAlert() {
    if (!soundAlertsEnabled) return;
    const now = Date.now();
    if (now - lastCCAlert < CC_ALERT_COOLDOWN) return;
    lastCCAlert = now;
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'square';
    osc.frequency.setValueAtTime(440, ctx.currentTime);
    osc.frequency.setValueAtTime(330, ctx.currentTime + 0.1);
    osc.frequency.setValueAtTime(440, ctx.currentTime + 0.2);
    osc.frequency.setValueAtTime(330, ctx.currentTime + 0.3);
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.4);
  }

  const BUFF_ALERT_THRESHOLD = 10;
  const CC_ALERT_THRESHOLD = 10;
  const LOW_HP_THRESHOLD = 0.3;
  let lastHPAlert = 0;
  let soundAlertsEnabled = localStorage.getItem('aoweb-hud-sound') !== 'off';

  function playLowHPAlert() {
    const now = Date.now();
    if (now - lastHPAlert < ALERT_COOLDOWN) return;
    lastHPAlert = now;
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, ctx.currentTime);
    osc.frequency.setValueAtTime(440, ctx.currentTime + 0.1);
    osc.frequency.setValueAtTime(220, ctx.currentTime + 0.2);
    osc.frequency.setValueAtTime(440, ctx.currentTime + 0.3);
    osc.frequency.setValueAtTime(220, ctx.currentTime + 0.4);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.5);
  }

  const MOB_EMOJIS = {
    'Galeón Pirata': '🚢', 'Galeón': '🚢', 'Pirata': '🏴‍☠️',
    'Dragón de las Profundidades': '🐉', 'Dragón': '🐉',
    'Gran Águila': '🦅', 'Águila': '🦅', 'Aguila': '🦅', 'Halcón': '🦅', 'Cuervo': '🦅',
    'Gallo': '🐓', 'Gallina': '🐔', 'Pato': '🦆',
    'Lobo': '🐺', 'Zorro': '🦊', 'Oso': '🐻',
    'Vaca': '🐄', 'Toro': '🐂', 'Cerdo': '🐗', 'Jabalí': '🐗',
    'Rata': '🐀', 'Ciervo': '🦌', 'Conejo': '🐇', 'Caballo': '🐴',
    'Murciélago': '🦇', 'Serpiente': '🐍', 'Cobra': '🐍',
    'Lagarto': '🦎', 'Cocodrilo': '🐊', 'Sapo': '🐸', 'Tortuga': '🐢',
    'Araña': '🕷', 'Escorpión': '🦂', 'Hormiga': '🐜', 'Abeja': '🐝',
    'Esqueleto': '💀', 'Zombi': '🧟', 'Zombie': '🧟',
    'Demonio': '👹', 'Diablo': '👿',
    'Vampiro': '🧛', 'Bruja': '🧙', 'Mago': '🧙',
    'Goblin': '👺', 'Ogro': '👹', 'Troll': '👹',
    'Caballero': '⚔', 'Soldado': '⚔', 'Bandido': '🗡',
    'Fantasma': '👻', 'Espíritu': '👻', 'Necrófago': '🧟',
    'Hada': '🧚', 'Sirena': '🧜', 'Gigante': '🗿',
    'Tiburón': '🦈', 'Pulpo': '🐙', 'Cangrejo': '🦀',
    '_default': '⚔',
  };
  function getMobEmoji(name) {
    if (!name) return MOB_EMOJIS._default;
    if (MOB_EMOJIS[name]) return MOB_EMOJIS[name];
    const words = name.toLowerCase().split(/\s+/);
    for (const [key, emoji] of Object.entries(MOB_EMOJIS)) {
      if (key === '_default') continue;
      if (words.some(w => w === key.toLowerCase())) return emoji;
    }
    return MOB_EMOJIS._default;
  }

  // ===== AVATAR — head sprite from AO CDN =====
  const AO_CDN = 'https://aoweb.nyc3.cdn.digitaloceanspaces.com';
  let aoHeadsData = null;
  let aoGraficosData = null;
  let selectedHeadId = null;
  let activeCharId = null;
  try { selectedHeadId = +localStorage.getItem('aoweb-hud-headid') || null; } catch(e) {}
  try { activeCharId = localStorage.getItem('aoweb-hud-charid') || null; } catch(e) {}

  // Per-instance CC tracking: each cast creates its own timer, so multi-target works
  const myCCInstances = []; // [{ id, name, state, castAt, duration }]
  let myCCNextId = 1;

  // Measure attack interval (weapon cooldown) from successful melee hits
  let lastMeleeHitAt = 0;
  let measuredAttackIntervalMs = null;
  const attackIntervalSamples = []; // sliding window of last 10
  const ATTACK_SAMPLES_MAX = 10;

  // ===== Macros / Auto-attack / Combos (v1.6) =====
  let playerMacros = [];
  let autoAttackEnabled = false;
  let autoAttackIntervalId = null;
  let autoAttackDelayMs = 800;
  try {
    const _saved = localStorage.getItem('aoweb-hud-aaspeed');
    if (_saved !== null) {
      const _n = +_saved;
      if (!isNaN(_n) && _n >= 0 && _n <= 2000) autoAttackDelayMs = _n;
    }
  } catch(e) {}

  // v1.11: double-tap Space toggle
  let lastSpaceAt = 0;
  const DOUBLE_TAP_MS = 300;

  // v1.11: auto-renovar Celeridad piloto
  let autoRenewCeleridadEnabled = false;
  try { autoRenewCeleridadEnabled = localStorage.getItem('aoweb-hud-autorenew') === '1'; } catch(e) {}
  let lastAutoRenewAt = 0;
  const AUTO_RENEW_COOLDOWN_MS = 8000;
  const AUTO_RENEW_THRESHOLD_S = 5;
  const CELERIDAD_MACRO_KEY = 'Digit1'; // v1.11: hardcoded tecla 1

  // v1.11: colores rotando por índice de instancia CC (para distinguir Oso 1/Oso 2/Oso 3)
  const CC_COLORS = ['#3a6fb0','#a06fc8','#d4a857','#5ba075','#c46a6a'];

  async function fetchActiveCharacter() {
    try {
      const [me, settings] = await Promise.all([
        fetch('/api/auth/me', { credentials: 'include' }).then(r => r.ok ? r.json() : null),
        fetch('/api/auth/character-settings', { credentials: 'include' }).then(r => r.ok ? r.json() : null),
      ]);
      if (!me || !settings) return null;
      const active = me.characters && me.characters.find(c => c._id === settings.characterId);
      if (!active) return null;
      const charChanged = active._id !== activeCharId;
      activeCharId = active._id;
      try { localStorage.setItem('aoweb-hud-charid', active._id); } catch(e) {}
      // Always trust API for name/class/level — it's authoritative
      playerName = active.name;
      playerClass = active.className;
      playerLevel = active.level;
      // For head: auto-set if first install OR if character changed (let user pick custom otherwise)
      if (active.id_head && (charChanged || !selectedHeadId)) {
        selectedHeadId = active.id_head;
        try { localStorage.setItem('aoweb-hud-headid', String(active.id_head)); } catch(e) {}
      }
      console.log(`[AOWeb HUD] Active char: ${active.name} (${active.className}, lvl ${active.level}, head ${active.id_head})`);
      return active;
    } catch (e) {
      console.log('[AOWeb HUD] Active char API fetch failed:', e);
      return null;
    }
  }

  // ===== Synthetic key dispatch (v1.6) =====
  // Verified: aoweb's PixiJS engine accepts dispatched KeyboardEvents (M opens map, etc).
  function codeToKey(code) {
    if (!code) return '';
    if (code.startsWith('Key')) return code.slice(3).toLowerCase();
    if (code.startsWith('Digit')) return code.slice(5);
    if (code === 'Space') return ' ';
    if (code === 'Escape') return 'Escape';
    if (code === 'Enter') return 'Enter';
    return code.toLowerCase();
  }
  function codeToKeyCode(code) {
    if (!code) return 0;
    if (code.startsWith('Key')) return code.charCodeAt(3);
    if (code.startsWith('Digit')) return 48 + parseInt(code.slice(5), 10);
    if (code === 'Space') return 32;
    if (code === 'Escape') return 27;
    if (code === 'Enter') return 13;
    return 0;
  }
  function dispatchGameKey(code) {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') && (!ae.id || !ae.id.startsWith('aohud'))) return false;
    const target = document.querySelector('canvas') || document;
    const key = codeToKey(code);
    const kc = codeToKeyCode(code);
    const opts = { key, code, keyCode: kc, which: kc, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent('keydown', opts));
    setTimeout(() => target.dispatchEvent(new KeyboardEvent('keyup', opts)), 40);
    return true;
  }
  // v1.11: dispatchClick — sintetiza pointerdown/mousedown + click en (x, y) sobre un elemento.
  // El motor de aoweb acepta synthetic KeyboardEvents (verificado v1.6); este helper hace lo
  // mismo para mouse para hechizos self-target (PJ siempre en el centro del canvas).
  function dispatchClick(target, x, y) {
    if (!target) return;
    const baseOpts = {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y,
      button: 0, buttons: 1,
    };
    try {
      target.dispatchEvent(new PointerEvent('pointerdown', { ...baseOpts, pointerType: 'mouse', isPrimary: true }));
    } catch(e) {}
    target.dispatchEvent(new MouseEvent('mousedown', baseOpts));
    setTimeout(() => {
      try {
        target.dispatchEvent(new PointerEvent('pointerup', { ...baseOpts, buttons: 0, pointerType: 'mouse', isPrimary: true }));
      } catch(e) {}
      target.dispatchEvent(new MouseEvent('mouseup', { ...baseOpts, buttons: 0 }));
      target.dispatchEvent(new MouseEvent('click', { ...baseOpts, buttons: 0 }));
    }, 50);
  }

  // v1.11: autoRenewCeleridad — tecla 1 + click al centro del canvas (sobre PJ).
  function autoRenewCeleridad() {
    const now = Date.now();
    if (now - lastAutoRenewAt < AUTO_RENEW_COOLDOWN_MS) return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
      console.log('[AOWeb HUD][auto-renew] skipped: input has focus');
      return;
    }
    const canvas = document.querySelector('canvas');
    if (!canvas) { console.warn('[AOWeb HUD][auto-renew] canvas not found'); return; }
    lastAutoRenewAt = now;
    console.log('[AOWeb HUD][auto-renew] firing Celeridad (key 1 + click center)');
    const ok = dispatchGameKey(CELERIDAD_MACRO_KEY);
    if (!ok) { console.warn('[AOWeb HUD][auto-renew] dispatchGameKey returned false'); return; }
    setTimeout(() => {
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      console.log('[AOWeb HUD][auto-renew] dispatching click at', Math.round(cx), Math.round(cy));
      dispatchClick(canvas, cx, cy);
    }, 80);
    showToast('Renovando Celeridad', '<5s para expirar', '🌀', 'discovery');
  }

  function setAutoRenewCeleridad(enabled) {
    autoRenewCeleridadEnabled = !!enabled;
    try { localStorage.setItem('aoweb-hud-autorenew', enabled ? '1' : '0'); } catch(e) {}
    if (currentTab === 'macros') renderManual();
    showToast(enabled ? 'Auto-renovar Celeridad ON' : 'Auto-renovar Celeridad OFF', enabled ? 'Re-cast a <5s' : '', '🌀', enabled ? 'learned' : 'discovery');
    if (enabled) ensureBuffTicker();
  }
  function formatKeyLabel(code) {
    if (!code) return '?';
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code === 'Space') return 'ESPACIO';
    if (code === 'Escape') return 'ESC';
    return code;
  }
  async function fetchPlayerMacros() {
    try {
      const r = await fetch('/api/auth/character-settings', { credentials: 'include' });
      if (!r.ok) return;
      const d = await r.json();
      playerMacros = Array.isArray(d.macros) ? d.macros : [];
      if (currentTab === 'macros') renderManual();
    } catch (e) { console.log('[AOWeb HUD] Macros fetch failed:', e); }
  }
  function setAutoAttack(enabled) {
    autoAttackEnabled = enabled;
    if (autoAttackIntervalId) { clearInterval(autoAttackIntervalId); autoAttackIntervalId = null; }
    if (enabled) {
      autoAttackIntervalId = setInterval(() => { dispatchGameKey('Space'); }, autoAttackDelayMs);
      showToast('Auto-ataque ON', `Espacio cada ${autoAttackDelayMs}ms`, '⚔', 'learned');
    } else {
      showToast('Auto-ataque OFF', '', '⏹', 'discovery');
    }
    if (currentTab === 'macros') renderManual();
    refreshStickyAA();
  }
  function refreshStickyAA() {
    const stickyAA = document.getElementById('aohud-aa-sticky');
    const stateEl = document.getElementById('aohud-aa-state');
    if (!stickyAA || !stateEl) return;
    stickyAA.classList.toggle('on', autoAttackEnabled);
    stateEl.textContent = autoAttackEnabled ? `ON · ${autoAttackDelayMs}ms` : 'OFF';
  }

  // (v1.10: helpers de auto-renovar y auto-despara eliminados)

  async function loadHeadData() {
    try {
      const [hResp, gResp] = await Promise.all([
        fetch(AO_CDN + '/init/heads.json').then(r => r.json()),
        fetch(AO_CDN + '/init/graficos.json').then(r => r.json()),
      ]);
      aoHeadsData = hResp;
      aoGraficosData = gResp;
      await fetchActiveCharacter();
      if (selectedHeadId) applyHeadAvatar(selectedHeadId);
      renderPlayerFrame();
    } catch(e) { console.log('[AOWeb HUD] Head data fetch failed:', e); }
  }

  function getHeadSpriteURL(headId) {
    if (!aoHeadsData || !aoGraficosData) return null;
    const head = aoHeadsData[String(headId)];
    if (!head) return null;
    const frontGfxId = head['2'];
    if (!frontGfxId) return null;
    const gfx = aoGraficosData[String(frontGfxId)];
    if (!gfx) return null;
    // Head PNGs pack 4 directional frames horizontally: total width = 4 * frameW
    const sheetW = gfx.width * 4;
    const sheetH = gfx.height;
    return {
      url: `${AO_CDN}/graphics/${gfx.numFile}.png`,
      sX: gfx.sX, sY: gfx.sY, w: gfx.width, h: gfx.height,
      sheetW, sheetH
    };
  }

  function applyHeadAvatar(headId) {
    const avatarEl = document.getElementById('player-avatar');
    if (!avatarEl) return;
    const sprite = getHeadSpriteURL(headId);
    if (!sprite) { avatarEl.textContent = playerName ? playerName[0].toUpperCase() : '?'; return; }
    const displaySize = 52;
    const scale = displaySize / sprite.w;
    avatarEl.textContent = '';
    avatarEl.style.backgroundImage = `url(${sprite.url})`;
    avatarEl.style.backgroundSize = `${sprite.sheetW * scale}px ${sprite.sheetH * scale}px`;
    avatarEl.style.backgroundPosition = `-${sprite.sX * scale}px -${sprite.sY * scale}px`;
    avatarEl.style.imageRendering = 'pixelated';
    avatarEl.style.backgroundRepeat = 'no-repeat';
  }

  function showHeadPicker() {
    const existing = document.getElementById('aohud-head-picker');
    if (existing) { existing.remove(); return; }
    if (!aoHeadsData || !aoGraficosData) return;

    const picker = document.createElement('div');
    picker.id = 'aohud-head-picker';
    const allIds = Object.keys(aoHeadsData).map(Number).filter(id => {
      const h = aoHeadsData[String(id)];
      return h && h['2'] && aoGraficosData[String(h['2'])];
    }).sort((a, b) => a - b);
    const races = [
      { label: 'Humano', ids: allIds.filter(id => id >= 1 && id <= 69) },
      { label: 'Humano Alt', ids: allIds.filter(id => id >= 70 && id <= 99) },
      { label: 'Elfo', ids: allIds.filter(id => id >= 100 && id <= 199) },
      { label: 'Elfo Oscuro', ids: allIds.filter(id => id >= 200 && id <= 299) },
      { label: 'Enano', ids: allIds.filter(id => id >= 300 && id <= 399) },
      { label: 'Gnomo', ids: allIds.filter(id => id >= 400 && id <= 499) },
      { label: 'Otras', ids: allIds.filter(id => id >= 500) },
    ];
    let html = '<div class="hp-title">Elegí tu cabeza</div>';
    for (const race of races) {
      if (race.ids.length === 0) continue;
      html += `<div class="hp-race">${race.label}</div><div class="hp-grid">`;
      for (const id of race.ids) {
        const sprite = getHeadSpriteURL(id);
        if (!sprite) continue;
        const scale = 32 / sprite.w;
        const bgPos = `-${sprite.sX * scale}px -${sprite.sY * scale}px`;
        const bgSize = `${sprite.sheetW * scale}px ${sprite.sheetH * scale}px`;
        html += `<div class="hp-head" data-hid="${id}" style="background-image:url(${sprite.url});background-position:${bgPos};background-size:${bgSize};image-rendering:pixelated;background-repeat:no-repeat;width:32px;height:32px;"></div>`;
      }
      html += '</div>';
    }
    picker.innerHTML = html;
    picker.addEventListener('click', (e) => {
      const headEl = e.target.closest('.hp-head');
      if (!headEl) return;
      const hid = +headEl.getAttribute('data-hid');
      selectedHeadId = hid;
      localStorage.setItem('aoweb-hud-headid', String(hid));
      applyHeadAvatar(hid);
      picker.remove();
    });
    panel.appendChild(picker);
  }

  // ===== WIKI LIVE DATA — fetched from aoweb.app/wiki/* =====
  const WIKI_CACHE_KEY = 'aoweb-hud-wiki';
  const WIKI_CACHE_TTL = 24 * 60 * 60 * 1000;
  let BESTIARY_DB = {};
  let SPELLS_DB = {};
  let MAPS_DB = {};
  let wikiLoaded = false;

  function loadWikiCache() {
    try {
      const raw = JSON.parse(localStorage.getItem(WIKI_CACHE_KEY) || '{}');
      if (raw.ts && Date.now() - raw.ts < WIKI_CACHE_TTL) {
        if (raw.npcs) BESTIARY_DB = raw.npcs;
        if (raw.spells) SPELLS_DB = raw.spells;
        if (raw.maps) MAPS_DB = raw.maps;
        wikiLoaded = true;
        return true;
      }
    } catch (e) {}
    return false;
  }

  function parseWikiNpcs(html) {
    const db = {};
    const parts = html.split(/<p class="font-medium text-white">/);
    parts.shift();
    for (const part of parts) {
      const nameM = part.match(/^(.+?)<\/p>/);
      if (!nameM) continue;
      const name = nameM[1].trim();
      const afterDiv = part.substring(part.indexOf('</div>') + 6);
      const spans = [...afterDiv.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
      if (spans.length < 4) continue;
      const parseNum = s => parseInt(s.replace(/\./g, '')) || 0;
      const hp = parseNum(spans[0]);
      const exp = parseNum(spans[1]);
      const gold = parseNum(spans[2]);
      const mapsText = spans[3] || '';
      const dropsText = spans[4] || '';
      const maps = [...mapsText.matchAll(/Mapa:\s*(\d+)/g)].map(x => +x[1]);
      const drops = (!dropsText || dropsText === '-') ? [] : dropsText.split('|').map(s => s.trim()).filter(Boolean);
      db[name] = { hp, exp, gold, maps, drops };
    }
    return db;
  }

  function parseWikiSpells(html) {
    const db = {};
    const parts = html.split(/<p class="font-medium text-white">/);
    parts.shift();
    for (const part of parts) {
      const nameM = part.match(/^(.+?)<\/p>/);
      if (!nameM) continue;
      const name = nameM[1].trim();
      const descM = part.match(/<p class="mt-1[^"]*">([\s\S]*?)<\/p>/);
      const desc = descM ? descM[1].replace(/<[^>]+>/g, '').trim() : '';
      const afterDiv = part.substring(part.indexOf('</div>') + 6);
      const spans = [...afterDiv.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
      const skill = parseInt(spans[0]) || 0;
      const mana = parseInt(spans[1]) || 0;
      db[name] = { desc: desc.substring(0, 120), skill, mana };
    }
    return db;
  }

  function parseWikiMaps(html) {
    const db = {};
    const parts = html.split(/<p class="font-medium text-white">/);
    parts.shift();
    for (const part of parts) {
      const nameM = part.match(/^(.+?)<\/p>/);
      if (!nameM) continue;
      const name = nameM[1].trim();
      const afterDiv = part.substring(part.indexOf('</div>') + 6);
      const spans = [...afterDiv.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
      const mapNumM = name.match(/(\d+)/);
      const mapNum = mapNumM ? +mapNumM[1] : 0;
      const npcsText = spans[0] || '';
      const levelText = spans[1] || '';
      const npcs = npcsText.split(/[,|]/).map(s => s.trim()).filter(Boolean);
      const levelM = levelText.match(/(\d+)/);
      const level = levelM ? +levelM[1] : 0;
      if (mapNum > 0) db[mapNum] = { name, npcs, level, raw: spans };
    }
    return db;
  }

  async function fetchWikiData() {
    try {
      const [npcsResp, spellsResp, mapsResp] = await Promise.all([
        fetch('/wiki/npcs').then(r => r.text()),
        fetch('/wiki/spells').then(r => r.text()),
        fetch('/wiki/maps').then(r => r.text()).catch(() => ''),
      ]);
      const npcs = parseWikiNpcs(npcsResp);
      const spells = parseWikiSpells(spellsResp);
      const maps = mapsResp ? parseWikiMaps(mapsResp) : {};
      if (Object.keys(npcs).length > 0) BESTIARY_DB = npcs;
      if (Object.keys(spells).length > 0) SPELLS_DB = spells;
      if (Object.keys(maps).length > 0) MAPS_DB = maps;
      wikiLoaded = true;
      try {
        localStorage.setItem(WIKI_CACHE_KEY, JSON.stringify({ ts: Date.now(), npcs, spells, maps }));
      } catch (e) {}
      console.log(`[AOWeb HUD] Wiki sync: ${Object.keys(npcs).length} NPCs, ${Object.keys(spells).length} hechizos, ${Object.keys(maps).length} mapas`);
      showToast('Wiki sincronizada', `${Object.keys(npcs).length} criaturas · ${Object.keys(spells).length} hechizos · ${Object.keys(maps).length} mapas`, '📖', 'learned');
      renderManual();
    } catch (e) {
      console.warn('[AOWeb HUD] Wiki fetch failed, using cache', e);
    }
  }

  loadWikiCache();
  let bestiaryFilter = '';
  let filterHpRange = '';
  let filterMap = '';

  // ===== Patrones =====
  const CONSOLE_DETECT = /Ves a |\[Vida:|Has matado|Le has pegado|Has impactado|Te han pegado|Te ha pegado|Te ha quitado|monedas de oro|Conectado como|Bienvenido a|\[Retos?\]|\[Global\]|\[Sistema\]|Has lanzado|Te has curado|Has subido al nivel|Has dejado de estar|Has ganado|Has recuperado|Terminas de meditar|Has obtenido|Encontraste|Has recogido|Has entrado a|Te encuentras en/;
  const NPC_RX = /^Ves a (.+?) \[([^\]]+)\] \[Vida:\s*(\d+)\/(\d+)\]\s*(.*)$/;
  const PJ_RX  = /^Ves a (.+?)(?:\s<([^>]+)>)?\s-\s([^,]+),\s*nivel\s+(\d+)(?:\s-\s+(.+?))?\s*(\[.*)?$/;
  const CAST_RX = /^(?:Has lanzado|Lanzaste)(?:\s+el hechizo)?\s+(.+?)\s+sobre\s+(.+?)\.?$/;
  const CONNECT_RX = /^Conectado como\s+(.+?)\s*$/;
  const HIT_DONE_RX = /(?:Le has pegado a|Has impactado a)\s+(.+?)\s+por\s+(\d+)/;
  const HIT_RECV_RX = /(?:Te ha pegado|Te ha impactado)\s+(.+?)\s+por\s+(\d+)/;
  const HIT_RECV2_RX = /^(.+?)\s+te ha quitado\s+(\d+)/i;
  const LE_HAS_QUITADO_RX = /Le has quitado\s+(\d+)\s+puntos de vida a\s+(.+?)\.?$/;
  const KILL_RX = /^Has matado a\s+(.+?)\.?$/;
  const BUFF_END_RX = /(?:Has dejado de estar afectado por|Ya no estás afectado por|El efecto de|Has perdido el efecto de)\s+(.+?)(?:\.|$)/i;
  const XP_GAIN_RX = /Has ganado\s+(\d+)\s+puntos? de experiencia/i;
  const GOLD_GAIN_RX = /Has ganado\s+(\d+)\s+monedas? de oro/i;
  const MANA_RECV_RX = /Has recuperado\s+(\d+)\s+puntos? de man[aá]/i;
  const MEDITATE_END_RX = /Terminas de meditar/i;
  const DROP_RX = /(?:Has obtenido|Encontraste|Has recogido|Agarraste)\s+(.+?)\.?$/i;
  const LEVEL_UP_RX = /Has subido al nivel\s+(\d+)/i;
  const HEAL_RX = /Te has curado\s+(\d+)\s+puntos? de vida/i;
  const MAP_ENTER_RX = /^(?:Has entrado a|Entraste a|Te encuentras en)\s+(.+?)\.?$/i;
  const MAP_NUM_RX = /^Mapa\s+(\d+)/i;

  const patterns = [
    { cat: 'mob_visible', re: /^Ves a\s/ },
    { cat: 'combat_kill_done', re: /Has matado a/i },
    { cat: 'combat_hit_done', re: /Le has pegado|Has impactado|Le has quitado/i },
    { cat: 'combat_hit_recv', re: /Te han pegado|Te ha pegado|te ha quitado/i },
    { cat: 'spell_cast_done', re: /Has lanzado|Lanzaste/i },
    { cat: 'buff_end', re: /Has dejado de|Ya no estás afectado|El efecto de/i },
  ];
  function categorize(t) { for (const p of patterns) if (p.re.test(t)) return p.cat; return 'otros'; }

  // ===== Hook WebSocket =====
  const NativeWS = window.WebSocket;
  function HookedWS(url, protocols) {
    const ws = protocols ? new NativeWS(url, protocols) : new NativeWS(url);
    const origSend = ws.send.bind(ws);
    ws.send = function (data) {
      if (data instanceof Blob) data.arrayBuffer().then(b => recordWS('OUT', b));
      else recordWS('OUT', data);
      return origSend(data);
    };
    ws.addEventListener('message', (ev) => {
      if (ev.data instanceof Blob) ev.data.arrayBuffer().then(b => recordWS('IN', b));
      else recordWS('IN', ev.data);
    });
    return ws;
  }
  HookedWS.prototype = NativeWS.prototype;
  HookedWS.CONNECTING = NativeWS.CONNECTING; HookedWS.OPEN = NativeWS.OPEN;
  HookedWS.CLOSING = NativeWS.CLOSING; HookedWS.CLOSED = NativeWS.CLOSED;
  window.WebSocket = HookedWS;

  function recordWS(dir, data) {
    let e = { ts: Date.now(), dir };
    if (typeof data === 'string') { e.kind = 'text'; e.text = data; }
    else if (data instanceof ArrayBuffer) { e.kind = 'binary'; e.len = data.byteLength; }
    wsTraffic.push(e); if (wsTraffic.length > MAX) wsTraffic.shift();
  }

  // ===== Google Fonts =====
  function loadFonts() {
    if (document.getElementById('aohud-fonts')) return;
    const link = document.createElement('link');
    link.id = 'aohud-fonts';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600;700;900&family=IM+Fell+English:ital@0;1&family=Press+Start+2P&display=swap';
    (document.head || document.documentElement).appendChild(link);
  }
  loadFonts();

  // ===== ESTILOS v1.3 =====
  const styles = document.createElement('style');
  styles.textContent = `
    [id^="aohud-"], [id^="aohud-"] * { box-sizing: border-box; }

    /* === PANEL UNIFICADO — arriba izquierda === */
    #aohud-panel { position: fixed; top: 8px; left: 8px; width: 350px;
      max-height: calc(100vh - 50px); z-index: 2147483646;
      background: linear-gradient(180deg, rgba(28, 22, 14, 0.94), rgba(12, 10, 6, 0.96));
      border: 2px solid #8a6a2a; border-radius: 18px;
      box-shadow:
        0 0 0 1px #d4a857 inset,
        0 4px 24px rgba(0,0,0,0.7);
      display: flex; flex-direction: column;
      font-family: 'IM Fell English', 'Cinzel', serif; color: #e8e8d0;
      opacity: 0.75; transition: opacity 0.2s, width 0.3s; overflow: hidden; }
    #aohud-panel:hover { opacity: 1; }
    #aohud-panel.collapsed { width: 68px; overflow: hidden; }
    #aohud-panel.collapsed:hover { opacity: 1; }
    #aohud-panel.collapsed .tabs,
    #aohud-panel.collapsed .search-wrap,
    #aohud-panel.collapsed .body,
    #aohud-panel.collapsed .footer,
    #aohud-panel.collapsed .player-header .pinfo,
    #aohud-panel.collapsed .player-header .mini-stats { display: none; }
    #aohud-panel.collapsed .player-header { padding: 10px 8px; justify-content: center; }
    :fullscreen #aohud-panel { width: 350px; }
    :fullscreen #aohud-panel.collapsed { width: 68px; }

    /* Player header compacto */
    #aohud-panel .player-header { display: flex; align-items: center; gap: 10px;
      padding: 14px 16px; border-bottom: 1px solid rgba(106, 74, 24, 0.6); }
    #aohud-panel .player-header .avatar-wrap { position: relative; width: 52px; height: 52px;
      flex-shrink: 0; cursor: pointer; }
    #aohud-panel .player-header .avatar { width: 52px; height: 52px; border-radius: 50%;
      background: radial-gradient(circle at 35% 30%, #6a4a18 0%, transparent 50%),
        linear-gradient(135deg, #3a2a1a, #1a1208);
      border: 2px solid #d4a857;
      box-shadow: 0 0 0 1px #1a1408 inset, 0 0 8px rgba(212, 168, 87, 0.4),
        inset 0 0 8px rgba(0,0,0,0.6);
      display: flex; align-items: center; justify-content: center;
      font-family: 'Cinzel', serif; font-weight: 900;
      font-size: 24px; color: #f4d97a;
      text-shadow: 0 1px 3px rgba(0,0,0,0.9), 0 0 8px rgba(212, 168, 87, 0.3);
      overflow: hidden; }
    #aohud-panel .player-header .pinfo { flex: 1; min-width: 0; }
    #aohud-panel .player-header .pname { font-family: 'Cinzel', serif; font-size: 18px;
      font-weight: 700; color: #f4d97a; letter-spacing: 0.5px;
      text-shadow: 0 1px 3px rgba(0,0,0,0.95), 0 0 8px rgba(212, 168, 87, 0.4);
      line-height: 1; }
    #aohud-panel .player-header .pclass { font-family: 'IM Fell English', serif; font-size: 14px;
      color: #b8a878; font-style: italic; margin-top: 2px; }
    #aohud-panel .player-header .mini-stats { display: flex; gap: 8px; margin-top: 4px; }
    #aohud-panel .player-header .ms { display: flex; align-items: baseline; gap: 3px; }
    #aohud-panel .player-header .ms-l { font-family: 'IM Fell English', serif;
      font-size: 11px; color: #8a7a5a; font-style: italic; }
    #aohud-panel .player-header .ms-v { font-family: 'Press Start 2P', monospace;
      font-size: 10px; color: #f4d97a;
      text-shadow: 0 1px 2px rgba(0,0,0,0.8); }

    /* v1.11 — Sticky Auto-Ataque (siempre arriba, no se mueve con CC activos) */
    #aohud-panel .aa-sticky { display: flex; align-items: center; gap: 8px;
      padding: 7px 14px; cursor: pointer;
      background: linear-gradient(180deg, rgba(35,18,8,0.7), rgba(15,10,5,0.85));
      border-bottom: 1px solid rgba(106, 74, 24, 0.6);
      border-top: 1px solid rgba(106, 74, 24, 0.3);
      font-family: 'Cinzel', serif; font-size: 13px;
      color: #b8a878; letter-spacing: 1.5px; text-transform: uppercase;
      transition: background 0.15s, color 0.15s; user-select: none; }
    #aohud-panel .aa-sticky:hover { background: linear-gradient(180deg, rgba(45,25,10,0.85), rgba(20,12,6,0.95));
      color: #d4a857; }
    #aohud-panel .aa-sticky .aa-ico { font-size: 16px; }
    #aohud-panel .aa-sticky .aa-lbl { flex: 1; }
    #aohud-panel .aa-sticky .aa-state { font-family: 'Press Start 2P', monospace;
      font-size: 9px; padding: 3px 6px; border-radius: 3px;
      background: rgba(80,80,70,0.3); color: #8a7a5a;
      border: 1px solid rgba(106, 74, 24, 0.4); }
    #aohud-panel .aa-sticky.on { background: linear-gradient(180deg, rgba(60,18,18,0.75), rgba(20,8,8,0.9));
      color: #ffb0b0;
      box-shadow: 0 0 12px rgba(255, 80, 80, 0.35) inset; }
    #aohud-panel .aa-sticky.on .aa-state { background: rgba(160,24,24,0.5);
      color: #ffd0d0; border-color: #ff6464;
      animation: aohud-aa-state-pulse 1.4s ease-in-out infinite; }
    @keyframes aohud-aa-state-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(255,100,100,0); }
      50% { box-shadow: 0 0 0 3px rgba(255,100,100,0.4); }
    }

    /* Tabs */
    #aohud-panel .tabs { display: flex;
      border-bottom: 1px solid rgba(106, 74, 24, 0.6); }
    #aohud-panel .tab { flex: 1; padding: 7px 0; text-align: center;
      cursor: pointer; font-family: 'Cinzel', serif; font-weight: 700;
      font-size: 14px; color: #8a7a5a; letter-spacing: 1.5px;
      text-transform: uppercase; transition: all 0.15s;
      border-bottom: 2px solid transparent; }
    #aohud-panel .tab:hover { color: #d4a857; }
    #aohud-panel .tab.active { color: #f4d97a;
      border-bottom-color: #d4a857;
      text-shadow: 0 0 8px rgba(212, 168, 87, 0.4); }

    /* Body */
    #aohud-panel .body { overflow-y: auto; padding: 10px 14px; flex: 1; }
    #aohud-panel .body::-webkit-scrollbar { width: 6px; }
    #aohud-panel .body::-webkit-scrollbar-track { background: rgba(0,0,0,0.4); }
    #aohud-panel .body::-webkit-scrollbar-thumb { background: #8a6a2a; border-radius: 3px;
      border: 1px solid #1a1408; }
    #aohud-panel .empty { padding: 16px 8px; text-align: center; color: #7a7a6a;
      font-family: 'IM Fell English', serif; font-style: italic;
      font-size: 14px; line-height: 1.5; }

    /* Macros tab */
    #aohud-panel .m-title { font-family: 'Cinzel', serif; font-size: 11px;
      letter-spacing: 0.3em; color: #d4a857; text-transform: uppercase;
      margin: 10px 0 6px; padding-bottom: 3px;
      border-bottom: 1px solid rgba(138, 106, 42, 0.35); }
    #aohud-panel .m-btn { display: flex; align-items: center; gap: 10px;
      width: 100%; padding: 8px 10px; margin-bottom: 5px;
      background: rgba(15,12,8,0.55); border: 1px solid #5a4a25;
      border-left: 3px solid #8a6a2a; color: #e8e8d0; cursor: pointer;
      text-align: left; transition: background 0.15s, border-color 0.15s, transform 0.1s;
      font-family: inherit; }
    #aohud-panel .m-btn:hover { background: rgba(212,168,87,0.18);
      border-color: #d4a857; }
    #aohud-panel .m-btn:active { transform: scale(0.98); }
    #aohud-panel .m-btn.fired { background: rgba(108,221,138,0.3);
      border-left-color: #6dd58a; }
    #aohud-panel .m-btn .m-ico { font-size: 18px; flex-shrink: 0;
      width: 22px; text-align: center; }
    #aohud-panel .m-btn .m-info { flex: 1; display: flex; flex-direction: column;
      min-width: 0; line-height: 1.2; }
    #aohud-panel .m-btn .m-name { font-family: 'Cinzel', serif; font-size: 13px;
      color: #efe2c5; }
    #aohud-panel .m-btn .m-key { font-family: 'IM Fell English', serif;
      font-size: 11px; color: #b89a5a; margin-top: 1px; }
    #aohud-panel .m-btn.m-aa { border-left-color: #a01818; }
    #aohud-panel .m-btn.m-aa.on { background: rgba(160,24,24,0.28);
      border-left-color: #ff6464; animation: aohud-aa-pulse 1.2s ease-in-out infinite; }
    #aohud-panel .m-btn.m-aa.on .m-name { color: #ffb0b0; }
    @keyframes aohud-aa-pulse {
      0%, 100% { box-shadow: inset 0 0 0 0 rgba(255,100,100,0); }
      50% { box-shadow: inset 0 0 14px 0 rgba(255,100,100,0.35); }
    }
    #aohud-panel .m-slider-row { display: flex; align-items: center; gap: 8px;
      padding: 6px 0 10px; }
    #aohud-panel .m-slider-lbl { font-family: 'IM Fell English', serif;
      font-size: 12px; color: #b8a878; flex-shrink: 0; min-width: 60px; }
    #aohud-panel .m-slider { flex: 1; -webkit-appearance: none; appearance: none;
      height: 6px; background: rgba(15,12,8,0.6); border: 1px solid #5a4a25;
      border-radius: 3px; outline: none; cursor: pointer; }
    #aohud-panel .m-slider::-webkit-slider-thumb { -webkit-appearance: none;
      appearance: none; width: 16px; height: 16px; border-radius: 50%;
      background: #d4a857; border: 2px solid #1a1408; cursor: pointer;
      box-shadow: 0 0 4px rgba(212,168,87,0.6); }
    #aohud-panel .m-slider::-moz-range-thumb { width: 14px; height: 14px;
      border-radius: 50%; background: #d4a857; border: 2px solid #1a1408;
      cursor: pointer; box-shadow: 0 0 4px rgba(212,168,87,0.6); }
    #aohud-panel .m-slider:hover::-webkit-slider-thumb { background: #f4d97a; }
    #aohud-panel .m-slider-val { font-family: 'Press Start 2P', monospace;
      font-size: 10px; color: #f4d97a; min-width: 56px; text-align: right; }
    /* v1.11: presets de velocidad */
    #aohud-panel .m-preset-row { display: flex; gap: 4px; padding: 0 0 10px; flex-wrap: wrap; }
    #aohud-panel .m-preset-btn { flex: 1; min-width: 38px; padding: 4px 6px;
      background: rgba(15,12,8,0.5); border: 1px solid #5a4a25; color: #b89a5a;
      font-family: 'Press Start 2P', monospace; font-size: 9px; cursor: pointer;
      border-radius: 3px; transition: all 0.15s; }
    #aohud-panel .m-preset-btn:hover { background: rgba(212,168,87,0.2); color: #f4d97a;
      border-color: #d4a857; }
    #aohud-panel .m-preset-btn.active { background: rgba(212,168,87,0.32); color: #f4d97a;
      border-color: #d4a857; box-shadow: 0 0 6px rgba(212,168,87,0.45) inset; }
    #aohud-panel .m-measure-row { display: flex; align-items: center; gap: 6px;
      padding: 4px 0 10px; flex-wrap: wrap; }
    #aohud-panel .m-measure-lbl { font-family: 'IM Fell English', serif;
      font-size: 12px; color: #b8a878; flex: 1; min-width: 0; }
    #aohud-panel .m-measure-lbl b { color: #f4d97a;
      font-family: 'Press Start 2P', monospace; font-size: 11px; }
    #aohud-panel .m-use-measured { background: rgba(108,221,138,0.18);
      border: 1px solid #6dd58a; color: #b6f0c3; padding: 4px 10px;
      font-family: 'Cinzel', serif; font-size: 11px; cursor: pointer;
      transition: background 0.15s; }
    #aohud-panel .m-use-measured:hover { background: rgba(108,221,138,0.32); }
    #aohud-panel .m-reset-measured { background: rgba(15,12,8,0.5);
      border: 1px solid #5a4a25; color: #b89a5a; padding: 4px 7px;
      font-family: monospace; font-size: 13px; cursor: pointer; }
    #aohud-panel .m-reset-measured:hover { background: rgba(212,168,87,0.2); color: #f4d97a; }
    #aohud-panel .m-hint { font-family: 'IM Fell English', serif; font-size: 11px;
      color: #7a7a6a; padding: 4px 2px 8px; line-height: 1.4; font-style: italic; }

    /* Target Card */
    #aohud-target-card { padding: 10px; margin-bottom: 8px;
      background: linear-gradient(135deg, rgba(45, 22, 10, 0.5), rgba(20, 10, 5, 0.7));
      border: 1px solid #d4a857; border-radius: 6px;
      box-shadow: 0 0 0 1px rgba(212, 168, 87, 0.2) inset, 0 0 12px rgba(212, 168, 87, 0.2); }
    #aohud-target-card .row { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
    #aohud-target-card .ava { width: 40px; height: 40px; border-radius: 50%;
      background: radial-gradient(circle at 35% 30%, rgba(212, 168, 87, 0.3), #1a1408);
      border: 2px solid #d4a857;
      display: flex; align-items: center; justify-content: center;
      font-size: 24px; line-height: 1; flex-shrink: 0;
      box-shadow: inset 0 0 8px rgba(0,0,0,0.6); }
    #aohud-target-card .info { flex: 1; min-width: 0; }
    #aohud-target-card .tname { font-family: 'Cinzel', serif; font-size: 18px;
      font-weight: 700; color: #f4d97a;
      text-shadow: 0 1px 2px rgba(0,0,0,0.9); }
    #aohud-target-card .sub { font-size: 14px; color: #b8a878;
      font-family: 'IM Fell English', serif; font-style: italic; margin-top: 1px; }
    #aohud-target-card .hpbar { position: relative; height: 14px;
      background: #1a0606; border: 1px solid #6a4a18; border-radius: 2px;
      overflow: hidden; box-shadow: inset 0 1px 2px rgba(0,0,0,0.9); }
    #aohud-target-card .hpbar .fill { position: absolute; left: 0; top: 0;
      height: 100%;
      background: linear-gradient(to bottom, #e64545 0%, #a01818 60%, #6a0808 100%);
      transition: width 0.3s; }
    #aohud-target-card .hpbar .txt { position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      font-family: 'Press Start 2P', monospace; font-size: 9px;
      color: #fff; text-shadow: 1px 1px 0 #000; }

    /* Estados dentro de target card */
    #aohud-target-card .states-container { margin-top: 8px; padding-top: 6px;
      border-top: 1px solid rgba(106, 74, 24, 0.4); }
    #aohud-target-card .states-label { font-family: 'Cinzel', serif; font-size: 13px;
      color: #8a7a5a; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 4px; }
    #aohud-target-card .state-item { padding: 5px 8px; margin-bottom: 3px;
      background: rgba(212, 168, 87, 0.1); border-left: 3px solid #d4a857;
      border-radius: 0 3px 3px 0;
      display: flex; align-items: center; gap: 6px;
      font-size: 14px; color: #f4d97a; }
    #aohud-target-card .state-item .state-time { font-family: 'Press Start 2P', monospace;
      font-size: 11px; margin-left: auto; min-width: 40px; text-align: right; }
    #aohud-target-card .state-item.urgent { border-left-color: #e24b4a; }
    #aohud-target-card .state-item.urgent .state-time { color: #ff9090; }
    #aohud-target-card .state-item.unknown-dur { border-left-color: #8a7a5a; }
    #aohud-target-card .state-item.unknown-dur .state-time { color: #8a7a5a;
      animation: aohud-unknown-pulse 2s infinite ease-in-out; }
    @keyframes aohud-unknown-pulse {
      0%, 100% { opacity: 1; } 50% { opacity: 0.4; }
    }

    /* Search & filters */
    #aohud-panel .search-wrap { padding: 6px 10px; border-bottom: 1px solid rgba(106, 74, 24, 0.4); }
    #aohud-panel .search-row { display: flex; gap: 5px; }
    #aohud-panel .search-row input,
    #aohud-panel .search-row select { padding: 5px 7px;
      background: rgba(15, 12, 8, 0.6); border: 1px solid #8a6a2a; border-radius: 4px;
      color: #e8e8d0; font-family: 'IM Fell English', serif; font-size: 14px;
      outline: none; }
    #aohud-panel .search-row input:focus,
    #aohud-panel .search-row select:focus { border-color: #d4a857; }
    #aohud-panel .search-row input::placeholder { color: #5a5a4a; font-style: italic; }
    #aohud-panel .search-row input#aohud-search { flex: 1; min-width: 0; }
    #aohud-panel .search-row input#aohud-filter-map { width: 52px; flex: none; text-align: center; }
    #aohud-panel .search-row select { flex: none; cursor: pointer; padding-right: 4px; }
    #aohud-panel .search-row select option { background: #1a1308; color: #e8e8d0; }
    #aohud-panel .wiki-links { display: flex; gap: 4px; margin-top: 6px; }
    #aohud-panel .wiki-links .wl-btn { flex: 1; text-align: center; padding: 6px 2px;
      font-size: 20px; line-height: 1;
      background: linear-gradient(135deg, rgba(20, 15, 8, 0.6), rgba(10, 8, 4, 0.8));
      border: 1px solid rgba(138, 106, 42, 0.5); border-radius: 5px;
      cursor: pointer; transition: all 0.15s;
      filter: grayscale(0.3); }
    #aohud-panel .wiki-links .wl-btn:hover { border-color: #d4a857;
      background: linear-gradient(135deg, rgba(212, 168, 87, 0.2), rgba(45, 22, 10, 0.7));
      filter: grayscale(0); transform: scale(1.1); }

    /* Monster Manual entries */
    #aohud-panel .mob-entry { padding: 6px 8px; margin-bottom: 4px;
      background: rgba(15, 12, 8, 0.4);
      border: 1px solid rgba(106, 74, 24, 0.3); border-radius: 4px;
      display: flex; align-items: center; gap: 8px; cursor: pointer; }
    #aohud-panel .mob-entry:hover { border-color: rgba(212, 168, 87, 0.5);
      background: rgba(15, 12, 8, 0.6); }
    #aohud-panel .mob-entry.db-only { opacity: 0.6; }
    #aohud-panel .mob-entry.db-only:hover { opacity: 0.85; }
    #aohud-panel .mob-entry .e-ico { font-size: 18px; line-height: 1;
      filter: drop-shadow(0 1px 2px rgba(0,0,0,0.7)); }
    #aohud-panel .mob-entry .e-info { flex: 1; min-width: 0; }
    #aohud-panel .mob-entry .e-name { font-family: 'Cinzel', serif; font-size: 16px;
      color: #e8e8d0; font-weight: 500;
      text-shadow: 0 1px 2px rgba(0,0,0,0.8); }
    #aohud-panel .mob-entry .e-stats { font-size: 11px; color: #b8a878;
      font-family: 'Press Start 2P', monospace; margin-top: 2px; letter-spacing: -0.5px; }
    #aohud-panel .mob-entry .e-sub { font-size: 12px; color: #6a6a5a;
      font-family: 'IM Fell English', serif; font-style: italic; margin-top: 1px; }
    #aohud-panel .mob-entry .e-kills { font-family: 'Cinzel', serif; font-size: 15px;
      font-weight: 700; color: #d4a857; }

    /* Section headers inside manual */
    #aohud-panel .section-head { font-family: 'Cinzel', serif; font-size: 11px;
      color: #8a7a5a; text-transform: uppercase; letter-spacing: 1.5px;
      padding: 8px 4px 4px; }

    /* Stats panel */
    #aohud-panel .stat-row { display: flex; justify-content: space-between;
      padding: 5px 4px; border-bottom: 1px solid rgba(106, 74, 24, 0.3); }
    #aohud-panel .stat-row .label { font-family: 'IM Fell English', serif;
      font-size: 14px; color: #b8a878; font-style: italic; }
    #aohud-panel .stat-row .val { font-family: 'Press Start 2P', monospace;
      font-size: 11px; color: #f4d97a;
      text-shadow: 0 1px 2px rgba(0,0,0,0.8); }
    #aohud-panel .stat-row:last-child { border-bottom: none; }

    /* Footer */
    #aohud-panel .footer { padding: 6px 14px;
      border-top: 1px solid rgba(106, 74, 24, 0.6);
      display: flex; align-items: center; justify-content: space-between; }
    #aohud-panel .footer .stat { font-family: 'Press Start 2P', monospace;
      font-size: 8px; color: #8a7a5a; letter-spacing: -0.5px; }
    #aohud-panel .footer .sound-toggle { cursor: pointer; font-size: 16px;
      opacity: 0.9; transition: all 0.15s; }
    #aohud-panel .footer .sound-toggle:hover { transform: scale(1.2); }
    #aohud-panel .footer .sound-toggle.muted { opacity: 0.3; }

    /* Head picker */
    #aohud-head-picker { position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(11, 17, 34, 0.97); z-index: 10; overflow-y: auto;
      padding: 12px; }
    #aohud-head-picker .hp-title { font-family: 'Cinzel', serif; font-size: 16px;
      color: #d4a857; text-align: center; margin-bottom: 10px;
      text-transform: uppercase; letter-spacing: 2px; }
    #aohud-head-picker .hp-race { font-family: 'Cinzel', serif; font-size: 12px;
      color: #8a7a5a; text-transform: uppercase; letter-spacing: 1px;
      margin: 8px 0 4px; border-bottom: 1px solid rgba(106, 74, 24, 0.3); padding-bottom: 2px; }
    #aohud-head-picker .hp-grid { display: flex; flex-wrap: wrap; gap: 4px; }
    #aohud-head-picker .hp-head { border: 1px solid rgba(138, 106, 42, 0.4);
      border-radius: 4px; cursor: pointer; background-color: rgba(0,0,0,0.3); }
    #aohud-head-picker .hp-head:hover { border-color: #d4a857;
      box-shadow: 0 0 6px rgba(212, 168, 87, 0.5); }

    /* Estados Activos (multi-enemy) */
    #aohud-panel .active-section { margin-top: 10px;
      padding-top: 10px; border-top: 1px solid rgba(106, 74, 24, 0.5); }
    #aohud-panel .active-section .as-title { font-family: 'Cinzel', serif;
      font-size: 15px; color: #d4a857; font-weight: 700;
      text-transform: uppercase; letter-spacing: 1.5px;
      margin-bottom: 6px;
      text-shadow: 0 1px 2px rgba(0,0,0,0.8); }
    #aohud-panel .am-item { display: grid; grid-template-columns: 22px 1fr auto 18px;
      grid-template-rows: auto auto; column-gap: 6px;
      padding: 5px 8px; margin-bottom: 4px; cursor: pointer;
      background: linear-gradient(135deg, rgba(45, 22, 10, 0.5), rgba(20, 10, 5, 0.7));
      border: 1px solid #8a6a2a; border-radius: 4px;
      transition: all 0.15s; }
    #aohud-panel .am-item:hover {
      background: linear-gradient(135deg, rgba(212, 168, 87, 0.2), rgba(45, 22, 10, 0.7));
      border-color: #d4a857; }
    #aohud-panel .am-item.is-target {
      border-color: #f4d97a;
      box-shadow: 0 0 0 1px rgba(212, 168, 87, 0.4) inset, 0 0 8px rgba(212, 168, 87, 0.3); }
    /* v1.11 — Lock per-instance: card clickeada explícitamente queda con glow dorado fuerte */
    #aohud-panel .am-item.is-locked {
      border-color: #f4d97a; border-width: 2px;
      box-shadow: 0 0 0 1px rgba(244,217,122,0.6) inset, 0 0 16px rgba(244,217,122,0.55);
      background: linear-gradient(135deg, rgba(212, 168, 87, 0.28), rgba(45, 22, 10, 0.7)); }
    /* v1.11 — Color rotatorio por índice de instancia (borde izquierdo grueso) */
    #aohud-panel .am-item { border-left-width: 4px; }
    #aohud-panel .am-item.cc-c0 { border-left-color: #3a6fb0; }
    #aohud-panel .am-item.cc-c1 { border-left-color: #a06fc8; }
    #aohud-panel .am-item.cc-c2 { border-left-color: #d4a857; }
    #aohud-panel .am-item.cc-c3 { border-left-color: #5ba075; }
    #aohud-panel .am-item.cc-c4 { border-left-color: #c46a6a; }
    #aohud-panel .am-item .cc-badge { display: inline-block; min-width: 18px; padding: 0 4px;
      margin-right: 4px; border-radius: 3px;
      font-family: 'Cinzel', serif; font-weight: 800; font-size: 12px;
      color: #1a1408; text-align: center; line-height: 16px;
      box-shadow: 0 1px 2px rgba(0,0,0,0.5); }
    #aohud-panel .am-item.cc-c0 .cc-badge { background: #6f9ed4; }
    #aohud-panel .am-item.cc-c1 .cc-badge { background: #c89ed8; }
    #aohud-panel .am-item.cc-c2 .cc-badge { background: #f4d97a; }
    #aohud-panel .am-item.cc-c3 .cc-badge { background: #8fcfa5; }
    #aohud-panel .am-item.cc-c4 .cc-badge { background: #e0a0a0; }
    #aohud-panel .am-item.urgent {
      border-color: #e24b4a;
      animation: aohud-am-pulse 0.6s infinite ease-in-out; }
    @keyframes aohud-am-pulse {
      0%, 100% { box-shadow: 0 0 0 1px rgba(226, 75, 74, 0.3) inset, 0 0 4px rgba(226, 75, 74, 0.3); }
      50% { box-shadow: 0 0 0 1px rgba(226, 75, 74, 0.7) inset, 0 0 12px rgba(255, 80, 80, 0.7); }
    }
    #aohud-panel .am-item .am-emoji { font-size: 16px; line-height: 1;
      grid-row: 1 / 3; align-self: center; }
    #aohud-panel .am-item .am-name { font-family: 'Cinzel', serif; font-size: 15px;
      color: #e8e8d0; font-weight: 500;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      text-shadow: 0 1px 2px rgba(0,0,0,0.8); }
    #aohud-panel .am-item .am-hp { font-family: 'Press Start 2P', monospace;
      font-size: 10px; color: #b8a878; text-align: right; align-self: center; }
    #aohud-panel .am-item .am-dismiss { grid-row: 1 / 3; align-self: center;
      font-size: 14px; color: #6a5a4a; cursor: pointer; padding: 2px 4px;
      line-height: 1; transition: color 0.15s; }
    #aohud-panel .am-item .am-dismiss:hover { color: #e24b4a; }
    #aohud-panel .am-item .am-states { grid-column: 2 / 5; display: flex; gap: 8px;
      font-family: 'Press Start 2P', monospace;
      font-size: 11px; color: #f4d97a;
      text-shadow: 0 1px 2px rgba(0,0,0,0.8); }
    #aohud-panel .am-item.urgent .am-states { color: #ff9090; }

    /* === TOASTS === */
    #aohud-toasts { position: fixed; top: 16px; left: 50%;
      transform: translateX(-50%); z-index: 2147483647;
      display: flex; flex-direction: column; gap: 8px;
      pointer-events: none; align-items: center; }
    .aohud-toast { display: flex; align-items: center; gap: 12px;
      padding: 10px 18px;
      background: linear-gradient(135deg, rgba(28, 22, 14, 0.97), rgba(15, 12, 8, 0.99));
      border: 2px solid #f4d97a; border-radius: 8px;
      box-shadow:
        0 0 0 1px #d4a857 inset,
        0 0 24px rgba(212, 168, 87, 0.5),
        0 4px 16px rgba(0,0,0,0.8);
      font-family: 'Cinzel', serif; color: #f4d97a;
      max-width: 380px;
      animation: aohud-toast-in 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
    .aohud-toast .t-ico { font-size: 26px; line-height: 1;
      filter: drop-shadow(0 0 8px rgba(212, 168, 87, 0.7)); }
    .aohud-toast .t-content { display: flex; flex-direction: column; }
    .aohud-toast .t-title { font-size: 13px; color: #d4a857;
      text-transform: uppercase; letter-spacing: 2px;
      text-shadow: 0 1px 2px rgba(0,0,0,0.9); }
    .aohud-toast .t-detail { font-size: 14px; color: #f4d97a;
      font-weight: 600; margin-top: 2px;
      text-shadow: 0 1px 2px rgba(0,0,0,0.9); }
    .aohud-toast.learned { border-color: #6dd58a;
      box-shadow: 0 0 0 1px #6dd58a inset, 0 0 24px rgba(109, 213, 138, 0.5),
        0 4px 16px rgba(0,0,0,0.8); }
    .aohud-toast.learned .t-title { color: #6dd58a; }
    .aohud-toast.fade-out { animation: aohud-toast-out 0.5s ease-in forwards; }
    @keyframes aohud-toast-in {
      from { transform: translateY(-20px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    @keyframes aohud-toast-out {
      to { transform: translateY(-20px); opacity: 0; }
    }

    /* === BUFFS card debajo de Ping/Seguro === */
    #aohud-self-buffs { position: fixed; z-index: 2147483643;
      display: flex; flex-direction: column; gap: 6px;
      pointer-events: none;
      padding: 4px 8px;
      background: rgba(12, 10, 6, 0.8);
      border: 1px solid rgba(138, 106, 42, 0.6);
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.5); }
    #aohud-self-buffs:empty { display: none; }
    #aohud-self-buffs .buff {
      background: transparent; border: none; box-shadow: none;
      padding: 0; display: flex; flex-direction: column; align-items: center; gap: 2px; }
    #aohud-self-buffs .buff .ico { font-size: 20px; line-height: 1;
      filter: drop-shadow(0 0 6px rgba(212, 168, 87, 0.6)) drop-shadow(0 1px 2px rgba(0,0,0,0.9));
      display: block; }
    #aohud-self-buffs .buff .time {
      display: block;
      font-family: 'Press Start 2P', monospace;
      font-size: 11px; color: #f4d97a;
      line-height: 1;
      text-shadow: 1px 1px 0 #000, 0 0 4px rgba(0,0,0,0.8); }
    #aohud-self-buffs .cc-divider {
      width: 80%; height: 1px; align-self: center;
      background: rgba(138, 106, 42, 0.4); margin: 2px 0; }
    #aohud-self-buffs .cc-mob .time { color: #ff9090; font-size: 9px; }
    #aohud-self-buffs .buff.expiring .ico {
      animation: aohud-mini-pulse 0.6s infinite ease-in-out; }
    #aohud-self-buffs .buff.expiring .time { color: #ff7878; }
    @keyframes aohud-mini-pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.15); filter: drop-shadow(0 0 6px rgba(255, 80, 80, 0.9)); }
    }

    /* Player status alert (paralysis/immobilize) */
    #aohud-player-alert { position: fixed; z-index: 2147483645;
      transform: translateX(-50%);
      pointer-events: none; text-align: center; }
    #aohud-player-alert .alert-text {
      font-family: 'Press Start 2P', monospace; font-size: 10px;
      color: #ff4444; text-transform: uppercase; letter-spacing: 1px;
      text-shadow: 0 0 8px rgba(255, 50, 50, 0.9), 0 0 16px rgba(255, 0, 0, 0.6),
        1px 1px 0 #000, -1px -1px 0 #000;
      animation: aohud-alert-flash 0.5s infinite ease-in-out; }
    #aohud-player-alert .hp-alert {
      color: #ff2222; font-size: 10px;
      text-shadow: 0 0 12px rgba(255, 0, 0, 0.95), 0 0 24px rgba(200, 0, 0, 0.7),
        2px 2px 0 #000, -2px -2px 0 #000;
      animation: aohud-hp-pulse 0.4s infinite ease-in-out; margin-bottom: 4px; }
    @keyframes aohud-hp-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(1.1); }
    }
    @keyframes aohud-alert-flash {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    /* === CC TRACKER — top-left, below buffs === */

    /* === FLOATING COMBAT TEXT === */
    /* Beefy outline + larger font so our numbers visually cover the game's native ones */
    #aohud-fct { position: fixed; z-index: 2147483644;
      pointer-events: none; overflow: visible; }
    .aohud-fct-num { position: absolute; white-space: nowrap;
      font-family: 'Press Start 2P', monospace; font-weight: 700;
      text-shadow:
        3px 3px 0 #000, -3px -3px 0 #000, 3px -3px 0 #000, -3px 3px 0 #000,
        0 3px 0 #000, 0 -3px 0 #000, 3px 0 0 #000, -3px 0 0 #000,
        0 0 12px rgba(0,0,0,0.95);
      animation: aohud-fct-rise 1.2s ease-out forwards;
      pointer-events: none; }
    .aohud-fct-num.dealt { color: #f4d97a; font-size: 20px; }
    .aohud-fct-num.crit { color: #ff6644; font-size: 26px; }
    .aohud-fct-num.spell { color: #5eaaff; font-size: 22px; }
    .aohud-fct-num.recv { color: #ff4444; font-size: 18px; }
    .aohud-fct-num.heal { color: #6dd58a; font-size: 22px; }
    @keyframes aohud-fct-rise {
      0% { opacity: 1; transform: translateY(0) scale(1); }
      20% { transform: translateY(-12px) scale(1.1); }
      100% { opacity: 0; transform: translateY(-50px) scale(0.8); }
    }

    /* Spell cast: 3 emojis serpenteando hacia arriba (left/right/left wave) */
    .aohud-spell-flash { position: absolute; pointer-events: none;
      font-size: 28px; text-align: center; line-height: 1;
      animation: aohud-spell-serpent 1.9s ease-out forwards;
      filter: drop-shadow(0 0 12px var(--spell-glow, rgba(94,170,255,0.8))); }
    .aohud-spell-flash.alt { animation-name: aohud-spell-serpent-alt; }
    @keyframes aohud-spell-serpent {
      0%   { opacity: 0;   transform: translate(0, 0)      scale(0.5); }
      12%  { opacity: 1;   transform: translate(-14px,-12px) scale(1.15); }
      30%  { opacity: 1;   transform: translate(14px,-32px)  scale(1.05); }
      50%  { opacity: 0.95;transform: translate(-12px,-55px) scale(0.95); }
      72%  { opacity: 0.75;transform: translate(10px,-82px)  scale(0.85); }
      100% { opacity: 0;   transform: translate(0,-120px)    scale(0.6); }
    }
    @keyframes aohud-spell-serpent-alt {
      0%   { opacity: 0;   transform: translate(0, 0)       scale(0.5); }
      12%  { opacity: 1;   transform: translate(14px,-12px)  scale(1.15); }
      30%  { opacity: 1;   transform: translate(-14px,-32px) scale(1.05); }
      50%  { opacity: 0.95;transform: translate(12px,-55px)  scale(0.95); }
      72%  { opacity: 0.75;transform: translate(-10px,-82px) scale(0.85); }
      100% { opacity: 0;   transform: translate(0,-120px)    scale(0.6); }
    }
  `;
  document.documentElement.appendChild(styles);

  // ===== UI: Panel unificado =====
  const panel = document.createElement('div');
  panel.id = 'aohud-panel';
  panel.innerHTML = `
    <div class="player-header">
      <div class="avatar-wrap">
        <div class="avatar" id="player-avatar"></div>
      </div>
      <div class="pinfo">
        <div class="pname" id="player-name">Conectando...</div>
        <div class="pclass" id="player-class"></div>
        <div class="mini-stats">
          <span class="ms"><span class="ms-l">Kills</span><span class="ms-v" id="ss-kills">0</span></span>
          <span class="ms"><span class="ms-l">XP/h</span><span class="ms-v" id="ss-xph">0</span></span>
          <span class="ms"><span class="ms-l">Oro</span><span class="ms-v" id="ss-gold">0</span></span>
          <span class="ms"><span class="ms-l">DPS</span><span class="ms-v" id="ss-dmg">-</span></span>
        </div>
      </div>
    </div>
    <div class="aa-sticky" id="aohud-aa-sticky" title="Auto-ataque (doble-tap Space para toggle)">
      <span class="aa-ico">⚔</span>
      <span class="aa-lbl">Auto-Ataque</span>
      <span class="aa-state" id="aohud-aa-state">OFF</span>
    </div>
    <div class="tabs">
      <div class="tab active" data-tab="manual">Manual</div>
      <div class="tab" data-tab="macros">Macros</div>
      <div class="tab" data-tab="stats">Sesión</div>
    </div>
    <div class="search-wrap" id="aohud-search-wrap">
      <div class="search-row">
        <input type="text" id="aohud-search" placeholder="Nombre..." autocomplete="off" />
        <input type="text" id="aohud-filter-map" placeholder="Mapa" autocomplete="off" />
        <select id="aohud-filter-hp">
          <option value="">HP</option>
          <option value="0-100">1-100</option>
          <option value="101-500">101-500</option>
          <option value="501-2000">501-2k</option>
          <option value="2001-99999">2k+</option>
        </select>
      </div>
      <div class="wiki-links" id="aohud-wiki-links"></div>
    </div>
    <div class="body" id="manual-body"></div>
    <div class="footer">
      <span class="stat" id="stat-ws">0 ws</span>
      <span class="sound-toggle" id="aohud-sound-toggle" title="Alarmas de estado">🔔</span>
    </div>
  `;

  const selfBuffsEl = document.createElement('div');
  selfBuffsEl.id = 'aohud-self-buffs';

  const playerAlertEl = document.createElement('div');
  playerAlertEl.id = 'aohud-player-alert';


  const fctEl = document.createElement('div');
  fctEl.id = 'aohud-fct';

  const toastsEl = document.createElement('div');
  toastsEl.id = 'aohud-toasts';

  let fctSlot = 0;
  function showFCT(text, kind = 'dealt') {
    const canvas = findGameCanvas();
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = `aohud-fct-num ${kind}`;
    el.textContent = text;
    const spread = 80;
    const xOffset = (Math.random() - 0.5) * spread;
    const slot = fctSlot++ % 4;
    // Render well above center so we don't sit on top of the game's native damage numbers
    el.style.left = (r.width / 2 + xOffset - 25) + 'px';
    el.style.top = (r.height / 2 - 90 - slot * 26) + 'px';
    fctEl.style.left = r.left + 'px';
    fctEl.style.top = r.top + 'px';
    fctEl.style.width = r.width + 'px';
    fctEl.style.height = r.height + 'px';
    fctEl.appendChild(el);
    setTimeout(() => el.remove(), 1300);
  }

  function showSpellFlash(spellName) {
    const icon = SPELL_ICONS[spellName];
    if (!icon) return;
    const canvas = findGameCanvas();
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const spriteURL = SPELL_SPRITES[spellName];
    const glowColors = {
      'Dardo Mágico': 'rgba(167,139,250,0.8)', 'Misil Mágico': 'rgba(167,139,250,0.8)',
      'Proyectil Mágico': 'rgba(167,139,250,0.8)',
      'Flecha Mágica': 'rgba(192,132,252,0.8)', 'Flecha Eléctrica': 'rgba(250,204,21,0.8)',
      'Tormenta de Fuego': 'rgba(251,146,60,0.9)', 'Infierno': 'rgba(239,68,68,0.9)',
      'Apocalipsis': 'rgba(239,68,68,0.9)', 'Explosión': 'rgba(251,146,60,0.9)',
      'Descarga Eléctrica': 'rgba(250,204,21,0.8)', 'Rayo': 'rgba(250,204,21,0.8)',
      'Toxina': 'rgba(74,222,128,0.8)', 'Ataque de Hambre': 'rgba(163,163,163,0.7)',
      'Llamado Nigromante': 'rgba(168,85,247,0.8)', 'Drenaje de Vida': 'rgba(239,68,68,0.7)',
      'Drenaje de Maná': 'rgba(96,165,250,0.7)',
      'Curar Heridas Graves': 'rgba(250,230,120,0.9)',
    };
    fctEl.style.left = r.left + 'px';
    fctEl.style.top = r.top + 'px';
    fctEl.style.width = r.width + 'px';
    fctEl.style.height = r.height + 'px';

    if (spriteURL) {
      const size = 96;
      const el = document.createElement('div');
      el.style.cssText = `position:absolute;width:${size}px;height:${size}px;`
        + `left:${r.width / 2 - size / 2}px;top:${r.height / 2 - size - 10}px;`
        + `background:url(${spriteURL}) 0 0 no-repeat;`
        + `background-size:${size * SPELL_SPRITE_FRAMES}px ${size}px;`
        + `pointer-events:none;image-rendering:auto;`;
      fctEl.appendChild(el);
      let frame = 0;
      const anim = setInterval(() => {
        frame++;
        if (frame >= SPELL_SPRITE_FRAMES) { clearInterval(anim); el.remove(); return; }
        el.style.backgroundPosition = `-${frame * size}px 0`;
      }, SPELL_SPRITE_FRAME_MS);
    } else {
      const glow = glowColors[spellName] || 'rgba(94,170,255,0.8)';
      const baseLeft = r.width / 2 - 14;
      const baseTop = r.height / 2 - 80;
      for (let i = 0; i < 3; i++) {
        const el = document.createElement('div');
        el.className = i % 2 === 1 ? 'aohud-spell-flash alt' : 'aohud-spell-flash';
        el.textContent = icon;
        el.style.setProperty('--spell-glow', glow);
        el.style.left = (baseLeft + (Math.random() - 0.5) * 16) + 'px';
        el.style.top = baseTop + 'px';
        el.style.animationDelay = (i * 0.18) + 's';
        fctEl.appendChild(el);
        setTimeout(() => el.remove(), 2100 + i * 200);
      }
    }
  }

  function showToast(title, detail, icon = '✦', kind = 'discovery') {
    const t = document.createElement('div');
    t.className = `aohud-toast ${kind}`;
    t.innerHTML = `<span class="t-ico">${icon}</span><div class="t-content"><span class="t-title">${escHtml(title)}</span><span class="t-detail">${escHtml(detail)}</span></div>`;
    toastsEl.appendChild(t);
    setTimeout(() => {
      t.classList.add('fade-out');
      setTimeout(() => t.remove(), 500);
    }, 4500);
  }

  // ===== Fullscreen relocation =====
  function relocateOverlays() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    const container = fsEl || document.body;
    [panel, selfBuffsEl, playerAlertEl, fctEl, toastsEl].forEach(el => {
      if (el.parentElement !== container) container.appendChild(el);
    });
    scheduleReposition();
  }
  document.addEventListener('fullscreenchange', relocateOverlays);
  document.addEventListener('webkitfullscreenchange', relocateOverlays);

  // ===== Canvas y posicionamiento =====
  function findGameCanvas() {
    if (gameCanvas && document.body.contains(gameCanvas)) return gameCanvas;
    const canvases = document.querySelectorAll('canvas');
    let largest = null, maxArea = 0;
    for (const c of canvases) {
      const r = c.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > maxArea && area > 10000) { maxArea = area; largest = c; }
    }
    gameCanvas = largest;
    return largest;
  }

  function updateOverlayPositions() {
    const canvas = findGameCanvas();
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const centerX = r.left + r.width / 2;
    const centerY = r.top + r.height / 2;
    selfBuffsEl.style.left = (r.left + 8) + 'px';
    selfBuffsEl.style.top = (r.top + 80) + 'px';
    playerAlertEl.style.left = centerX + 'px';
    playerAlertEl.style.top = (centerY - 50) + 'px';
  }

  function readPlayerXP() {
    document.querySelectorAll('div, span, p').forEach(el => {
      if (el.id && el.id.startsWith('aohud-')) return;
      if (el.children.length === 0) {
        const m = el.textContent.trim().match(/(\d[\d.]*)\s*\/\s*(\d[\d.]*)\s*\)/);
        if (m) {
          const curr = parseInt(m[1].replace(/\./g, ''));
          const needed = parseInt(m[2].replace(/\./g, ''));
          if (needed > 10000 && curr <= needed) {
            playerXPCurrent = curr;
            playerXPNeeded = needed;
          }
        }
      }
    });
  }

  // NOTE (v1.8.2): on current aoweb build, VIDA/MANA are rendered into canvas,
  // not DOM. So this reader almost always finds nothing and sets values to null.
  // Auto-curar / auto-meditar respect that and won't fire blindly.
  // Inventory counters like "3/5" (shield) and "4/9" (arrows) DO appear in DOM —
  // we filter them out by requiring max > 100 (HP/MP are always 3 digits+).
  function readPlayerHP() {
    const hpMpPairs = [];
    document.querySelectorAll('span').forEach(el => {
      if (el.id && el.id.startsWith('aohud-')) return;
      if (el.closest('#aohud-panel')) return;
      const m = el.textContent.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
      if (m) {
        const curr = +m[1], max = +m[2];
        // Inventory slot counters (shield 3/5, arrows 4/9, etc.) are always small.
        // Real HP/MP at any meaningful level are 100+.
        if (max >= 100 && max < 100000) hpMpPairs.push({ curr, max });
      }
    });
    if (hpMpPairs.length >= 2) {
      playerHP = hpMpPairs[0].curr; playerMaxHP = hpMpPairs[0].max;
      playerMP = hpMpPairs[1].curr; playerMaxMP = hpMpPairs[1].max;
    } else if (hpMpPairs.length === 1) {
      playerHP = hpMpPairs[0].curr; playerMaxHP = hpMpPairs[0].max;
      playerMP = null; playerMaxMP = null;
    } else {
      // Nothing detected — canvas-rendered. Clear so auto-cast knows not to trust.
      playerHP = null; playerMaxHP = null;
      playerMP = null; playerMaxMP = null;
    }
    if (playerMaxHP > 0 && playerHP > 0 && playerHP / playerMaxHP <= LOW_HP_THRESHOLD) {
      playLowHPAlert();
      if (!playerAlertEl.querySelector('.hp-alert')) {
        playerAlertEl.insertAdjacentHTML('afterbegin',
          `<div class="alert-text hp-alert">HP BAJO: ${playerHP}/${playerMaxHP}</div>`);
      }
    } else {
      const hpAlert = playerAlertEl.querySelector('.hp-alert');
      if (hpAlert) hpAlert.remove();
    }
  }

  function readGameBuffTimers() {
    const timers = [];
    document.querySelectorAll('div, span, p').forEach(el => {
      if (el.id && el.id.startsWith('aohud-')) return;
      if (el.children.length === 0) {
        const t = el.textContent.trim();
        const m = t.match(/\((\d+)s\)/);
        if (m) timers.push(+m[1]);
      }
    });

    if (timers.length > 0) {
      const buffsArray = [...activeBuffs.entries()].sort((a, b) => b[1].castAt - a[1].castAt);
      for (let i = 0; i < buffsArray.length; i++) {
        if (i < timers.length) buffsArray[i][1].realRemain = timers[i];
        else delete buffsArray[i][1].realRemain;
      }
    } else if (activeBuffs.size > 0) {
      const hadTimers = [...activeBuffs.values()].some(b => b.realRemain !== undefined);
      if (hadTimers) {
        for (const [name] of activeBuffs) activeBuffs.delete(name);
        console.log('[AOWeb HUD] Buffs cleared: DOM timers disappeared');
      }
    }
    renderSelfBuffs();
    renderPlayerFrame();
  }

  function scheduleReposition() {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => { updateOverlayPositions(); resizeRaf = null; });
  }

  // ===== Renderers =====
  function fmtTime(s) {
    s = Math.max(0, Math.round(s));
    const m = Math.floor(s / 60), r = s % 60;
    return `${m}:${String(r).padStart(2,'0')}`;
  }
  function escHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  function renderPlayerFrame() {
    if (playerName) {
      document.getElementById('player-name').textContent = playerName;
      // avatar text only if no head sprite loaded
      const avEl = document.getElementById('player-avatar');
      if (!avEl.style.backgroundImage) avEl.textContent = playerName[0].toUpperCase();
    }
    if (playerClass) {
      const lvlStr = playerLevel ? ` · Nv ${playerLevel}` : '';
      document.getElementById('player-class').textContent = playerClass + lvlStr;
    }
    document.getElementById('ss-kills').textContent = session.kills;
    const elapsedHours = (Date.now() - session.startedAt) / 3600000;
    const xpPerHour = elapsedHours > 0.005 ? Math.round(session.totalXP / elapsedHours) : 0;
    document.getElementById('ss-xph').textContent = formatK(xpPerHour);
    document.getElementById('ss-gold').textContent = formatK(session.totalGold);
    const dps = getDPS();
    document.getElementById('ss-dmg').textContent = dps > 0 ? `${dps}/s` : '-';
  }

  function formatK(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function renderSelfBuffs() {
    const now = Date.now();
    let html = '';

    if (activeBuffs.size > 0) {
      html += [...activeBuffs.entries()].map(([name, b]) => {
        const remain = b.realRemain !== undefined
          ? b.realRemain
          : Math.max(0, b.duration - (now - b.castAt) / 1000);
        const expiring = remain < 10 ? 'expiring' : '';
        const ico = SPELL_ICONS[name] || '◆';
        const timeTxt = remain > 0 ? `${Math.round(remain)}s` : '...';
        return `<div class="buff ${expiring}" title="${escHtml(name)} (${fmtTime(Math.max(0, remain))})">
          <div class="ico">${ico}</div>
          <div class="time">${timeTxt}</div>
        </div>`;
      }).join('');
    }

    const ccMobs = [...entities.values()]
      .filter(e => e.kind === 'npc' && !e.dead && e.stateTimers && e.stateTimers.size > 0)
      .flatMap(e => [...e.stateTimers.entries()]
        .filter(([s]) => s === 'Paralizado' || s === 'Inmovilizado')
        .map(([state, castAt]) => {
          const dur = getStateDuration(state);
          const remain = dur ? Math.max(0, dur - (now - castAt) / 1000) : null;
          return { name: e.name, state, remain };
        })
      )
      .sort((a, b) => (a.remain ?? Infinity) - (b.remain ?? Infinity));

    if (ccMobs.length > 0) {
      if (activeBuffs.size > 0) html += '<div class="cc-divider"></div>';
      html += ccMobs.map(m => {
        const urgent = m.remain !== null && m.remain < 5 ? 'expiring' : '';
        const ico = getStateIcon(m.state);
        const timeTxt = m.remain !== null ? `${Math.round(m.remain)}s` : '?';
        return `<div class="buff cc-mob ${urgent}" title="${escHtml(m.name)} — ${m.state}">
          <div class="ico">${getMobEmoji(m.name)}</div>
          <div class="time">${ico}${timeTxt}</div>
        </div>`;
      }).join('');
    }

    if (!html) { selfBuffsEl.innerHTML = ''; return; }
    selfBuffsEl.innerHTML = html;
  }


  function renderManual() {
    const body = document.getElementById('manual-body');
    if (!body) return;

    let targetHTML = '';
    if (currentTarget) {
      const emoji = getMobEmoji(currentTarget.name);
      const pct = currentTarget.maxHp > 0 ? Math.max(0, Math.min(100, (currentTarget.hp / currentTarget.maxHp) * 100)) : 0;
      const stats = learnedMobStats[currentTarget.name] || mobStats.get(currentTarget.name);
      const dbInfo = BESTIARY_DB[currentTarget.name];
      let dmgInfo = '';
      if (stats && stats.hitsReceived && stats.hitsReceived.length > 0) {
        const avg = Math.round(stats.hitsReceived.reduce((a,b)=>a+b,0) / stats.hitsReceived.length);
        const max = Math.max(...stats.hitsReceived);
        dmgInfo = `pega ~<b style="color:#f4d97a">${avg}</b> · máx <b style="color:#e24b4a">${max}</b>`;
      } else if (dbInfo) {
        dmgInfo = `HP ${dbInfo.hp} · ${dbInfo.exp} XP`;
      } else {
        dmgInfo = '<span style="color:#5a5a4a;font-style:italic">sin datos de daño aún</span>';
      }
      const dbSubLine = dbInfo ? `<div style="font-size:11px;color:#6a6a5a;font-style:italic;margin-top:2px">${dbInfo.drops && dbInfo.drops.length ? dbInfo.drops[0] : ''}${dbInfo.maps && dbInfo.maps.length ? ' · mapa ' + dbInfo.maps[0] : ''}</div>` : '';
      let statesHTML = '';
      let lockedInstance = null;
      if (currentTarget.ccInstanceId) {
        lockedInstance = myCCInstances.find(c => c.id === currentTarget.ccInstanceId);
        // si la instancia ya expiró (>5s después), limpiar el lock para fallback por nombre
        if (lockedInstance && (Date.now() - lockedInstance.castAt) / 1000 > lockedInstance.duration + 5) {
          currentTarget.ccInstanceId = null;
          lockedInstance = null;
        }
      }
      if (lockedInstance) {
        // v1.11: target lockeado a una instancia CC específica — mostrar solo SU timer
        const now2 = Date.now();
        const remain = Math.max(0, lockedInstance.duration - (now2 - lockedInstance.castAt) / 1000);
        const ico = getStateIcon(lockedInstance.state);
        const timeTxt = fmtTime(remain);
        const urgentClass = remain < 5 ? 'urgent' : '';
        statesHTML = `<div class="states-container">
          <div class="states-label">Estado lockeado · #${lockedInstance.displayIndex || 1}</div>
          <div class="state-item ${urgentClass}"><span>${ico}</span><span>${escHtml(lockedInstance.state)}</span><span class="state-time">${timeTxt}</span></div>
        </div>`;
      } else {
        const targetEnt = entities.get(currentTarget.name);
        if (targetEnt?.stateTimers && targetEnt.stateTimers.size > 0) {
          const now2 = Date.now();
          const stateItems = [...targetEnt.stateTimers.entries()].map(([state, castAt]) => {
            const dur = getStateDuration(state);
            const remain = dur ? Math.max(0, dur - (now2 - castAt) / 1000) : null;
            const ico = getStateIcon(state);
            const timeTxt = remain !== null ? fmtTime(remain) : '?';
            const urgentClass = remain !== null && remain < 5 ? 'urgent' : '';
            const unknownClass = remain === null ? 'unknown-dur' : '';
            return `<div class="state-item ${urgentClass} ${unknownClass}"><span>${ico}</span><span>${escHtml(state)}</span><span class="state-time">${timeTxt}</span></div>`;
          }).join('');
          statesHTML = `<div class="states-container"><div class="states-label">Estados</div>${stateItems}</div>`;
        }
      }
      const lockBadge = lockedInstance ? `<span class="cc-badge" style="margin-left:6px;background:#f4d97a">${lockedInstance.displayIndex || 1}</span>` : '';
      targetHTML = `<div id="aohud-target-card">
        <div class="row">
          <div class="ava">${emoji}</div>
          <div class="info">
            <div class="tname">${escHtml(currentTarget.name)}${lockBadge}</div>
            <div class="sub">${dmgInfo}</div>
            ${dbSubLine}
          </div>
        </div>
        <div class="hpbar">
          <div class="fill" style="width:${pct}%"></div>
          <div class="txt">${currentTarget.hp} / ${currentTarget.maxHp}</div>
        </div>
        ${statesHTML}
      </div>`;
    }

    let activeHTML = '';
    const now = Date.now();
    // Per-instance CC tracking: each cast has its own timer. Multi-target safe.
    // Filter out expired (with 5s grace beyond duration).
    const activeCCs = myCCInstances
      .map(c => ({ ...c, remain: c.duration - (now - c.castAt) / 1000 }))
      .filter(c => c.remain > -5)
      .sort((a, b) => a.remain - b.remain);

    if (activeCCs.length > 0) {
      // v1.11: cuántas instancias activas de cada nombre (para decidir si mostrar número)
      const totalByName = {};
      for (const c of activeCCs) totalByName[c.name] = (totalByName[c.name] || 0) + 1;

      activeHTML = `<div class="active-section">
        <div class="as-title">Estados activos (${activeCCs.length})</div>
        ${activeCCs.map(c => {
          const isLocked = currentTarget && currentTarget.ccInstanceId === c.id ? 'is-locked' : '';
          const isTargetByName = !isLocked && currentTarget && currentTarget.name === c.name && !currentTarget.ccInstanceId ? 'is-target' : '';
          const urgent = c.remain < 5 ? 'urgent' : '';
          const ico = getStateIcon(c.state);
          const time = c.remain > 0 ? fmtTime(c.remain) : '<span style="color:#a01818">EXP</span>';
          // Color rotando por displayIndex (estable durante la vida de la instancia)
          const colorIdx = ((c.displayIndex || 1) - 1) % CC_COLORS.length;
          // Badge con número visible solo cuando hay 2+ del mismo nombre
          const badge = totalByName[c.name] > 1 ? `<span class="cc-badge">${c.displayIndex || 1}</span>` : '';
          return `<div class="am-item cc-c${colorIdx} ${urgent} ${isLocked} ${isTargetByName}" data-cc-id="${c.id}" data-name="${escHtml(c.name)}">
            <span class="am-emoji">${getMobEmoji(c.name)}</span>
            <span class="am-name">${badge}${escHtml(c.name)}</span>
            <span class="am-hp"></span>
            <span class="am-dismiss" data-dismiss-cc="${c.id}" title="Descartar este CC">✕</span>
            <div class="am-states"><span style="white-space:nowrap">${ico}${time}</span></div>
          </div>`;
        }).join('')}
      </div>`;
    }

    let content = '';
    if (currentTab === 'manual') {
      const filter = bestiaryFilter.toLowerCase();
      const hasAnyFilter = filter.length >= 2 || filterHpRange || filterMap;

      let hpMin = 0, hpMax = Infinity;
      if (filterHpRange) {
        const [lo, hi] = filterHpRange.split('-').map(Number);
        hpMin = lo; hpMax = hi;
      }
      const mapNum = filterMap ? parseInt(filterMap) : 0;

      function matchesFilters(name, db) {
        if (filter && !name.toLowerCase().includes(filter)) return false;
        if (!db) return !filterHpRange && !mapNum;
        if (filterHpRange && (db.hp < hpMin || db.hp > hpMax)) return false;
        if (mapNum && db.maps && !db.maps.includes(mapNum)) return false;
        return true;
      }

      const learned = Object.entries(learnedMobStats)
        .filter(([_, s]) => s.hitsReceived && s.hitsReceived.length > 0)
        .map(([name, s]) => {
          const avg = Math.round(s.hitsReceived.reduce((a,b)=>a+b,0) / s.hitsReceived.length);
          const max = Math.max(...s.hitsReceived);
          const samples = s.hitsReceived.length;
          const kills = session.killsByMob[name] || 0;
          const db = BESTIARY_DB[name];
          return { name, avg, max, samples, kills, db };
        })
        .filter(m => matchesFilters(m.name, m.db))
        .sort((a, b) => (b.kills - a.kills) || (b.samples - a.samples));

      const learnedNames = new Set(learned.map(m => m.name));

      let sections = '';
      if (hasAnyFilter) {
        const dbOnly = Object.entries(BESTIARY_DB)
          .filter(([name, d]) => !learnedNames.has(name) && matchesFilters(name, d))
          .map(([name, d]) => ({ name, ...d }))
          .sort((a, b) => a.exp - b.exp);

        if (dbOnly.length > 0) {
          sections += `<div class="section-head">Wiki (${dbOnly.length})</div>`;
          sections += dbOnly.map(m => {
            const dropsLine = m.drops && m.drops.length ? m.drops.slice(0, 2).join(' · ') : '';
            const mapsLine = m.maps && m.maps.length ? 'mapas: ' + m.maps.slice(0, 4).join(', ') + (m.maps.length > 4 ? '...' : '') : '';
            return `<div class="mob-entry db-only" data-name="${escHtml(m.name)}">
            <span class="e-ico">${getMobEmoji(m.name)}</span>
            <div class="e-info">
              <div class="e-name">${escHtml(m.name)}</div>
              <div class="e-stats">HP ${formatK(m.hp)} · ${formatK(m.exp)} XP${m.gold ? ' · ' + formatK(m.gold) + ' oro' : ''}</div>
              <div class="e-sub">${dropsLine || mapsLine}</div>
            </div>
          </div>`;
          }).join('');
        }
      }

      if (!sections && !hasAnyFilter) {
        content = `<div class="empty">Buscá criaturas o usá los filtros de arriba.</div>`;
      } else if (!sections) {
        content = '<div class="empty">Ninguna criatura coincide con los filtros.</div>';
      } else {
        content = sections;
      }
    } else if (currentTab === 'macros') {
      const renderToggle = (id, on, name, sub, ico, modClass = '', disabled = false) => `
        <button class="m-btn ${modClass} ${on ? 'on' : ''}" id="${id}" type="button"${disabled ? ' disabled' : ''}>
          <span class="m-ico">${ico}</span>
          <div class="m-info">
            <span class="m-name">${on ? 'PARAR ' + name : name}</span>
            <span class="m-key">${sub}</span>
          </div>
        </button>`;

      const renderThreshRow = (lbl, values, currentVal, dataAttr) => `
        <div class="m-speed-row">
          <span class="m-speed-lbl">${lbl}</span>
          ${values.map(v => `<button class="m-thresh-btn ${Math.abs(currentVal - v) < 0.001 ? 'active' : ''}" data-${dataAttr}="${v}" type="button">${Math.round(v * 100)}%</button>`).join('')}
        </div>`;

      let html = '';

      // === COMBATE: auto-attack ===
      html += '<div class="m-title">Combate</div>';
      html += renderToggle('ahm-aa-btn', autoAttackEnabled, 'AUTO-ATAQUE', `SPACE · cada ${autoAttackDelayMs}ms`, '⚔', 'm-aa');

      // Slider continuo para velocidad de auto-ataque (v1.11: min ahora 0)
      html += `<div class="m-slider-row">
        <span class="m-slider-lbl">Velocidad</span>
        <input type="range" class="m-slider" id="ahm-aa-slider"
          min="0" max="2000" step="50" value="${autoAttackDelayMs}" />
        <span class="m-slider-val" id="ahm-aa-slider-val">${autoAttackDelayMs}ms</span>
      </div>`;

      // v1.11: presets rápidos
      const PRESETS = [0, 100, 200, 400, 800, 1200];
      html += `<div class="m-preset-row">
        ${PRESETS.map(p => `<button class="m-preset-btn ${p === autoAttackDelayMs ? 'active' : ''}" data-preset-ms="${p}" type="button">${p}</button>`).join('')}
      </div>`;

      // Medición del arma (info + atajo "Usar")
      if (measuredAttackIntervalMs) {
        const safeMs = measuredAttackIntervalMs + 30;
        html += `<div class="m-measure-row">
          <span class="m-measure-lbl">Medido: <b>${measuredAttackIntervalMs}ms</b> (${attackIntervalSamples.length} golpes)</span>
          <button class="m-use-measured" data-ms="${safeMs}" type="button">Usar ${safeMs}ms</button>
          <button class="m-reset-measured" type="button" title="Resetear medición">↻</button>
        </div>`;
      } else {
        html += `<div class="m-hint" style="margin:2px 0 8px">Pegale a algo 3-4 veces seguidas y voy a medir tu cadencia real del arma.</div>`;
      }

      // v1.11: Auto-renovar Celeridad (piloto)
      html += '<div class="m-title">Buffs</div>';
      html += renderToggle('ahm-renew-btn', autoRenewCeleridadEnabled, 'AUTO-RENOVAR CELERIDAD', `Tecla 1 + click centro · <${AUTO_RENEW_THRESHOLD_S}s`, '🌀', 'm-renew');
      html += `<div class="m-hint" style="margin:2px 0 8px">Piloto: cuando Celeridad esté por expirar, simula tecla 1 + click sobre tu PJ (centro canvas).</div>`;

      content = html;
    } else if (currentTab === 'stats') {
      const elapsedMs = Date.now() - session.startedAt;
      const elapsedHours = elapsedMs / 3600000;
      const xpPerHour = elapsedHours > 0.005 ? Math.round(session.totalXP / elapsedHours) : 0;
      const goldPerHour = elapsedHours > 0.005 ? Math.round(session.totalGold / elapsedHours) : 0;
      const sessTimeMin = Math.floor(elapsedMs / 60000);
      const sessTimeStr = sessTimeMin >= 60
        ? `${Math.floor(sessTimeMin/60)}h ${sessTimeMin%60}m`
        : `${sessTimeMin}m`;
      const topMob = Object.entries(session.killsByMob).sort((a,b) => b[1] - a[1])[0];
      const avgHit = session.playerHits.length > 0
        ? Math.round(session.playerHits.reduce((a,b)=>a+b,0)/session.playerHits.length) : 0;
      const maxHit = session.playerHits.length > 0 ? Math.max(...session.playerHits) : 0;
      const manaPerMed = session.meditations > 0 ? Math.round(session.manaRecovered / session.meditations) : 0;

      const mapInfo = currentMapName || (currentMapNum ? `Mapa ${currentMapNum}` : '');
      const mapWiki = currentMapNum && MAPS_DB[currentMapNum];
      const learned = Object.entries(learnedMobStats)
        .filter(([_, s]) => s.hitsReceived && s.hitsReceived.length > 0)
        .map(([name, s]) => {
          const avg = Math.round(s.hitsReceived.reduce((a,b)=>a+b,0) / s.hitsReceived.length);
          const max = Math.max(...s.hitsReceived);
          const kills = session.killsByMob[name] || 0;
          return { name, avg, max, kills };
        })
        .sort((a, b) => (b.kills - a.kills) || a.name.localeCompare(b.name));

      content = `
        ${mapInfo ? `<div class="stat-row" style="border-bottom:1px solid rgba(106,74,24,0.5);padding-bottom:6px;margin-bottom:4px"><span class="label">Mapa</span><span class="val" style="font-family:'Cinzel',serif;font-size:11px">${escHtml(mapInfo)}</span></div>` : ''}
        ${mapWiki && mapWiki.level ? `<div class="stat-row"><span class="label">Nivel recomendado</span><span class="val">${mapWiki.level}</span></div>` : ''}
        <div class="section-head" style="padding-top:4px">Combate</div>
        <div class="stat-row"><span class="label">Tiempo jugado</span><span class="val">${sessTimeStr}</span></div>
        <div class="stat-row"><span class="label">Criaturas matadas</span><span class="val">${session.kills}</span></div>
        <div class="stat-row"><span class="label">Daño infligido</span><span class="val">${formatK(session.damageDealt)}</span></div>
        <div class="stat-row"><span class="label">Daño recibido</span><span class="val">${formatK(session.damageReceived)}</span></div>
        <div class="stat-row"><span class="label">DPS (30s)</span><span class="val">${getDPS() || '—'}</span></div>
        ${avgHit > 0 ? `<div class="stat-row"><span class="label">Tu golpe (avg/máx)</span><span class="val">~${avgHit} / ${maxHit}</span></div>` : ''}
        ${topMob ? `<div class="stat-row"><span class="label">Más cazado</span><span class="val">${escHtml(topMob[0])} ×${topMob[1]}</span></div>` : ''}

        <div class="section-head">Recursos</div>
        <div class="stat-row"><span class="label">Experiencia total</span><span class="val">${formatK(session.totalXP)}</span></div>
        <div class="stat-row"><span class="label">XP por hora</span><span class="val">${formatK(xpPerHour)}</span></div>
        <div class="stat-row"><span class="label">Oro ganado</span><span class="val">${formatK(session.totalGold)}</span></div>
        <div class="stat-row"><span class="label">Oro por hora</span><span class="val">${formatK(goldPerHour)}</span></div>
        ${session.manaRecovered > 0 ? `<div class="stat-row"><span class="label">Maná recuperado</span><span class="val">${formatK(session.manaRecovered)}</span></div>` : ''}
        ${session.meditations > 0 ? `<div class="stat-row"><span class="label">Meditaciones</span><span class="val">${session.meditations}${manaPerMed > 0 ? ` (~${manaPerMed}/med)` : ''}</span></div>` : ''}
        ${(session.healed || 0) > 0 ? `<div class="stat-row"><span class="label">HP curado</span><span class="val">${formatK(session.healed)}</span></div>` : ''}
        ${playerHP > 0 ? `<div class="stat-row"><span class="label">HP actual</span><span class="val" style="color:${playerHP/playerMaxHP<=0.3?'#e24b4a':'#6dd58a'}">${playerHP}/${playerMaxHP}</span></div>` : ''}
        ${playerMP > 0 ? `<div class="stat-row"><span class="label">Maná actual</span><span class="val" style="color:#5a8ac0">${playerMP}/${playerMaxMP}</span></div>` : ''}

        ${playerXPNeeded > 0 ? (() => {
          const xpRemaining = playerXPNeeded - playerXPCurrent;
          const pct = Math.round(playerXPCurrent / playerXPNeeded * 100);
          let etaStr = '—';
          if (xpPerHour > 0 && xpRemaining > 0) {
            const etaMin = Math.round(xpRemaining / xpPerHour * 60);
            etaStr = etaMin >= 60 ? `${Math.floor(etaMin/60)}h ${etaMin%60}m` : `${etaMin}m`;
          }
          return `
            <div class="section-head">Progresión</div>
            <div class="stat-row"><span class="label">XP al nivel ${(playerLevel||0)+1}</span><span class="val">${formatK(xpRemaining)}</span></div>
            <div class="stat-row"><span class="label">Progreso</span><span class="val">${pct}%</span></div>
            <div class="stat-row"><span class="label">Tiempo estimado</span><span class="val" style="color:${etaStr === '—' ? '#8a7a5a' : '#6dd58a'}">${etaStr}</span></div>
          `;
        })() : ''}

        ${learned.length > 0 ? `
          <div class="section-head">Combatidos (${learned.length})</div>
          ${learned.map(m =>
            `<div class="stat-row"><span class="label">${getMobEmoji(m.name)} ${escHtml(m.name)}${m.kills ? ' ×' + m.kills : ''}</span><span class="val">~${m.avg} / ${m.max}</span></div>`
          ).join('')}
        ` : ''}

        ${session.drops.length > 0 ? `
          <div class="section-head">Drops (${session.drops.length})</div>
          ${session.drops.slice(-8).reverse().map(d =>
            `<div class="stat-row"><span class="label">${escHtml(d.item)}</span><span class="val" style="font-size:9px;color:#8a7a5a">${new Date(d.ts).toLocaleTimeString()}</span></div>`
          ).join('')}
        ` : ''}

        ${sessionHistory.length > 0 ? `
          <div class="section-head">Sesiones anteriores</div>
          ${sessionHistory.slice(-5).reverse().map(h => {
            const d = new Date(h.date);
            const dateStr = `${d.getDate()}/${d.getMonth()+1} ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
            const durMin = Math.round((h.duration || 0) / 60);
            const durStr = durMin >= 60 ? `${Math.floor(durMin/60)}h${durMin%60}m` : `${durMin}m`;
            return `<div class="stat-row"><span class="label" style="font-size:12px">${dateStr} · ${durStr}</span><span class="val" style="font-size:10px">${h.kills || 0}K · ${formatK(h.xp || 0)}XP · ${formatK(h.gold || 0)}g</span></div>`;
          }).join('')}
        ` : ''}
      `;
    }

    body.innerHTML = targetHTML + activeHTML + content;

    body.querySelectorAll('.am-dismiss').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const ccId = btn.getAttribute('data-dismiss-cc');
        if (ccId) {
          // Remove specific CC instance by id
          const idx = myCCInstances.findIndex(c => c.id === +ccId);
          if (idx !== -1) myCCInstances.splice(idx, 1);
        } else {
          // Legacy: clear all states for a mob (still useful from target card)
          const name = btn.getAttribute('data-dismiss');
          const ent = entities.get(name);
          if (ent) {
            if (ent.stateTimers) ent.stateTimers.clear();
            if (ent.states) ent.states.clear();
          }
          // Also clean instances matching that name
          for (let i = myCCInstances.length - 1; i >= 0; i--) {
            if (myCCInstances[i].name === name) myCCInstances.splice(i, 1);
          }
        }
        renderManual();
      });
    });
    body.querySelectorAll('.am-item, .mob-entry').forEach(el => {
      el.addEventListener('click', () => {
        // v1.11: si la card tiene data-cc-id, lockear a esa instancia específica
        const ccId = el.getAttribute('data-cc-id');
        const name = el.getAttribute('data-name');
        if (ccId) {
          setCurrentTargetByCC(+ccId);
        } else if (name) {
          setCurrentTarget(name);
        }
      });
    });
    // Macros tab handlers — blur after click so Space (auto-attack) doesn't re-trigger focused button
    const aaBtn = body.querySelector('#ahm-aa-btn');
    if (aaBtn) aaBtn.addEventListener('click', () => { setAutoAttack(!autoAttackEnabled); aaBtn.blur(); });
    body.querySelectorAll('.m-speed-btn').forEach(b => {
      b.addEventListener('click', () => {
        autoAttackDelayMs = +b.getAttribute('data-speed') || 800;
        try { localStorage.setItem('aoweb-hud-aaspeed', String(autoAttackDelayMs)); } catch(e) {}
        if (autoAttackEnabled) { setAutoAttack(false); setAutoAttack(true); }
        else renderManual();
        b.blur();
      });
    });
    const useMeasured = body.querySelector('.m-use-measured');
    if (useMeasured) {
      useMeasured.addEventListener('click', () => {
        const ms = +useMeasured.getAttribute('data-ms');
        if (ms >= 300 && ms <= 3000) {
          autoAttackDelayMs = ms;
          try { localStorage.setItem('aoweb-hud-aaspeed', String(ms)); } catch(e) {}
          if (autoAttackEnabled) { setAutoAttack(false); setAutoAttack(true); }
          else renderManual();
          showToast('Velocidad ajustada', `Auto-ataque a ${ms}ms (medido del arma)`, '⚙', 'learned');
        }
        useMeasured.blur();
      });
    }
    const resetMeasured = body.querySelector('.m-reset-measured');
    if (resetMeasured) {
      resetMeasured.addEventListener('click', () => {
        attackIntervalSamples.length = 0;
        measuredAttackIntervalMs = null;
        lastMeleeHitAt = 0;
        renderManual();
        resetMeasured.blur();
      });
    }
    // Slider de velocidad auto-ataque
    const slider = body.querySelector('#ahm-aa-slider');
    const sliderVal = body.querySelector('#ahm-aa-slider-val');
    if (slider) {
      slider.addEventListener('input', () => {
        autoAttackDelayMs = +slider.value;
        if (sliderVal) sliderVal.textContent = autoAttackDelayMs + 'ms';
      });
      slider.addEventListener('change', () => {
        try { localStorage.setItem('aoweb-hud-aaspeed', String(autoAttackDelayMs)); } catch(e) {}
        if (autoAttackEnabled) { setAutoAttack(false); setAutoAttack(true); }
        else { renderManual(); refreshStickyAA(); }
        slider.blur();
      });
    }
    // v1.11: presets de velocidad
    body.querySelectorAll('.m-preset-btn').forEach(b => {
      b.addEventListener('click', () => {
        const ms = +b.getAttribute('data-preset-ms');
        if (isNaN(ms) || ms < 0 || ms > 2000) return;
        autoAttackDelayMs = ms;
        try { localStorage.setItem('aoweb-hud-aaspeed', String(ms)); } catch(e) {}
        if (autoAttackEnabled) { setAutoAttack(false); setAutoAttack(true); }
        else { renderManual(); refreshStickyAA(); }
        b.blur();
      });
    });
    // v1.11: toggle de auto-renovar Celeridad
    const renewBtn = body.querySelector('#ahm-renew-btn');
    if (renewBtn) renewBtn.addEventListener('click', () => {
      setAutoRenewCeleridad(!autoRenewCeleridadEnabled);
      renewBtn.blur();
    });
  }

  function updateFooter() {
    const e = document.getElementById('stat-ws');
    if (e) e.textContent = `${wsTraffic.length} ws · ${consoleLog.length} msg`;
  }

  // ===== Sistema de estados =====
  function parseStates(suffix) {
    if (!suffix) return new Set();
    return new Set([...suffix.matchAll(/\[([^\]]+)\]/g)].map(m => m[1].trim()));
  }
  function diffStates(oldSet, newSet) {
    const added = new Set(), removed = new Set();
    for (const s of newSet) if (!oldSet.has(s)) added.add(s);
    for (const s of oldSet) if (!newSet.has(s)) removed.add(s);
    return { added, removed };
  }
  const STATE_ICONS = {
    'Paralizado': '⏱', 'Inmovilizado': '⏱',
    'Envenenado': '☣', 'Maldito': '✖',
    'Bendecido': '✚', 'Invisible': '◌',
    'Oculto': '◌', 'Quemado': '🔥', 'Congelado': '❄',
    'Meditando': '☾', 'Muerto': '✖',
    '_default': '✦',
  };
  function getStateIcon(name) {
    return STATE_ICONS[name] || STATE_ICONS._default;
  }
  function getStateDuration(state) {
    if (STATE_EST_DURATION[state]) return STATE_EST_DURATION[state];
    const ls = learnedStates[state];
    return ls?.knownDuration || null;
  }

  // ===== Parsers =====
  function parseEntity(text) {
    let m = text.match(NPC_RX);
    if (m) return {
      kind: 'npc', name: m[1].trim(), type: m[2],
      hp: +m[3], maxHp: +m[4],
      states: parseStates(m[5]),
    };
    m = text.match(PJ_RX);
    if (m) return {
      kind: 'pj', name: m[1].trim(), clan: m[2], clase: m[3].trim(),
      nivel: +m[4], faccion: m[5],
      states: parseStates(m[6] || ''),
    };
    return null;
  }

  function setCurrentTarget(name) {
    let ent = entities.get(name);
    if (!ent) {
      ent = { name, kind: 'npc', hp: 0, maxHp: 0, lastSeen: Date.now(), count: 1, states: new Set(), stateTimers: new Map() };
      entities.set(name, ent);
    }
    if (currentTarget?.name === name) {
      currentTarget.lastSeen = Date.now();
      // v1.11: switching to target by name clears any prior CC lock
      currentTarget.ccInstanceId = null;
    } else {
      currentTarget = { name: ent.name, kind: ent.kind, hp: ent.hp || 0, maxHp: ent.maxHp || 0, lastSeen: Date.now(), ccInstanceId: null };
    }
    renderManual();
    if (targetTimeoutId) clearTimeout(targetTimeoutId);
    targetTimeoutId = setTimeout(() => {
      if (Date.now() - lastCombatAt > COMBAT_RECENT_MS) { currentTarget = null; renderManual(); }
    }, TARGET_TIMEOUT_MS);
  }

  // v1.11: lock the target to a specific CC instance (Oso 1 vs Oso 2 con timers separados)
  function setCurrentTargetByCC(ccId) {
    const inst = myCCInstances.find(c => c.id === ccId);
    if (!inst) return;
    let ent = entities.get(inst.name);
    if (!ent) {
      ent = { name: inst.name, kind: 'npc', hp: 0, maxHp: 0, lastSeen: Date.now(), count: 1, states: new Set(), stateTimers: new Map() };
      entities.set(inst.name, ent);
    }
    currentTarget = {
      name: ent.name, kind: ent.kind, hp: ent.hp || 0, maxHp: ent.maxHp || 0,
      lastSeen: Date.now(), ccInstanceId: ccId,
    };
    renderManual();
    if (targetTimeoutId) clearTimeout(targetTimeoutId);
    targetTimeoutId = setTimeout(() => {
      if (Date.now() - lastCombatAt > COMBAT_RECENT_MS) { currentTarget = null; renderManual(); }
    }, TARGET_TIMEOUT_MS);
  }

  function handleEntityMsg(text) {
    const ent = parseEntity(text);
    if (!ent) return;
    if (playerName && ent.name === playerName) {
      if (ent.kind === 'pj' && ent.clase && ent.nivel) {
        playerClass = ent.clase; playerLevel = ent.nivel; renderPlayerFrame();
      }
      const oldSelfStates = window.__aohud_self_states || new Set();
      const newSelfStates = ent.states || new Set();
      processStateDiff(playerName, oldSelfStates, newSelfStates, true);
      window.__aohud_self_states = newSelfStates;
      return;
    }

    const existing = entities.get(ent.name);
    const oldStates = existing?.states || new Set();
    const newStates = ent.states || new Set();

    if (existing) {
      Object.assign(existing, ent, { lastSeen: Date.now(), count: existing.count + 1 });
      existing.states = newStates;
      if (!existing.stateTimers) existing.stateTimers = new Map();
    } else {
      entities.set(ent.name, {
        ...ent, lastSeen: Date.now(), count: 1,
        stateTimers: new Map(),
      });
    }

    processStateDiff(ent.name, oldStates, newStates, false);

    if (currentTarget && currentTarget.name === ent.name && ent.kind === 'npc') {
      currentTarget.hp = ent.hp; currentTarget.maxHp = ent.maxHp;
    }
    renderManual();
    updateFooter();
  }

  function processStateDiff(entityName, oldStates, newStates, isSelf) {
    const { added, removed } = diffStates(oldStates, newStates);
    const e = isSelf ? null : entities.get(entityName);
    let learnedSomething = false;

    for (const state of added) {
      const ts = Date.now();
      if (e) {
        if (!e.stateTimers) e.stateTimers = new Map();
        if (!e.stateTimers.has(state)) e.stateTimers.set(state, ts);
      }
      if (!learnedStates[state]) {
        learnedStates[state] = { firstSeenAt: ts, sightings: 1, knownDuration: null };
        learnedSomething = true;
        showToast(`Descubriste un estado nuevo`, `[${state}]`, getStateIcon(state), 'discovery');
      } else {
        learnedStates[state].sightings = (learnedStates[state].sightings || 0) + 1;
      }
      ensureBuffTicker();
    }

    if (isSelf && (added.has('Paralizado') || added.has('Inmovilizado'))) {
      const statusText = added.has('Paralizado') ? 'PARALIZADO' : 'INMOVILIZADO';
      playerAlertEl.innerHTML = `<div class="alert-text">${statusText}</div>`;
    }
    if (isSelf && (removed.has('Paralizado') || removed.has('Inmovilizado'))) {
      playerAlertEl.innerHTML = '';
    }

    for (const state of removed) {
      const castAt = e?.stateTimers?.get(state);
      if (castAt) {
        const duration = (Date.now() - castAt) / 1000;
        const rounded = Math.round(duration);
        console.log(`[AOWeb HUD] STATE ENDED: "${state}" on "${entityName}" lasted ${rounded}s`);
        if (!STATE_EST_DURATION[state]) {
          const maxPlausible = 120;
          if (duration > 3 && duration < maxPlausible) {
            const ls = learnedStates[state] || (learnedStates[state] = { sightings: 1, samples: [] });
            if (!ls.samples) ls.samples = [];
            ls.samples.push(rounded);
            if (ls.samples.length > 10) ls.samples.shift();
            if (ls.samples.length >= 3) {
              const sorted = [...ls.samples].sort((a, b) => a - b);
              const median = sorted[Math.floor(sorted.length / 2)];
              if (!ls.knownDuration || Math.abs(ls.knownDuration - median) > 3) {
                ls.knownDuration = median;
                learnedSomething = true;
                showToast(`Aprendido`, `[${state}] dura ~${median}s (${ls.samples.length} muestras)`, getStateIcon(state), 'learned');
              }
            }
          }
        }
        e.stateTimers.delete(state);
      }
    }

    if (learnedSomething || added.size > 0 || removed.size > 0) {
      try { localStorage.setItem('aoweb-hud-states', JSON.stringify(learnedStates)); } catch (e) {}
      renderManual();
    }
  }

  function handleCastMsg(text) {
    const m = text.match(CAST_RX);
    if (!m) return;
    const spell = m[1].trim();
    const target = m[2].trim();
    if (target === 'ti' || (playerName && target === playerName)) {
      showSpellFlash(spell);
      const isBuff = SPELL_DURATIONS[spell] || learnedDurations[spell];
      if (isBuff) {
        const duration = getDuration(spell);
        activeBuffs.set(spell, { castAt: Date.now(), duration, target: 'self', learned: !!learnedDurations[spell] });
        ensureBuffTicker();
      }
      renderSelfBuffs(); renderPlayerFrame();
    } else {
      setCurrentTarget(target);
      lastCombatAt = Date.now();
      lastOffensiveSpell = spell;
      lastOffensiveSpellAt = Date.now();
      showSpellFlash(spell);
      const stateName = SPELL_TO_STATE[spell];
      if (stateName) {
        // Per-instance: each cast creates its own timer for multi-target scenarios
        const duration = getStateDuration(stateName) || 50;
        // v1.11: displayIndex estable = 1 + cantidad de instancias vivas con mismo nombre
        const aliveSameName = myCCInstances.filter(c => c.name === target && (Date.now() - c.castAt) / 1000 < c.duration + 5);
        const usedIndexes = new Set(aliveSameName.map(c => c.displayIndex || 1));
        let displayIndex = 1;
        while (usedIndexes.has(displayIndex)) displayIndex++;
        const newId = myCCNextId++;
        myCCInstances.push({
          id: newId, name: target, state: stateName,
          castAt: Date.now(), duration, displayIndex,
        });
        if (myCCInstances.length > 30) myCCInstances.shift();

        // Also update the entity record (used by target card)
        const ent = entities.get(target);
        if (ent) {
          if (!ent.stateTimers) ent.stateTimers = new Map();
          ent.stateTimers.set(stateName, Date.now());
          if (!ent.states) ent.states = new Set();
          ent.states.add(stateName);
        }
        // v1.11: auto-lock al CC recién lanzado (el último cast siempre es el target activo)
        setCurrentTargetByCC(newId);
        ensureBuffTicker();
      }
    }
  }

  function handleBuffEnd(text) {
    const m = text.match(BUFF_END_RX);
    if (!m) return;
    let spell = m[1].trim().replace(/[.!]+$/, '');
    for (const [name, b] of activeBuffs) {
      if (spell.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(spell.toLowerCase())) {
        const actualDuration = (Date.now() - b.castAt) / 1000;
        if (Math.abs(actualDuration - b.duration) > 5) {
          learnedDurations[name] = Math.round(actualDuration);
          try { localStorage.setItem('aoweb-hud-durations', JSON.stringify(learnedDurations)); } catch(e) {}
        }
        activeBuffs.delete(name); renderSelfBuffs(); renderPlayerFrame();
        break;
      }
    }
  }

  function handleHitDone(text) {
    let m = text.match(HIT_DONE_RX);
    let target, damage;
    if (m) { target = m[1].trim(); damage = +m[2]; }
    else { m = text.match(LE_HAS_QUITADO_RX); if (m) { damage = +m[1]; target = m[2].trim(); } }
    if (!target) return;
    target = target.replace(/[.!]+$/, '');
    const mob = entities.get(target);
    if (mob && mob.kind === 'npc') { mob.hp = Math.max(0, mob.hp - damage); mob.lastSeen = Date.now(); }
    setCurrentTarget(target);
    if (currentTarget && currentTarget.name === target && mob) { currentTarget.hp = mob.hp; }
    session.damageDealt += damage;
    session.playerHits.push(damage);
    if (session.playerHits.length > 200) session.playerHits.shift();
    session.recentHits.push({ ts: Date.now(), dmg: damage });
    lastCombatAt = Date.now();
    const avgHit = session.playerHits.length > 5
      ? Math.round(session.playerHits.reduce((a,b)=>a+b,0)/session.playerHits.length) : 0;
    const isCrit = avgHit > 0 && damage >= avgHit * 1.5;
    const spellRecent = lastOffensiveSpell && (Date.now() - lastOffensiveSpellAt < 3000);
    const spellIcon = spellRecent ? (SPELL_ICONS[lastOffensiveSpell] || '') : '';
    if (spellRecent) { lastOffensiveSpell = null; lastOffensiveSpellAt = 0; }
    // Measure weapon attack interval from consecutive melee hits (not spells)
    if (!spellIcon) {
      const nowHit = Date.now();
      if (lastMeleeHitAt > 0) {
        const gap = nowHit - lastMeleeHitAt;
        if (gap >= 300 && gap <= 4000) {
          attackIntervalSamples.push(gap);
          if (attackIntervalSamples.length > ATTACK_SAMPLES_MAX) attackIntervalSamples.shift();
          measuredAttackIntervalMs = Math.min(...attackIntervalSamples);
        }
      }
      lastMeleeHitAt = nowHit;
    }
    const fctKind = spellIcon ? 'spell' : (isCrit ? 'crit' : 'dealt');
    showFCT(spellIcon ? `${spellIcon} -${damage}` : `-${damage}`, fctKind);
    renderManual();
  }

  function getDPS() {
    const now = Date.now();
    const window30s = 30000;
    session.recentHits = session.recentHits.filter(h => now - h.ts < window30s);
    if (session.recentHits.length < 2) return 0;
    const totalDmg = session.recentHits.reduce((s, h) => s + h.dmg, 0);
    const span = (now - session.recentHits[0].ts) / 1000;
    return span > 0 ? Math.round(totalDmg / span) : 0;
  }

  function handleHitRecv(text) {
    let m = text.match(HIT_RECV_RX);
    let attacker, damage;
    if (m) { attacker = m[1].trim(); damage = +m[2]; }
    else { m = text.match(HIT_RECV2_RX); if (m) { attacker = m[1].trim(); damage = +m[2]; } }
    if (!attacker) return;
    attacker = attacker.replace(/[.!]+$/, '');
    if (!mobStats.has(attacker)) mobStats.set(attacker, { hitsReceived: [] });
    mobStats.get(attacker).hitsReceived.push(damage);
    if (mobStats.get(attacker).hitsReceived.length > 50) mobStats.get(attacker).hitsReceived.shift();
    if (!learnedMobStats[attacker]) learnedMobStats[attacker] = { hitsReceived: [] };
    learnedMobStats[attacker].hitsReceived.push(damage);
    if (learnedMobStats[attacker].hitsReceived.length > 50) learnedMobStats[attacker].hitsReceived.shift();
    try { localStorage.setItem('aoweb-hud-mobs', JSON.stringify(learnedMobStats)); } catch(e) {}
    session.damageReceived += damage;
    showFCT(`+${damage}`, 'recv');
    if (currentTarget && currentTarget.name === attacker) renderManual();
    lastCombatAt = Date.now();
  }

  function handleXPGain(text) {
    const m = text.match(XP_GAIN_RX);
    if (!m) return;
    session.totalXP += +m[1];
    renderPlayerFrame();
  }

  function handleGoldGain(text) {
    const m = text.match(GOLD_GAIN_RX);
    if (!m) return;
    session.totalGold += +m[1];
    renderPlayerFrame();
  }

  function handleManaRecv(text) {
    const m = text.match(MANA_RECV_RX);
    if (!m) return;
    session.manaRecovered += +m[1];
  }

  function handleMeditateEnd() {
    session.meditations++;
  }

  function handleDrop(text) {
    const m = text.match(DROP_RX);
    if (!m) return;
    const item = m[1].trim();
    session.drops.push({ item, ts: Date.now() });
    if (session.drops.length > 200) session.drops.shift();
    showToast('Drop', item, '🎁', 'learned');
  }

  function handleLevelUp(text) {
    const m = text.match(LEVEL_UP_RX);
    if (!m) return;
    playerLevel = +m[1];
    renderPlayerFrame();
  }

  function handleHeal(text) {
    const m = text.match(HEAL_RX);
    if (!m) return;
    const amount = +m[1];
    session.healed = (session.healed || 0) + amount;
    showFCT(`✨ +${amount}`, 'heal');
  }

  function handleMapEnter(text) {
    let m = text.match(MAP_ENTER_RX);
    if (m) {
      currentMapName = m[1].trim();
      renderPlayerFrame();
      return;
    }
    m = text.match(MAP_NUM_RX);
    if (m) {
      currentMapNum = +m[1];
      const mapData = MAPS_DB[currentMapNum];
      if (mapData && !currentMapName) currentMapName = mapData.name || '';
    }
  }

  function handleKill(text) {
    const m = text.match(KILL_RX);
    if (!m) return;
    const name = m[1].trim().replace(/[.!]+$/, '');
    const ent = entities.get(name);
    if (ent) {
      ent.hp = 0; ent.dead = true;
      if (ent.stateTimers) ent.stateTimers.clear();
      if (ent.states) ent.states.clear();
    }
    session.kills++;
    session.killsByMob[name] = (session.killsByMob[name] || 0) + 1;
    if (currentTarget && currentTarget.name === name) {
      currentTarget.hp = 0; renderManual();
      setTimeout(() => { if (currentTarget?.name === name) { currentTarget = null; renderManual(); } }, 2000);
    }
    renderManual();
    renderPlayerFrame();
  }

  function ensureBuffTicker() {
    if (buffTickerId) return;
    buffTickerId = setInterval(() => {
      const now = Date.now();
      let buffAlertNeeded = false;
      for (const [name, b] of activeBuffs) {
        const elapsed = (now - b.castAt) / 1000;
        const remain = b.realRemain !== undefined ? b.realRemain : (b.duration - elapsed);
        if (elapsed > b.duration * 1.5 + 30) { activeBuffs.delete(name); buffAlertedSet.delete(name); continue; }
        if (remain > 0 && remain <= BUFF_ALERT_THRESHOLD) {
          buffAlertNeeded = true;
          if (!buffAlertedSet.has(name)) {
            buffAlertedSet.add(name);
            showToast('Buff expirando', `${name} — ${Math.round(remain)}s restantes`, SPELL_ICONS[name] || '◆', 'discovery');
          }
        } else if (remain > BUFF_ALERT_THRESHOLD) {
          buffAlertedSet.delete(name);
        }
        // v1.11: auto-renovar Celeridad cuando <5s
        if (autoRenewCeleridadEnabled && name === 'Celeridad' && remain > 0 && remain < AUTO_RENEW_THRESHOLD_S) {
          autoRenewCeleridad();
        }
      }
      if (buffAlertNeeded) playBuffAlert();

      let anyActiveState = false;
      let ccAlertNeeded = false;
      for (const e of entities.values()) {
        if (!e.stateTimers || e.dead) continue;
        for (const [state, castAt] of e.stateTimers) {
          const dur = getStateDuration(state);
          if (dur) {
            const elapsed = (now - castAt) / 1000;
            const remain = dur - elapsed;
            if (remain <= 0) {
              e.stateTimers.delete(state);
              if (e.states) e.states.delete(state);
            } else {
              anyActiveState = true;
              if (remain <= CC_ALERT_THRESHOLD
                  && (state === 'Paralizado' || state === 'Inmovilizado')) {
                ccAlertNeeded = true;
              }
            }
          } else {
            anyActiveState = true;
          }
        }
      }
      if (ccAlertNeeded) playCCAlert();

      for (const [name, e] of entities) {
        if (e.dead && (!e.stateTimers || e.stateTimers.size === 0)) entities.delete(name);
      }

      // Cleanup expired CC instances (10s grace beyond duration)
      for (let i = myCCInstances.length - 1; i >= 0; i--) {
        const c = myCCInstances[i];
        if ((now - c.castAt) / 1000 > c.duration + 10) myCCInstances.splice(i, 1);
      }
      const anyCCActive = myCCInstances.some(c => (now - c.castAt) / 1000 < c.duration);

      renderSelfBuffs();
      renderPlayerFrame();
      renderManual();
      if (activeBuffs.size === 0 && !anyActiveState && !anyCCActive) { clearInterval(buffTickerId); buffTickerId = null; }
    }, 500);
  }

  function recordMsg(text) {
    if (!text || text.length < 2) return;
    const cat = categorize(text);
    consoleLog.push({ ts: Date.now(), text, cat });
    if (consoleLog.length > MAX) consoleLog.shift();
    const cm = text.match(CONNECT_RX);
    if (cm && !playerName) { playerName = cm[1].trim(); renderPlayerFrame(); }
    if (text.startsWith('Ves a ')) handleEntityMsg(text);
    else if (/^(?:Has lanzado|Lanzaste)/.test(text)) { handleCastMsg(text); ensureBuffTicker(); }
    else if (/^(?:Has dejado de|Ya no estás afectado|El efecto de|Has perdido el efecto)/i.test(text)) handleBuffEnd(text);
    else if (/^(?:Le has pegado|Has impactado|Le has quitado)/.test(text)) handleHitDone(text);
    else if (/^Te ha (?:pegado|impactado|quitado)/.test(text) || /te ha quitado/i.test(text)) handleHitRecv(text);
    else if (/^Has matado/.test(text)) handleKill(text);
    else if (XP_GAIN_RX.test(text)) handleXPGain(text);
    else if (GOLD_GAIN_RX.test(text)) handleGoldGain(text);
    else if (MANA_RECV_RX.test(text)) handleManaRecv(text);
    else if (MEDITATE_END_RX.test(text)) handleMeditateEnd();
    else if (DROP_RX.test(text)) handleDrop(text);
    else if (LEVEL_UP_RX.test(text)) handleLevelUp(text);
    else if (HEAL_RX.test(text)) handleHeal(text);
    else if (MAP_ENTER_RX.test(text) || MAP_NUM_RX.test(text)) handleMapEnter(text);
    updateFooter();
  }

  function attachObserver(node) {
    if (observerActive) return;
    observerActive = true;
    if (globalObs) globalObs.disconnect();
    Array.from(node.querySelectorAll('*')).forEach(el => {
      if (el.children.length === 0 && el.textContent && el.textContent.trim()) recordMsg(el.textContent.trim());
    });
    const obs = new MutationObserver(muts => {
      for (const m of muts) for (const n of m.addedNodes) {
        const t = (n.textContent || '').trim(); if (t) recordMsg(t);
      }
    });
    obs.observe(node, { childList: true, subtree: true, characterData: true });
  }

  function exportAll() {
    const byCategory = {};
    consoleLog.forEach(m => { (byCategory[m.cat] ??= new Set()).add(m.text); });
    const out = {
      capturedAt: new Date().toISOString(), player: playerName, playerClass, playerLevel,
      wsTrafficCount: wsTraffic.length, consoleMessageCount: consoleLog.length,
      entitiesObserved: [...entities.values()].map(e => ({
        ...e,
        states: e.states ? [...e.states] : [],
        stateTimers: e.stateTimers ? Object.fromEntries(e.stateTimers) : {},
      })),
      activeBuffs: [...activeBuffs.entries()].map(([name, b]) => ({ spell: name, ...b })),
      learnedDurations, learnedMobStats, learnedStates,
      session: { ...session, elapsed: Math.round((Date.now() - session.startedAt) / 1000) },
      playerHP, playerMaxHP, playerMP, playerMaxMP,
      uniqueByCategory: Object.fromEntries(Object.entries(byCategory).map(([k, s]) => [k, [...s]])),
      consoleLog, wsTraffic,
    };
    console.log('%c[AOWeb HUD] === STATE DURATIONS ===', 'color:#f4d97a;font-weight:bold');
    for (const [state, data] of Object.entries(learnedStates)) {
      if (state === '_v') continue;
      console.log(`  ${state}: known=${data.knownDuration ?? '?'}s  samples=[${(data.samples||[]).join(', ')}]  sightings=${data.sightings||0}`);
    }
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `aoweb-hud-${Date.now()}.json`; a.click();
  }

  function saveSessionHistory() {
    const elapsed = (Date.now() - session.startedAt) / 1000;
    if (elapsed < 60 || session.kills === 0) return;
    const summary = {
      date: session.startedAt,
      duration: Math.round(elapsed),
      kills: session.kills,
      xp: session.totalXP,
      gold: session.totalGold,
      dmgDealt: session.damageDealt,
      dmgRecv: session.damageReceived,
      topMob: Object.entries(session.killsByMob).sort((a,b) => b[1] - a[1])[0]?.[0] || '',
      map: currentMapName,
      drops: session.drops.length,
    };
    sessionHistory.push(summary);
    if (sessionHistory.length > 20) sessionHistory = sessionHistory.slice(-20);
    try { localStorage.setItem('aoweb-hud-sessions', JSON.stringify(sessionHistory)); } catch (e) {}
  }

  function init() {
    document.body.appendChild(panel);
    document.body.appendChild(selfBuffsEl);
    document.body.appendChild(playerAlertEl);
    document.body.appendChild(fctEl);
    document.body.appendChild(toastsEl);

    // Tabs
    panel.querySelectorAll('.tab').forEach(t => {
      t.addEventListener('click', () => {
        panel.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        currentTab = t.getAttribute('data-tab');
        document.getElementById('aohud-search-wrap').style.display = currentTab === 'manual' ? '' : 'none';
        renderManual();
      });
    });

    // v1.11: Sticky auto-attack toggle (siempre visible)
    const stickyAA = document.getElementById('aohud-aa-sticky');
    stickyAA.addEventListener('click', (e) => {
      e.stopPropagation();
      setAutoAttack(!autoAttackEnabled);
    });
    refreshStickyAA();

    // v1.11: Double-tap Space → toggle auto-attack (capture phase, no preventDefault)
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' && e.keyCode !== 32) return;
      if (e.repeat) return;
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
      const now = Date.now();
      if (now - lastSpaceAt < DOUBLE_TAP_MS && now !== lastSpaceAt) {
        setAutoAttack(!autoAttackEnabled);
        lastSpaceAt = 0;
      } else {
        lastSpaceAt = now;
      }
    }, true);

    // Collapse toggle
    panel.querySelector('.player-header').addEventListener('click', (e) => {
      if (e.target.closest('.avatar-wrap')) return;
      panel.classList.toggle('collapsed');
    });
    // Head picker on avatar click
    panel.querySelector('.avatar-wrap').addEventListener('click', (e) => {
      e.stopPropagation();
      if (panel.classList.contains('collapsed')) { panel.classList.remove('collapsed'); return; }
      showHeadPicker();
    });

    // Draggable panel
    {
      let dragging = false, dragX = 0, dragY = 0, wasDragged = false;
      const header = panel.querySelector('.player-header');
      const savedPos = localStorage.getItem('aoweb-hud-panelpos');
      if (savedPos) {
        try {
          const p = JSON.parse(savedPos);
          panel.style.left = p.left + 'px'; panel.style.top = p.top + 'px';
        } catch(e) {}
      }
      header.addEventListener('mousedown', (e) => {
        if (e.target.closest('.avatar-wrap')) return;
        dragging = true; wasDragged = false;
        dragX = e.clientX - panel.offsetLeft;
        dragY = e.clientY - panel.offsetTop;
        e.preventDefault();
      });
      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        wasDragged = true;
        panel.style.left = (e.clientX - dragX) + 'px';
        panel.style.top = (e.clientY - dragY) + 'px';
      });
      document.addEventListener('mouseup', () => {
        if (dragging && wasDragged) {
          localStorage.setItem('aoweb-hud-panelpos', JSON.stringify({ left: panel.offsetLeft, top: panel.offsetTop }));
        }
        dragging = false;
      });
      header.style.cursor = 'grab';
      header.addEventListener('click', (e) => {
        if (wasDragged) { e.stopImmediatePropagation(); wasDragged = false; }
      }, true);
    }

    // Search & filters
    document.getElementById('aohud-search').addEventListener('input', (e) => {
      bestiaryFilter = e.target.value;
      renderManual();
    });
    document.getElementById('aohud-filter-hp').addEventListener('change', (e) => {
      filterHpRange = e.target.value;
      renderManual();
    });
    document.getElementById('aohud-filter-map').addEventListener('input', (e) => {
      filterMap = e.target.value.trim();
      renderManual();
    });

    // Wiki quick links
    const wikiPages = [
      { icon: '🐉', title: 'NPCs', url: '/wiki/npcs' },
      { icon: '📖', title: 'Hechizos', url: '/wiki/spells' },
      { icon: '🗺', title: 'Mapas', url: '/wiki/maps' },
      { icon: '⚔', title: 'Equipo', url: '/wiki/equipment' },
      { icon: '⚜', title: 'Facciones', url: '/wiki/factions' },
    ];
    const wlContainer = document.getElementById('aohud-wiki-links');
    wikiPages.forEach(p => {
      const btn = document.createElement('div');
      btn.className = 'wl-btn';
      btn.textContent = p.icon;
      btn.title = p.title;
      btn.addEventListener('click', () => window.open('https://aoweb.app' + p.url, '_blank'));
      wlContainer.appendChild(btn);
    });

    const soundToggle = document.getElementById('aohud-sound-toggle');
    if (!soundAlertsEnabled) soundToggle.classList.add('muted');
    soundToggle.textContent = soundAlertsEnabled ? '🔔' : '🔕';
    soundToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      soundAlertsEnabled = !soundAlertsEnabled;
      localStorage.setItem('aoweb-hud-sound', soundAlertsEnabled ? 'on' : 'off');
      soundToggle.textContent = soundAlertsEnabled ? '🔔' : '🔕';
      soundToggle.classList.toggle('muted', !soundAlertsEnabled);
    });

    renderManual(); renderPlayerFrame(); updateFooter();

    // Wiki live data — fetch if cache is stale
    if (!wikiLoaded || !loadWikiCache()) {
      fetchWikiData();
    }

    // Load AO head sprites for avatar
    loadHeadData();
    // Load user macros from API (for the Macros tab)
    fetchPlayerMacros();
    // Re-sync macros every 30s in case user changes them in-game
    setInterval(fetchPlayerMacros, 30000);

    globalObs = new MutationObserver(muts => {
      if (observerActive) { globalObs.disconnect(); return; }
      for (const m of muts) for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        const t = (node.textContent || '').trim();
        if (t && CONSOLE_DETECT.test(t)) { attachObserver(node.parentElement || node); return; }
      }
    });
    globalObs.observe(document.body, { childList: true, subtree: true });

    updateOverlayPositions();
    window.addEventListener('resize', scheduleReposition);
    window.addEventListener('beforeunload', saveSessionHistory);
    if (window.ResizeObserver) new ResizeObserver(scheduleReposition).observe(document.body);
    setInterval(() => { if (!gameCanvas) updateOverlayPositions(); }, 2000);
    setInterval(renderPlayerFrame, 5000);
    setInterval(() => { if (currentTab === 'stats') renderManual(); }, 5000);
    setInterval(readGameBuffTimers, 2000);
    setInterval(readPlayerXP, 5000);
    setInterval(readPlayerHP, 2000);
  }

  if (document.body) init();
  else window.addEventListener('DOMContentLoaded', init);

  console.log('%c[AOWeb HUD v1.11] sticky auto-ataque · double-tap Space · multi-CC click-to-lock · auto-renovar Celeridad piloto', 'color:#d4a857;font-weight:bold;font-family:serif');
})();
