// ─── CONFIGURACIÓN ───────────────────────────────────────────
const CONFIG = {
  follower:    10,
  sub:         60,
  resub:       60,
  raid:        15,
  donation:    30,
  bitsPerUnit: 100,
  bitsMinutes: 30,
};

const WS_URL = 'wss://stream-counter-server-production.up.railway.app';
const ALERT_AT = 30 * 60;
// ─────────────────────────────────────────────────────────────

let remaining = 0;
let maxTime   = 0;
let running   = false;
let paused    = false;
let timerInterval = null;
let socket = null;
let alertShown = false;
let endTriggered = false;

// Récord
let recordSecs = 0;
let recordLabel = '';

// ── Sonido coin ───────────────────────────────────────────────
function playCoin() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;
    function beep(freq, start, dur, vol) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = 'square';
      o.frequency.setValueAtTime(freq, t + start);
      g.gain.setValueAtTime(vol, t + start);
      g.gain.exponentialRampToValueAtTime(0.001, t + start + dur);
      o.start(t + start);
      o.stop(t + start + dur + 0.01);
    }
    beep(988,  0.00, 0.08, 0.3);
    beep(1319, 0.08, 0.15, 0.3);
  } catch(e) {}
}

// ── Estilos ───────────────────────────────────────────────────
if (!document.getElementById('float-style')) {
  const s = document.createElement('style');
  s.id = 'float-style';
  s.textContent = `
    @keyframes floatUp {
      0%   { opacity: 1; transform: translateX(-50%) translateY(0); }
      100% { opacity: 0; transform: translateX(-50%) translateY(-60px); }
    }
    @keyframes borderFlash {
      0%   { box-shadow: 0 0 0 0 rgba(74,222,170,0.9), 0 4px 24px rgba(0,0,0,0.5); }
      40%  { box-shadow: 0 0 0 10px rgba(74,222,170,0.2), 0 4px 24px rgba(0,0,0,0.5); }
      100% { box-shadow: 0 4px 24px rgba(0,0,0,0.5); }
    }
    @keyframes borderFlashRed {
      0%   { box-shadow: 0 0 0 0 rgba(255,85,85,0.9), 0 4px 24px rgba(0,0,0,0.5); }
      40%  { box-shadow: 0 0 0 10px rgba(255,85,85,0.2), 0 4px 24px rgba(0,0,0,0.5); }
      100% { box-shadow: 0 4px 24px rgba(0,0,0,0.5); }
    }
    @keyframes alertPulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(255,85,85,0.8), 0 4px 24px rgba(0,0,0,0.5); }
      50% { box-shadow: 0 0 0 12px rgba(255,85,85,0.2), 0 4px 24px rgba(0,0,0,0.5); }
    }
    @keyframes endPulse {
      0%, 100% { opacity: 1; color: #ff4f4f; }
      50% { opacity: 0.2; color: #ff0000; }
    }
    @keyframes endFadeOut {
      0%   { opacity: 1; transform: scale(1); }
      70%  { opacity: 1; transform: scale(1.05); }
      100% { opacity: 0; transform: scale(0.9); }
    }
    @keyframes endTextIn {
      0%   { opacity: 0; transform: translateX(-50%) scale(0.8); }
      50%  { opacity: 1; transform: translateX(-50%) scale(1.05); }
      80%  { opacity: 1; transform: translateX(-50%) scale(1); }
      100% { opacity: 0; transform: translateX(-50%) scale(1); }
    }
  `;
  document.head.appendChild(s);
}

// ── Animación flotante ────────────────────────────────────────
function showFloating(text, color) {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = `
    position: absolute; top: -10px; left: 50%;
    transform: translateX(-50%);
    font-family: 'Rajdhani', monospace; font-size: 28px; font-weight: 700;
    color: ${color}; text-shadow: 0 2px 8px rgba(0,0,0,0.8);
    pointer-events: none; white-space: nowrap;
    animation: floatUp 1.4s ease-out forwards; z-index: 99;
  `;
  document.getElementById('counter-inner').appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

function flashBorder(color) {
  const inner = document.getElementById('counter-inner');
  inner.style.animation = 'none';
  void inner.offsetWidth;
  inner.style.animation = color === 'green'
    ? 'borderFlash 0.6s ease-out forwards'
    : 'borderFlashRed 0.6s ease-out forwards';
  setTimeout(() => { inner.style.animation = ''; }, 700);
}

// ── Animación fin de stream ───────────────────────────────────
function triggerEndAnimation() {
  if (endTriggered) return;
  endTriggered = true;

  const inner = document.getElementById('counter-inner');
  const timeEl = document.getElementById('counter-time');

  // Parpadeo rojo durante 3 segundos
  timeEl.style.animation = 'endPulse 0.4s ease-in-out infinite';
  inner.style.animation = 'alertPulse 0.4s ease-in-out infinite';

  setTimeout(() => {
    // Fade out del contador
    inner.style.animation = 'endFadeOut 1.5s ease-out forwards';

    // Texto "¡Stream terminado!"
    const endText = document.createElement('div');
    endText.textContent = '¡Stream terminado!';
    endText.style.cssText = `
      position: absolute; top: 50%; left: 50%;
      transform: translateX(-50%) translateY(-50%);
      font-family: 'Rajdhani', monospace; font-size: 32px; font-weight: 700;
      color: #ff4f4f; text-shadow: 0 2px 12px rgba(0,0,0,0.9);
      pointer-events: none; white-space: nowrap;
      animation: endTextIn 3s ease-out forwards; z-index: 999;
    `;
    document.getElementById('counter-widget').appendChild(endText);
    setTimeout(() => endText.remove(), 3000);
  }, 3000);
}

// ── Color según tiempo ────────────────────────────────────────
function getTimeColor(secs) {
  if (secs <= 10 * 60) return '#ff4f4f';
  if (secs <= 30 * 60) return '#f9a825';
  return '#ffffff';
}

// ── Alerta 30 minutos ─────────────────────────────────────────
function checkAlert(secs) {
  const inner = document.getElementById('counter-inner');
  if (secs <= ALERT_AT && secs > 0 && !alertShown) {
    alertShown = true;
    inner.style.animation = 'alertPulse 1.5s ease-in-out infinite';
    const lastEl = document.getElementById('counter-last');
    lastEl.textContent = '⚠️ ¡Quedan 30 minutos!';
    lastEl.style.opacity = '1';
    lastEl.style.color = '#f9a825';
    setTimeout(() => { lastEl.style.opacity = '0'; lastEl.style.color = ''; }, 5000);
  }
  if (secs > ALERT_AT) {
    alertShown = false;
    if (!endTriggered) inner.style.animation = '';
  }
  if (secs === 0 && running) triggerEndAnimation();
}

// ── Timer ─────────────────────────────────────────────────────
function pad(n) { return String(Math.floor(Math.abs(n))).padStart(2, '0'); }
function fmt(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${pad(h)}:${pad(m)}:${pad(s % 60)}`;
}

function updateDisplay() {
  const el  = document.getElementById('counter-time');
  const bar = document.getElementById('counter-bar');
  el.textContent = fmt(remaining);
  const color = getTimeColor(remaining);
  if (!endTriggered) el.style.color = color;
  el.className = remaining <= 60 && remaining > 0 ? 'low' : 'ok';
  if (maxTime > 0) {
    bar.style.width = Math.min(100, (remaining / maxTime) * 100) + '%';
    bar.style.background = color;
  }
  checkAlert(remaining);
}

function syncToServer(username, seconds) {
  if (socket && socket.readyState === 1) {
    const payload = { role: 'sync', remaining: remaining };
    if (username && seconds) { payload.username = username; payload.seconds = seconds; }
    socket.send(JSON.stringify(payload));
  }
}

function addSeconds(secs, label, username) {
  remaining = Math.max(0, remaining + secs);
  if (remaining > maxTime) maxTime = remaining;

  // Récord
  if (secs > recordSecs) {
    recordSecs = secs;
    recordLabel = label;
    const lastEl = document.getElementById('counter-last');
    lastEl.textContent = '🏆 Récord: ' + label;
    lastEl.style.opacity = '1';
    setTimeout(() => { lastEl.style.opacity = '0'; }, 5000);
  }

  updateDisplay();
  syncToServer(username, secs > 0 ? secs : 0);

  const mins = Math.abs(secs / 60);
  const minsStr = mins % 1 === 0 ? mins : mins.toFixed(1);
  if (secs >= 0) {
    playCoin();
    showFloating('+' + minsStr + ' min', '#4adeaa');
    flashBorder('green');
  } else {
    showFloating('−' + minsStr + ' min', '#ff6b6b');
    flashBorder('red');
  }

  if (secs < recordSecs) {
    const lastEl = document.getElementById('counter-last');
    lastEl.textContent = label;
    lastEl.style.opacity = '1';
    setTimeout(() => { lastEl.style.opacity = '0'; }, 4000);
  }
}

function startTimer() {
  if (timerInterval) return;
  running = true;
  timerInterval = setInterval(() => {
    if (!paused && remaining > 0) { remaining--; updateDisplay(); }
  }, 1000);
}

setInterval(() => syncToServer(), 1000);

function handleEvent(type, amount, username) {
  const user = username || '';
  startTimer();
  switch (type) {
    case 'follower':
      addSeconds(Math.round(CONFIG.follower * 60), '👤 ' + (user || 'Seguidor') + ' te siguió', user); break;
    case 'sub':
      addSeconds(Math.round(CONFIG.sub * 60), '⭐ ' + (user || 'Sub') + ' se suscribió', user); break;
    case 'resub':
      addSeconds(Math.round(CONFIG.resub * 60), '🔄 ' + (user || 'Resub') + ' renovó', user); break;
    case 'raid': {
      const raidViewers = amount || 0;
      if (raidViewers < 3) {
        const lastEl = document.getElementById('counter-last');
        lastEl.textContent = '⚔️ Raid ignorado (' + raidViewers + ' personas)';
        lastEl.style.opacity = '1';
        setTimeout(() => { lastEl.style.opacity = '0'; }, 3000);
        break;
      }
      addSeconds(Math.round(raidViewers * 3 * 60), '⚔️ ' + (user || 'Raid') + ' trajo ' + raidViewers + ' viewers', user);
      break;
    }
    case 'donation': {
      const euros = amount || 1;
      addSeconds(Math.round(euros * CONFIG.donation * 60), '💜 ' + (user || 'Donación') + ' donó ' + euros + '€', user);
      break;
    }
    case 'bits': {
      const mins = (amount / CONFIG.bitsPerUnit) * CONFIG.bitsMinutes;
      addSeconds(Math.round(mins * 60), '💎 ' + (user || 'Bits') + ' dio ' + amount + ' bits', user);
      break;
    }
    case 'custom':
      addSeconds(Math.round(amount * 60), amount >= 0 ? '⏱️ +Tiempo' : '⏱️ −Tiempo'); break;
    case 'set_time':
      remaining = Math.round(amount * 60); maxTime = remaining;
      endTriggered = false; recordSecs = 0; recordLabel = '';
      document.getElementById('counter-inner').style.animation = '';
      document.getElementById('counter-time').style.animation = '';
      updateDisplay(); syncToServer();
      const setEl = document.getElementById('counter-last');
      setEl.textContent = '⏱️ Contador: ' + (amount / 60).toFixed(1) + 'h';
      setEl.style.opacity = '1';
      setTimeout(() => { setEl.style.opacity = '0'; }, 3000);
      break;
    case 'toggle':
      paused = !paused;
      const tEl = document.getElementById('counter-last');
      tEl.textContent = paused ? '⏸ Pausado' : '▶ Reanudado';
      tEl.style.opacity = '1';
      setTimeout(() => { tEl.style.opacity = '0'; }, 3000);
      break;
    case 'reset':
      remaining = 0; maxTime = 0; paused = false; alertShown = false;
      endTriggered = false; recordSecs = 0; recordLabel = '';
      document.getElementById('counter-inner').style.animation = '';
      document.getElementById('counter-time').style.animation = '';
      clearInterval(timerInterval); timerInterval = null; running = false;
      updateDisplay(); syncToServer();
      break;
  }
}

window.addEventListener('onEventReceived', function(obj) {
  const listener = obj.detail.listener;
  const event    = obj.detail.event;
  const username = event.name || event.sender || event.username || '';

  switch (listener) {
    case 'follower-latest':
      handleEvent('follower', 0, username); break;
    case 'subscriber-latest': {
      const amount = parseInt(event.amount) || parseInt(event.gifted) || parseInt(event.count) || 1;
      const isGift = event.gifted || event.isCommunityGift || amount > 1;
      const isResub = event.type === 'resub';
      const count = isGift ? amount : 1;
      for (let i = 0; i < count; i++) handleEvent(isResub ? 'resub' : 'sub', 0, username);
      break;
    }
    case 'raid-latest':   handleEvent('raid', parseInt(event.amount) || 0, username); break;
    case 'tip-latest':    handleEvent('donation', parseFloat(event.amount) || 1, username); break;
    case 'cheer-latest':  handleEvent('bits', parseInt(event.amount) || 0, username); break;
  }
});

function connectWS() {
  try { socket = new WebSocket(WS_URL); } catch(e) { return; }
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ role: 'overlay' }));
  });
  socket.addEventListener('message', (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type) handleEvent(msg.type, msg.amount || 0);
  });
  socket.addEventListener('close', () => { socket = null; setTimeout(connectWS, 5000); });
  socket.addEventListener('error', () => {});
}

window.addEventListener('onWidgetLoad', function() { updateDisplay(); });

remaining = 4 * 3600;
maxTime   = remaining;
updateDisplay();
startTimer();
connectWS();
