const http = require('http');
const { WebSocketServer } = require('ws');
const { Client, GatewayIntentBits } = require('discord.js');
const net = require('net');

const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const SECRET          = process.env.SECRET || 'CAMBIA_ESTO_POR_UNA_CLAVE_SECRETA';
const PORT            = process.env.PORT || 8080;
const ALLOWED_CHANNEL = '';

// Twitch IRC
const TWITCH_TOKEN   = process.env.TWITCH_TOKEN; // oauth:xxxx
const TWITCH_USER    = 'onlyflan_es';
const TWITCH_CHANNEL = '#onlyflan_es';

// Estado del contador (para responder !tiempo)
let currentRemaining = 4 * 3600;

// ── Servidor HTTP + WebSocket ─────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Stream Counter Server OK');
});

const wss = new WebSocketServer({ server });
const overlays = new Set();

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

    if (msg.secret !== SECRET) {
      console.warn('[-] Clave incorrecta');
      return;
    }

    console.log('[->] Evento:', msg.type, msg.amount || '');

    // Actualizar estado local si es set_time o reset
    if (msg.type === 'set_time') currentRemaining = Math.round((msg.amount || 0) * 60);
    if (msg.type === 'reset') currentRemaining = 0;

    broadcastOverlay({ type: msg.type, amount: msg.amount || 0 });
  });

  ws.on('close', () => {
    overlays.delete(ws);
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

// ── Bot de Twitch IRC ─────────────────────────────────────────
function fmtTime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

let twitchClient = null;

function connectTwitch() {
  if (!TWITCH_TOKEN) {
    console.warn('[Twitch] No hay TWITCH_TOKEN, saltando conexión IRC');
    return;
  }

  twitchClient = new net.Socket();
  let buffer = '';

  twitchClient.connect(6667, 'irc.chat.twitch.tv', () => {
    console.log('[Twitch] Conectado al IRC');
    twitchClient.write(`PASS ${TWITCH_TOKEN}\r\n`);
    twitchClient.write(`NICK ${TWITCH_USER}\r\n`);
    twitchClient.write(`JOIN ${TWITCH_CHANNEL}\r\n`);
  });

  twitchClient.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\r\n');
    buffer = lines.pop();

    for (const line of lines) {
      // Responder PING para mantener conexión
      if (line.startsWith('PING')) {
        twitchClient.write('PONG :tmi.twitch.tv\r\n');
        continue;
      }

      // Detectar mensajes del chat
      const match = line.match(/^:(\w+)!\w+@\w+\.tmi\.twitch\.tv PRIVMSG #\w+ :(.+)$/);
      if (!match) continue;

      const msg = match[2].trim().toLowerCase();

      if (msg === '!tiempo') {
        const response = currentRemaining > 0
          ? `⏱️ Tiempo restante en stream: ${fmtTime(currentRemaining)}`
          : '⏱️ El contador está en 0, ¡el stream ha terminado!';
        twitchClient.write(`PRIVMSG ${TWITCH_CHANNEL} :${response}\r\n`);
        console.log('[Twitch] !tiempo respondido:', response);
      }
    }
  });

  twitchClient.on('close', () => {
    console.warn('[Twitch] Desconectado, reconectando en 10s...');
    setTimeout(connectTwitch, 10000);
  });

  twitchClient.on('error', (err) => {
    console.error('[Twitch] Error:', err.message);
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
    case 'reset':      currentRemaining = 0; broadcastOverlay({ type: 'reset' }); reply = 'Reiniciado'; break;
    case 'set_time':
      if (!arg) { message.reply('Uso: !settimer 180 (minutos)'); return; }
      currentRemaining = Math.round(arg * 60);
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
