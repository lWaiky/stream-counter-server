const http = require('http');
const { WebSocketServer } = require('ws');
const { Client, GatewayIntentBits } = require('discord.js');
const tmi  = require('tmi.js');

// ─── CONFIGURACIÓN DE TIEMPOS (fuente de verdad) ─────────────
const CONFIG = {
  follower:    10 * 60,   // segundos
  sub:         60 * 60,
  resub:       60 * 60,
  donation:    30 * 60,   // por euro
  bitsPerUnit: 100,
  bitsSeconds: 30 * 60,   // por cada 100 bits
  raidPerViewer: 3 * 60,  // por viewer, mínimo 3 viewers
};

// ─── VARIABLES DE ENTORNO ─────────────────────────────────────
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const SECRET          = process.env.SECRET || 'CAMBIA_ESTO_POR_UNA_CLAVE_SECRETA';
const PORT            = process.env.PORT || 8080;
const ALLOWED_CHANNEL = '';
const TWITCH_TOKEN    = process.env.TWITCH_TOKEN;
const TWITCH_USER     = 'onlyflan_es';
const REDIS_URL       = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN     = process.env.UPSTASH_REDIS_REST_TOKEN;
// ─────────────────────────────────────────────────────────────

// ── Redis ─────────────────────────────────────────────────────
async function redisGet(key) {
  try {
    const res = await fetch(`${REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const data = await res.json();
    return data.result;
  } catch(e) { console.error('[Redis] GET error:', e.message); return null; }
}

async function redisSet(key, value) {
  try {
    await fetch(`${REDIS_URL}/set/${key}/${encodeURIComponent(String(value))}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
  } catch(e) { console.error('[Redis] SET error:', e.message); }
}

// ── Estado ────────────────────────────────────────────────────
let currentRemaining = 4 * 3600;
let streamStartTime  = null;
let serverPaused     = false;
const contributors   = {};
const recentEvents   = new Map(); // anti-duplicados

async function loadState() {
  try {
    const r = await redisGet('remaining');
    const s = await redisGet('streamStartTime');
    const p = await redisGet('paused');
    if (r !== null) currentRemaining = parseInt(r);
    if (s !== null && s !== 'null') streamStartTime = parseInt(s);
    if (p !== null) serverPaused = p === 'true';
    console.log('[Redis] Estado cargado:', { currentRemaining, serverPaused });
  } catch(e) { console.warn('[State] Error:', e.message); }
}

async function saveState() {
  await redisSet('remaining', currentRemaining);
  await redisSet('streamStartTime', streamStartTime || 'null');
  await redisSet('paused', serverPaused);
}

// ── Sumar tiempo en el servidor ───────────────────────────────
function addTime(secs) {
  currentRemaining = Math.max(0, currentRemaining + secs);
  broadcastAll({ type: 'sync_time', remaining: currentRemaining });
  saveState();
}

function processEvent(type, amount, username) {
  let secs = 0;
  let label = '';

  switch(type) {
    case 'follower':
      secs = CONFIG.follower;
      label = '👤 ' + (username || 'Seguidor') + ' te siguió';
      break;
    case 'sub':
      secs = CONFIG.sub;
      label = '⭐ ' + (username || 'Sub') + ' se suscribió';
      break;
    case 'resub':
      secs = CONFIG.resub;
      label = '🔄 ' + (username || 'Resub') + ' renovó';
      break;
    case 'donation':
      secs = Math.round((amount || 1) * CONFIG.donation);
      label = '💜 ' + (username || 'Donación') + ' donó ' + (amount || 1) + '€';
      break;
    case 'bits':
      secs = Math.round((amount / CONFIG.bitsPerUnit) * CONFIG.bitsSeconds);
      label = '💎 ' + (username || 'Bits') + ' dio ' + amount + ' bits';
      break;
    case 'raid': {
      const viewers = amount || 0;
      if (viewers < 3) {
        console.log('[Raid] Ignorado, menos de 3 viewers:', viewers);
        return;
      }
      secs = viewers * CONFIG.raidPerViewer;
      label = '⚔️ ' + (username || 'Raid') + ' trajo ' + viewers + ' viewers';
      break;
    }
    case 'custom':
      secs = Math.round((amount || 0) * 60);
      label = secs >= 0 ? '⏱️ +Tiempo manual' : '⏱️ −Tiempo manual';
      break;
    default:
      return;
  }

  if (secs === 0 && type !== 'custom') return;

  // Registrar contribuidor
  if (username && secs > 0) {
    contributors[username] = (contributors[username] || 0) + secs;
    console.log('[contrib]', username, '->', Math.floor(contributors[username] / 60) + 'min');
  }

  // Sumar al contador
  currentRemaining = Math.max(0, currentRemaining + secs);
  saveState();

  // Notificar a todos
  broadcastOverlay({ type, amount, username, secs, label });
  broadcastAll({ type: 'sync_time', remaining: currentRemaining });

  // Mandar evento al panel para el historial
  const mins = Math.round(secs / 60);
  const panelData = JSON.stringify({ remaining: currentRemaining, paused: serverPaused, eventLog: { name: label, mins, label: (secs >= 0 ? '+' : '') + mins + ' min' } });
  for (const c of panels) if (c.readyState === 1) c.send(panelData);

  // Confeti si suma más de 120 min
  if (secs >= 120 * 60) broadcastOverlay2({ type: 'confetti' });

  // Alerta en overlay2
  broadcastOverlay2({ type, username, seconds: secs, amount, viewers: amount });

  console.log('[Evento]', type, username || '', '+' + Math.floor(secs/60) + 'min', '=', Math.floor(currentRemaining/60) + 'min total');
}

// ── WebSocket ─────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Stream Counter Server OK');
});

const wss       = new WebSocketServer({ server });
const overlays  = new Set();
const overlays2 = new Set();
const panels    = new Set();
const ttsClients = new Set();

wss.on('connection', (ws) => {
  console.log('[+] Cliente conectado');

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Identificación
    if (msg.role === 'overlay') {
      overlays.add(ws);
      // Sincronizar tiempo y estado al conectar
      ws.send(JSON.stringify({ type: 'set_time', amount: currentRemaining / 60 }));
      if (serverPaused) ws.send(JSON.stringify({ type: 'toggle' }));
      console.log('[overlay] Registrado, total:', overlays.size);
      return;
    }
    if (msg.role === 'overlay2') { overlays2.add(ws); console.log('[overlay2] Registrado'); return; }
    if (msg.role === 'panel')    { panels.add(ws);    ws.send(JSON.stringify({ remaining: currentRemaining, paused: serverPaused })); console.log('[panel] Registrado'); return; }
    if (msg.role === 'tts')      { ttsClients.add(ws); console.log('[TTS] Registrado'); return; }

    // Eventos de StreamElements (vienen del overlay)
    if (msg.role === 'event') {
      if (!msg.eventId || recentEvents.has(msg.eventId)) return;
      recentEvents.set(msg.eventId, Date.now());
      setTimeout(() => recentEvents.delete(msg.eventId), 15000);
      processEvent(msg.type, msg.amount || 0, msg.username || '');
      return;
    }

    // Comandos del panel (requieren clave)
    if (msg.secret !== SECRET) { console.warn('[-] Clave incorrecta'); return; }

    console.log('[Panel]', msg.type, msg.amount || '');

    switch(msg.type) {
      case 'set_time':
        currentRemaining = Math.round((msg.amount || 0) * 60);
        saveState();
        broadcastAll({ type: 'sync_time', remaining: currentRemaining });
        break;
      case 'toggle':
        serverPaused = !serverPaused;
        saveState();
        broadcastOverlay({ type: 'toggle' });
        break;
      case 'reset':
        currentRemaining = 0; streamStartTime = null; serverPaused = false;
        saveState();
        Object.keys(contributors).forEach(k => delete contributors[k]);
        broadcastOverlay({ type: 'reset' });
        broadcastAll({ type: 'sync_time', remaining: 0 });
        break;
      case 'start_stream':
        streamStartTime = Date.now();
        saveState();
        console.log('[Stream] Inicio registrado');
        break;
      case 'reset_contributors':
        Object.keys(contributors).forEach(k => delete contributors[k]);
        console.log('[Contributors] Reseteados');
        break;
      case 'mute':
        broadcastOverlay({ type: 'mute', amount: msg.amount || 0 });
        break;
      case 'custom':
        processEvent('custom', msg.amount || 0, '');
        break;
    }
  });

  ws.on('close', () => {
    overlays.delete(ws); overlays2.delete(ws);
    panels.delete(ws); ttsClients.delete(ws);
    console.log('[-] Cliente desconectado');
  });
});

function broadcastOverlay(payload) {
  const data = JSON.stringify(payload);
  for (const c of overlays) if (c.readyState === 1) c.send(data);
  if (payload.type === 'tts') {
    for (const c of ttsClients) if (c.readyState === 1) c.send(data);
  }
}

function broadcastOverlay2(payload) {
  const data = JSON.stringify(payload);
  for (const c of overlays2) if (c.readyState === 1) c.send(data);
}

function broadcastAll(payload) {
  const data = JSON.stringify(payload);
  for (const c of [...overlays, ...panels]) if (c.readyState === 1) c.send(data);
}

// ── Countdown del servidor ────────────────────────────────────
setInterval(() => {
  if (!serverPaused && currentRemaining > 0) currentRemaining--;
  // Mandar tiempo a panels cada segundo
  const top5 = Object.entries(contributors).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const data = JSON.stringify({ remaining: currentRemaining, paused: serverPaused, top5 });
  for (const c of panels) if (c.readyState === 1) c.send(data);
  // Sincronizar overlay cada 30 segundos para corregir desvíos
  if (currentRemaining % 30 === 0) {
    broadcastOverlay({ type: 'set_time', amount: currentRemaining / 60 });
  }
}, 1000);

// Guardar en Redis cada 10 segundos
setInterval(saveState, 10000);

server.listen(PORT, '0.0.0.0', () => console.log('[OK] Servidor en puerto', PORT));

// ── Twitch ────────────────────────────────────────────────────
function fmtTime(secs) {
  const h = Math.floor(secs/3600), m = Math.floor((secs%3600)/60), s = secs%60;
  if (h > 0) return h+'h '+m+'m '+s+'s';
  if (m > 0) return m+'m '+s+'s';
  return s+'s';
}

let lastTopTime = 0;

function connectTwitch() {
  if (!TWITCH_TOKEN) { console.warn('[Twitch] Sin token'); return; }
  const tc = new tmi.Client({
    identity: { username: TWITCH_USER, password: TWITCH_TOKEN },
    channels: [TWITCH_USER],
    options: { debug: false },
  });
  tc.connect().then(() => console.log('[Twitch] Conectado')).catch(err => {
    console.error('[Twitch] Error:', err);
    setTimeout(connectTwitch, 10000);
  });
  tc.on('message', (channel, tags, message, self) => {
    if (self) return;
    const msg2 = message.trim().toLowerCase();

    if (msg2 === '!top') {
      const now = Date.now();
      if (now - lastTopTime < 60000) { tc.say(channel, '⏳ !top disponible en ' + Math.ceil((60000-(now-lastTopTime))/1000) + 's'); return; }
      lastTopTime = now;
      const sorted = Object.entries(contributors).sort((a,b)=>b[1]-a[1]).slice(0,5);
      if (!sorted.length) { tc.say(channel, 'Aun no hay contribuidores!'); return; }
      broadcastOverlay2({ type: 'top', top5: sorted });
      tc.say(channel, '🏆 Top contribuidores:');
      sorted.forEach(([u,s],i) => setTimeout(() => tc.say(channel, ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣'][i]+' '+u+' — '+Math.floor(s/60)+' min'), i*600));
      return;
    }
    if (msg2 === '!mitiempo') {
      const s = contributors[tags.username] || 0;
      tc.say(channel, s ? '@'+tags.username+' has sumado '+Math.floor(s/60)+' min! 🕐' : '@'+tags.username+' aun no has sumado tiempo!');
      return;
    }
    if (msg2 === '!record') {
      const sorted = Object.entries(contributors).sort((a,b)=>b[1]-a[1]);
      tc.say(channel, sorted.length ? '🏆 Record: '+sorted[0][0]+' con '+Math.floor(sorted[0][1]/60)+' min!' : 'Sin contribuidores aun!');
      return;
    }
    if (msg2.startsWith('!tts ')) {
      const isMod = tags.mod || tags.badges?.broadcaster;
      const isSub = tags.subscriber || tags.badges?.subscriber || tags.badges?.founder;
      if (!isMod && !isSub) { tc.say(channel, '@'+tags.username+' !tts es solo para subs y mods.'); return; }
      const text = message.trim().slice(5).trim();
      if (text) broadcastOverlay({ type: 'tts', text: tags.username+' dice: '+text });
      return;
    }
    if (msg2 === '!extensible') {
      const elapsed = streamStartTime ? Math.floor((Date.now()-streamStartTime)/1000) : null;
      tc.say(channel, currentRemaining > 0
        ? (elapsed ? 'Transcurrido: '+fmtTime(elapsed)+' | ' : '')+'Tiempo restante: '+fmtTime(currentRemaining)
        : 'El contador esta en 0!');
    }
  });
  tc.on('disconnected', () => setTimeout(connectTwitch, 10000));
}

// ── Discord ───────────────────────────────────────────────────
const COMMANDS = {
  '!seguidor': 'follower', '!sub': 'sub', '!resub': 'resub',
  '!raid': 'raid', '!donacion': 'donation', '!bits': 'bits',
};

const dc = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
dc.on('clientReady', () => console.log('[OK] Discord:', dc.user.tag));
dc.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const parts = message.content.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parseFloat(parts[1]) || 0;

  if (COMMANDS[cmd]) {
    processEvent(COMMANDS[cmd], arg, message.author.username);
    message.reply('✓ Evento añadido');
    return;
  }

  switch(cmd) {
    case '!sumar':
      if (!arg) { message.reply('Uso: !sumar 3'); return; }
      processEvent('custom', arg, '');
      message.reply('+' + arg + ' min añadidos'); break;
    case '!quitar':
      if (!arg) { message.reply('Uso: !quitar 3'); return; }
      processEvent('custom', -arg, '');
      message.reply('-' + arg + ' min quitados'); break;
    case '!pausar':
      serverPaused = !serverPaused; saveState();
      broadcastOverlay({ type: 'toggle' });
      message.reply(serverPaused ? 'Pausado' : 'Reanudado'); break;
    case '!reiniciar':
      currentRemaining = 0; streamStartTime = null; serverPaused = false; saveState();
      Object.keys(contributors).forEach(k => delete contributors[k]);
      broadcastOverlay({ type: 'reset' });
      broadcastAll({ type: 'sync_time', remaining: 0 });
      message.reply('Reiniciado'); break;
    case '!settimer':
      if (!arg) { message.reply('Uso: !settimer 180'); return; }
      currentRemaining = Math.round(arg * 60); saveState();
      broadcastAll({ type: 'sync_time', remaining: currentRemaining });
      message.reply('Contador ajustado a ' + arg + ' min'); break;
  }
});

async function main() {
  await loadState();
  connectTwitch();
  dc.login(DISCORD_TOKEN);
}

main();
