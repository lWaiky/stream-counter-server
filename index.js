const http = require('http');
const { WebSocketServer } = require('ws');
const { Client, GatewayIntentBits } = require('discord.js');

const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const SECRET          = process.env.SECRET || 'CAMBIA_ESTO_POR_UNA_CLAVE_SECRETA';
const PORT            = process.env.PORT || 8080;
const ALLOWED_CHANNEL = '';

// Servidor HTTP base (necesario para Railway)
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Stream Counter Server OK');
});

const wss = new WebSocketServer({ server });
const overlays = new Set();

wss.on('connection', (ws, req) => {
  console.log('[+] Cliente conectado desde', req.socket.remoteAddress);

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
    broadcast({ type: msg.type, amount: msg.amount || 0 });
  });

  ws.on('close', () => {
    overlays.delete(ws);
    console.log('[-] Cliente desconectado, overlays:', overlays.size);
  });
});

function broadcast(payload) {
  const data = JSON.stringify(payload);
  console.log('[broadcast] Enviando a', overlays.size, 'overlays:', data);
  for (const client of overlays) {
    if (client.readyState === 1) client.send(data);
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('[OK] Servidor escuchando en puerto', PORT);
});

const COMMANDS = {
  '!seguidor': { type: 'follower' },
  '!sub':      { type: 'sub' },
  '!resub':    { type: 'resub' },
  '!raid':     { type: 'raid' },
  '!donacion': { type: 'donation' },
  '!bits':     { type: 'bits' },
  '!sumar':    { type: 'custom' },
};

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

discordClient.on('clientReady', () => {
  console.log('[OK] Bot conectado como', discordClient.user.tag);
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
    case 'follower': broadcast({ type: 'follower' }); reply = 'Seguidor anadido'; break;
    case 'sub':      broadcast({ type: 'sub' });      reply = 'Sub anadido'; break;
    case 'resub':    broadcast({ type: 'resub' });    reply = 'Resub anadido'; break;
    case 'raid':     broadcast({ type: 'raid' });     reply = 'Raid anadido'; break;
    case 'donation': broadcast({ type: 'donation' }); reply = 'Donacion anadida'; break;
    case 'bits':
      if (!arg || arg <= 0) { message.reply('Uso: !bits 500'); return; }
      broadcast({ type: 'bits', amount: arg });
      reply = arg + ' bits anadidos'; break;
    case 'custom':
      if (!arg || arg <= 0) { message.reply('Uso: !sumar 3'); return; }
      broadcast({ type: 'custom', amount: arg });
      reply = '+' + arg + ' minutos anadidos'; break;
  }

  if (reply) message.reply(reply);
});

discordClient.login(DISCORD_TOKEN);
