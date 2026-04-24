const http = require('http');
const fs   = require('fs');
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
const STATE_FILE      = '/tmp/counter-state.json';
// ─────────────────────────────────────────────────────────────

// ── Estado persistente ────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      console.log('[State] Estado cargado:', data);
      return data;
    }
  } catch(e) { console.warn('[State] Error cargando:', e.message); }
  return { remaining: 4 * 3600, streamStartTime: null };
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      remaining: currentRemaining,
      streamStartTime: streamStartTime,
    }));
  } catch(e) { console.warn('[State] Error guardando:', e.message); }
}

const initialState    = loadState();
let currentRemaining  = initialState.remaining;
let streamStartTime   = initialState.streamStartTime;

setInterval(saveState, 30000);

// ── Servidor HTTP + WebSocket ─────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Stream Counter Server OK');
});

const wss = new WebSocketServer({ server });
const overlays = new Set();
const panels = new Set();

wss.on('connection', (ws, req) => {
  console.log('[+] Cliente conectado');

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.role === 'overlay') {
      overlays.add(ws);
      console.log('[overlay] Overlay registrado, total:', overlays.size);
      return;
    }

    if (msg.role === 'panel') {
      panels.add(ws);
      console.log('[panel] Panel registrado');
      ws.send(JSON.stringify({ remaining: currentRemaining }));
      return;
    }

    if (msg.role === 'sync') {
      if (msg.remaining !== undefined) {
        currentRemaining = msg.remaining;
        saveState();
      }
      return;
    }

    if (msg.secret !== SECRET) {
      console.warn('[-] Clave incorrecta');
      return;
    }

    console.log('[->] Evento:', msg.type, msg.amount || '');

    if (msg.type === 'set_time')     { currentRemaining = Math.round((msg.amount || 0) * 60); saveState(); }
    if (msg.type === 'start_stream') { streamStartTime = Date.now(); saveState(); console.log('[Stream] Inicio registrado'); }
    if (msg.type === 'reset')        { currentRemaining = 0; streamStartTime = null; serverPaused = false; saveState(); }
    if (msg.type === 'toggle')       { serverPaused = !serverPaused; }

    broadcastOverlay({ type: msg.type, amount: msg.amount || 0 });
  });

  ws.on('close', () => {
    overlays.delete(ws);
    panels.delete(ws);
    console.log('[-] Cliente desconectado');
  });
});

function broadcastOverlay(payload) {
  const data = JSON.stringify(payload);
  for (const client of overlays) {
    if (client.readyState === 1) client.send(data);
  }
}

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
    if (message.trim().toLowerCase() === '!extensible') {
      const elapsed = streamStartTime ? Math.floor((Date.now() - streamStartTime) / 1000) : null;
      const response = currentRemaining > 0
        ? (elapsed !== null ? 'Transcurrido: ' + fmtTime(elapsed) + ' | ' : '') + 'Tiempo restante: ' + fmtTime(currentRemaining)
        : 'El contador esta en 0!';
      twitchClient.say(channel, response);
      console.log('[Twitch] !extensible ->', response);
    }
  });

  twitchClient.on('disconnected', (reason) => {
    console.warn('[Twitch] Desconectado:', reason);
    setTimeout(connectTwitch, 10000);
  });
}

connectTwitch();

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
    case 'toggle':     broadcastOverlay({ type: 'toggle' });    reply = 'Pausa/reanudar'; break;
    case 'reset':      currentRemaining = 0; streamStartTime = null; saveState(); broadcastOverlay({ type: 'reset' }); reply = 'Reiniciado'; break;
    case 'set_time':
      if (!arg) { message.reply('Uso: !settimer 180 (minutos)'); return; }
      currentRemaining = Math.round(arg * 60); saveState();
      broadcastOverlay({ type: 'set_time', amount: arg });
      reply = 'Contador ajustado a ' + arg + ' min'; break;
    case 'bits':
      if (!arg || arg <= 0) { message.reply('Uso: !bits 500'); return; }
      broadcastOverlay({ type: 'bits', amount: arg });
      reply = arg + ' bits anadidos'; break;
    case 'custom':
      if (!arg || arg <= 0) { message.reply('Uso: !sumar 3'); return; }
      broadcastOverlay({ type: 'custom', amount: arg });
      reply = '+' + arg + ' min anadidos'; break;
    case 'custom_neg':
      if (!arg || arg <= 0) { message.reply('Uso: !quitar 3'); return; }
      broadcastOverlay({ type: 'custom', amount: -arg });
      reply = '-' + arg + ' min quitados'; break;
  }

  if (reply) message.reply(reply);
});

discordClient.login(DISCORD_TOKEN);
