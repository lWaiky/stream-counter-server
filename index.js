// index.js — Servidor WebSocket + Bot de Discord todo en uno
// Instala dependencias: npm install discord.js ws
// Arrancar: node index.js

const { WebSocketServer } = require('ws');
const { Client, GatewayIntentBits } = require('discord.js');

// ─── CONFIGURACIÓN ───────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SECRET          = 'onlyflanstreamer'; // igual en panel web y overlay
const PORT            = 8021;

// Canal de Discord donde se permiten los comandos
// Pon el ID del canal o déjalo vacío ('') para permitir cualquier canal
const ALLOWED_CHANNEL = '';
// ─────────────────────────────────────────────────────────────

// ── Servidor WebSocket ────────────────────────────────────────
const wss = new WebSocketServer({ port: PORT });
const overlays = new Set();

wss.on('connection', (ws, req) => {
  console.log(`[+] Cliente conectado desde ${req.socket.remoteAddress}`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // El overlay se identifica al conectarse
    if (msg.role === 'overlay') {
      overlays.add(ws);
      console.log('[overlay] Overlay registrado');
      return;
    }

    // Verificar clave secreta
    if (msg.secret !== SECRET) {
      console.warn('[-] Clave incorrecta, ignorando');
      return;
    }

    console.log(`[→] Evento: ${msg.type} ${msg.amount || ''}`);
    broadcast({ type: msg.type, amount: msg.amount || 0 });
  });

  ws.on('close', () => {
    overlays.delete(ws);
    console.log('[-] Cliente desconectado');
  });
});

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of overlays) {
    if (client.readyState === 1) client.send(data);
  }
}

console.log(`[✓] Servidor WebSocket escuchando en puerto ${PORT}`);

// ── Bot de Discord ────────────────────────────────────────────
const COMMANDS = {
  '!seguidor': { type: 'follower' },
  '!sub':      { type: 'sub' },
  '!resub':    { type: 'resub' },
  '!raid':     { type: 'raid' },
  '!donacion': { type: 'donation' },
  '!donación': { type: 'donation' },
  '!bits':     { type: 'bits' },   // uso: !bits 500
  '!sumar':    { type: 'custom' }, // uso: !sumar 3 (minutos directos)
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.on('ready', () => {
  console.log(`[✓] Bot conectado como ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (ALLOWED_CHANNEL && message.channelId !== ALLOWED_CHANNEL) return;

  const parts = message.content.trim().split(/\s+/);
  const cmd   = parts[0].toLowerCase();
  const arg   = parseFloat(parts[1]) || 0;

  if (!COMMANDS[cmd]) return;

  const { type } = COMMANDS[cmd];
  let reply = '';

  switch (type) {
    case 'follower':
      broadcast({ type: 'follower' });
      reply = '👤 Seguidor añadido'; break;
    case 'sub':
      broadcast({ type: 'sub' });
      reply = '⭐ Sub añadido'; break;
    case 'resub':
      broadcast({ type: 'resub' });
      reply = '🔄 Resub añadido'; break;
    case 'raid':
      broadcast({ type: 'raid' });
      reply = '⚔️ Raid añadido'; break;
    case 'donation':
      broadcast({ type: 'donation' });
      reply = '💜 Donación añadida'; break;
    case 'bits':
      if (!arg || arg <= 0) { message.reply('❌ Uso: `!bits 500`'); return; }
      broadcast({ type: 'bits', amount: arg });
      reply = `💎 ${arg} bits añadidos`; break;
    case 'custom':
      if (!arg || arg <= 0) { message.reply('❌ Uso: `!sumar 3`'); return; }
      broadcast({ type: 'custom', amount: arg });
      reply = `⏱️ +${arg} minutos añadidos`; break;
  }

  if (reply) message.reply(reply);
});

client.login(DISCORD_TOKEN);
