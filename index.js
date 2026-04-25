const http = require('http');
const { WebSocketServer } = require('ws');
const { Client, GatewayIntentBits } = require('discord.js');
const tmi  = require('tmi.js');

// ─── CONFIGURACIÓN ───────────────────────────────────────────
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const SECRET          = process.env.SECRET || 'CAMBIA_ESTO_POR_UNA_CLAVE_SECRETA';
const PORT            = process.env.PORT || 8080;
const ALLOWED_CHANNEL = '';
const TWITCH_TOKEN    = process.env.TWITCH_TOKEN;
const TWITCH_USER     = 'onlyflan_es';

// Upstash Redis REST API
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
// ─────────────────────────────────────────────────────────────

// ── Redis helpers ─────────────────────────────────────────────
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
    await fetch(`${REDIS_URL}/set/${key}/${encodeURIComponent(value)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
  } catch(e) { console.error('[Redis] SET error:', e.message); }
}

// ── Estado ────────────────────────────────────────────────────
let currentRemaining = 4 * 3600;
let streamStartTime  = null;
let serverPaused     = false;
const contributors   = {};
const recentAlerts   = new Map();

async function loadState() {
  try {
    const remaining = await redisGet('remaining');
    const startTime = await redisGet('streamStartTime');
    const paused    = await redisGet('paused');
    if (remaining !== null) currentRemaining = parseInt(remaining);
    if (startTime !== null && startTime !== 'null') streamStartTime = parseInt(startTime);
    if (paused !== null) serverPaused = paused === 'true';
    console.log('[State] Cargado desde Redis:', { currentRemaining, serverPaused });
  } catch(e) { console.warn('[State] Error cargando:', e.message); }
}

async function saveState() {
  await redisSet('remaining', currentRemaining);
  await redisSet('streamStartTime', streamStartTime || 'null');
  await redisSet('paused', serverPaused);
}

// ── Servidor HTTP + WebSocket ─────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Stream Counter Server OK');
});

const wss      = new WebSocketServer({ server });
const overlays  = new Set();
const overlays2 = new Set();
const panels    = new Set();
const ttsClients = new Set();

wss.on('connection', (ws, req) => {
  console.log('[+] Cliente conectado');

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.role === 'overlay') {
      overlays.add(ws);
      console.log('[overlay] Registrado, total:', overlays.size);
      // Mandar tiempo actual al overlay
      ws.send(JSON.stringify({ type: 'set_time', amount: currentRemaining / 60 }));
      if (serverPaused) ws.send(JSON.stringify({ type: 'toggle' }));
      return;
    }

    if (msg.role === 'overlay2') {
      overlays2.add(ws);
      console.log('[overlay2] Registrado');
      return;
    }

    if (msg.role === 'panel') {
      panels.add(ws);
      console.log('[panel] Registrado');
      ws.send(JSON.stringify({ remaining: currentRemaining }));
      return;
    }

    if (msg.role === 'tts') {
      ttsClients.add(ws);
      console.log('[TTS] Cliente registrado');
      return;
    }

    if (msg.role === 'sync') {
      if (msg.remaining !== undefined) {
        currentRemaining = msg.remaining;
      }
      if (msg.username && msg.seconds && msg.eventId) {
        if (!recentAlerts.has(msg.eventId)) {
          recentAlerts.set(msg.eventId, Date.now());
          setTimeout(() => recentAlerts.delete(msg.eventId), 10000);
          contributors[msg.username] = (contributors[msg.username] || 0) + msg.seconds;
          console.log('[contrib]', msg.username, '->', Math.floor(contributors[msg.username] / 60) + 'min');
          if (msg.seconds >= 120 * 60) broadcastOverlay2({ type: 'confetti' });
          if (msg.eventType) {
            broadcastOverlay2({
              type: msg.eventType,
              username: msg.username,
              seconds: msg.seconds,
              amount: msg.eventAmount || 0,
              viewers: msg.viewers || 0,
            });
          }
        }
      }
      return;
    }

    if (msg.secret !== SECRET) {
      console.warn('[-] Clave incorrecta');
      return;
    }

    console.log('[->] Evento:', msg.type, msg.amount || '');

    switch(msg.type) {
      case 'set_time':
        currentRemaining = Math.round((msg.amount || 0) * 60);
        saveState();
        broadcastOverlay({ type: 'set_time', amount: msg.amount });
        break;
      case 'start_stream':
        streamStartTime = Date.now();
        saveState();
        console.log('[Stream] Inicio registrado');
        break;
      case 'mute':
        broadcastOverlay({ type: 'mute', amount: msg.amount || 0 });
        break;
      case 'toggle':
        serverPaused = !serverPaused;
        saveState();
        broadcastOverlay({ type: 'toggle' });
        break;
      case 'reset':
        currentRemaining = 0;
        streamStartTime = null;
        serverPaused = false;
        saveState();
        Object.keys(contributors).forEach(k => delete contributors[k]);
        broadcastOverlay({ type: 'reset' });
        break;
      default:
        broadcastOverlay({ type: msg.type, amount: msg.amount || 0 });
        break;
    }
  });

  ws.on('close', () => {
    overlays.delete(ws);
    overlays2.delete(ws);
    panels.delete(ws);
    ttsClients.delete(ws);
    console.log('[-] Cliente desconectado');
  });
});

function broadcastOverlay(payload) {
  const data = JSON.stringify(payload);
  for (const client of overlays) {
    if (client.readyState === 1) client.send(data);
  }
  if (payload.type === 'tts') {
    for (const client of ttsClients) {
      if (client.readyState === 1) client.send(data);
    }
  }
}

function broadcastOverlay2(payload) {
  const data = JSON.stringify(payload);
  for (const client of overlays2) {
    if (client.readyState === 1) client.send(data);
  }
}

// ── Countdown del servidor ────────────────────────────────────
// El servidor es la fuente de verdad — cuenta él solo
setInterval(() => {
  if (!serverPaused && currentRemaining > 0) {
    currentRemaining--;
  }
  // Mandar tiempo a panels cada segundo
  const top5 = Object.entries(contributors).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const data = JSON.stringify({ remaining: currentRemaining, top5 });
  for (const client of panels) {
    if (client.readyState === 1) client.send(data);
  }
  // Mandar tiempo a overlays cada 10 segundos para corregir desvíos
}, 1000);

// Guardar en Redis cada 10 segundos
setInterval(saveState, 10000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('[OK] Servidor escuchando en puerto', PORT);
});

// ── Bot de Twitch ─────────────────────────────────────────────
function fmtTime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return h + 'h ' + m + 'm ' + s + 's';
  if (m > 0) return m + 'm ' + s + 's';
  return s + 's';
}

let lastTopTime = 0;
const TOP_COOLDOWN = 60 * 1000;

function connectTwitch() {
  if (!TWITCH_TOKEN) { console.warn('[Twitch] No hay TWITCH_TOKEN'); return; }

  const twitchClient = new tmi.Client({
    identity: { username: TWITCH_USER, password: TWITCH_TOKEN },
    channels: [TWITCH_USER],
    options: { debug: false },
  });

  twitchClient.connect().then(() => {
    console.log('[Twitch] Conectado al chat de', TWITCH_USER);
  }).catch(err => {
    console.error('[Twitch] Error:', err);
    setTimeout(connectTwitch, 10000);
  });

  twitchClient.on('message', (channel, tags, message, self) => {
    if (self) return;
    const msg2 = message.trim().toLowerCase();

    if (msg2 === '!top') {
      const now = Date.now();
      if (now - lastTopTime < TOP_COOLDOWN) {
        const secsLeft = Math.ceil((TOP_COOLDOWN - (now - lastTopTime)) / 1000);
        twitchClient.say(channel, '⏳ !top disponible en ' + secsLeft + 's');
        return;
      }
      lastTopTime = now;
      const sorted = Object.entries(contributors).sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (sorted.length === 0) {
        twitchClient.say(channel, 'Aun no hay contribuidores en este stream!');
      } else {
        const medals = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣'];
        broadcastOverlay2({ type: 'top', top5: sorted.map(([u, s]) => [u, s]) });
        twitchClient.say(channel, '🏆 Top contribuidores del stream:');
        sorted.forEach(([user, secs], i) => {
          setTimeout(() => {
            twitchClient.say(channel, medals[i] + ' ' + user + ' — ' + Math.floor(secs / 60) + ' min');
          }, i * 600);
        });
      }
      return;
    }

    if (msg2 === '!mitiempo') {
      const username = tags.username;
      const secs = contributors[username] || 0;
      if (secs === 0) {
        twitchClient.say(channel, '@' + username + ' aun no has sumado tiempo al stream!');
      } else {
        twitchClient.say(channel, '@' + username + ' has sumado ' + Math.floor(secs / 60) + ' min al stream! 🕐');
      }
      return;
    }

    if (msg2 === '!record') {
      const sorted = Object.entries(contributors).sort((a, b) => b[1] - a[1]);
      if (sorted.length === 0) {
        twitchClient.say(channel, 'Aun no hay contribuidores en este stream!');
      } else {
        const [user, secs] = sorted[0];
        twitchClient.say(channel, '🏆 Record del stream: ' + user + ' con ' + Math.floor(secs / 60) + ' min sumados!');
      }
      return;
    }

    if (msg2.startsWith('!tts ')) {
      const isMod = tags.mod || tags['user-type'] === 'mod' || tags.badges?.broadcaster;
      const isSub = tags.subscriber || tags.badges?.subscriber || tags.badges?.founder;
      if (!isMod && !isSub) {
        twitchClient.say(channel, '@' + tags.username + ' el comando !tts es solo para suscriptores y moderadores.');
        return;
      }
      const ttsMsg = message.trim().slice(5).trim();
      if (!ttsMsg) return;
      const fullMsg = tags.username + ' dice: ' + ttsMsg;
      broadcastOverlay({ type: 'tts', text: fullMsg });
      return;
    }

    if (msg2 === '!extensible') {
      const elapsed = streamStartTime ? Math.floor((Date.now() - streamStartTime) / 1000) : null;
      const response = currentRemaining > 0
        ? (elapsed !== null ? 'Transcurrido: ' + fmtTime(elapsed) + ' | ' : '') + 'Tiempo restante: ' + fmtTime(currentRemaining)
        : 'El contador esta en 0!';
      twitchClient.say(channel, response);
    }
  });

  twitchClient.on('disconnected', (reason) => {
    console.warn('[Twitch] Desconectado:', reason);
    setTimeout(connectTwitch, 10000);
  });
}

// ── Bot de Discord ────────────────────────────────────────────
const COMMANDS = {
  '!seguidor':  { type: 'follower' },
  '!sub':       { type: 'sub' },
  '!resub':     { type: 'resub' },
  '!raid':      { type: 'raid' },
  '!donacion':  { type: 'donation' },
  '!bits':      { type: 'bits' },
  '!sumar':     { type: 'custom' },
  '!quitar':    { type: 'custom_neg' },
  '!pausar':    { type: 'toggle' },
  '!reiniciar': { type: 'reset' },
  '!settimer':  { type: 'set_time' },
};

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

discordClient.on('clientReady', () => {
  console.log('[OK] Bot Discord conectado como', discordClient.user.tag);
});

discordClient.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (ALLOWED_CHANNEL && message.channelId !== ALLOWED_CHANNEL) return;

  const parts = message.content.trim().split(/\s+/);
  const cmd   = parts[0].toLowerCase();
  const arg   = parseFloat(parts[1]) || 0;

  if (!COMMANDS[cmd]) return;

  const { type } = COMMANDS[cmd];
  let reply = '';

  switch (type) {
    case 'follower':   broadcastOverlay({ type: 'follower' });  reply = 'Seguidor anadido'; break;
    case 'sub':        broadcastOverlay({ type: 'sub' });       reply = 'Sub anadido'; break;
    case 'resub':      broadcastOverlay({ type: 'resub' });     reply = 'Resub anadido'; break;
    case 'raid':       broadcastOverlay({ type: 'raid' });      reply = 'Raid anadido'; break;
    case 'donation':   broadcastOverlay({ type: 'donation' });  reply = 'Donacion anadida'; break;
    case 'toggle':
      serverPaused = !serverPaused;
      saveState();
      broadcastOverlay({ type: 'toggle' });
      reply = serverPaused ? 'Pausado' : 'Reanudado'; break;
    case 'reset':
      currentRemaining = 0; streamStartTime = null; serverPaused = false;
      saveState();
      Object.keys(contributors).forEach(k => delete contributors[k]);
      broadcastOverlay({ type: 'reset' });
      reply = 'Reiniciado'; break;
    case 'set_time':
      if (!arg) { message.reply('Uso: !settimer 180 (minutos)'); return; }
      currentRemaining = Math.round(arg * 60);
      saveState();
      broadcastOverlay({ type: 'set_time', amount: arg });
      reply = 'Contador ajustado a ' + arg + ' min'; break;
    case 'bits':
      if (!arg || arg <= 0) { message.reply('Uso: !bits 500'); return; }
      broadcastOverlay({ type: 'bits', amount: arg });
      reply = arg + ' bits anadidos'; break;
    case 'custom':
      if (!arg || arg <= 0) { message.reply('Uso: !sumar 3'); return; }
      currentRemaining += Math.round(arg * 60);
      saveState();
      broadcastOverlay({ type: 'custom', amount: arg });
      reply = '+' + arg + ' min anadidos'; break;
    case 'custom_neg':
      if (!arg || arg <= 0) { message.reply('Uso: !quitar 3'); return; }
      currentRemaining = Math.max(0, currentRemaining - Math.round(arg * 60));
      saveState();
      broadcastOverlay({ type: 'custom', amount: -arg });
      reply = '-' + arg + ' min quitados'; break;
  }

  if (reply) message.reply(reply);
});

// ── Arranque ──────────────────────────────────────────────────
async function main() {
  await loadState();
  connectTwitch();
  discordClient.login(DISCORD_TOKEN);
}

main();
