const http = require('http');
const { WebSocketServer } = require('ws');
const { Client, GatewayIntentBits } = require('discord.js');
const tmi = require('tmi.js');

// ─── CONFIGURACIÓN ───────────────────────────────────────────
const CONFIG = {
  follower:      5 * 60,
  sub:          40 * 60,
  resub:        40 * 60,
  donation:     20 * 60,   // por euro
  bitsPerUnit:  100,
  bitsSeconds:  20 * 60,   // por 100 bits
  raidPerViewer: 2 * 60,   // mínimo 3 viewers
};

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SECRET        = process.env.SECRET || 'cambia_esto';
const PORT          = process.env.PORT || 8080;
const TWITCH_TOKEN  = process.env.TWITCH_TOKEN;
const TWITCH_USER   = 'onlyflan_es';
const REDIS_URL     = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN   = process.env.UPSTASH_REDIS_REST_TOKEN;
// ─────────────────────────────────────────────────────────────

// ── Redis ─────────────────────────────────────────────────────
async function rGet(key) {
  try {
    const r = await fetch(`${REDIS_URL}/get/${key}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
    return (await r.json()).result;
  } catch(e) { return null; }
}
async function rSet(key, val) {
  try {
    await fetch(`${REDIS_URL}/set/${key}/${encodeURIComponent(String(val))}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
  } catch(e) {}
}

// ── Estado ────────────────────────────────────────────────────
let remaining     = 4 * 3600;
let paused        = false;
let streamStart   = null;
const contributors = {};
const seenEvents   = new Map(); // anti-duplicados

async function loadState() {
  const r = await rGet('remaining');
  const p = await rGet('paused');
  const s = await rGet('streamStart');
  const c = await rGet('contributors');
  if (r) remaining   = parseInt(r);
  if (p) paused      = p === 'true';
  if (s && s !== 'null') streamStart = parseInt(s);
  if (c) { try { Object.assign(contributors, JSON.parse(decodeURIComponent(c))); } catch(e) {} }
  console.log('[Redis] Cargado:', { remaining, paused, contributors: Object.keys(contributors).length });
}

async function saveState() {
  await rSet('remaining', remaining);
  await rSet('paused', paused);
  await rSet('streamStart', streamStart || 'null');
  await rSet('contributors', encodeURIComponent(JSON.stringify(contributors)));
}

// ── Clientes WebSocket ────────────────────────────────────────
const server = http.createServer((req, res) => { res.writeHead(200); res.end('OK'); });
const wss    = new WebSocketServer({ server });

const overlays   = new Set();
const overlays2  = new Set();
const panels     = new Set();
const ttsClients = new Set();

// ── Lógica de eventos ─────────────────────────────────────────
function calcSeconds(type, amount) {
  switch(type) {
    case 'follower':  return CONFIG.follower;
    case 'sub':       return CONFIG.sub;
    case 'resub':     return CONFIG.resub;
    case 'donation':  return Math.round((amount || 1) * CONFIG.donation);
    case 'bits':      return Math.round(((amount || 0) / CONFIG.bitsPerUnit) * CONFIG.bitsSeconds);
    case 'raid': {
      const v = amount || 0;
      if (v < 3) return 0;
      return v * CONFIG.raidPerViewer;
    }
    case 'custom':    return Math.round((amount || 0) * 60);
    default:          return 0;
  }
}

function processEvent(type, amount, username, eventId) {
  // Anti-duplicados
  if (eventId) {
    if (seenEvents.has(eventId)) {
      console.log('[Dup] Ignorado:', eventId);
      return;
    }
    seenEvents.set(eventId, Date.now());
    setTimeout(() => seenEvents.delete(eventId), 15000);
  }

  const secs = calcSeconds(type, amount);
  if (secs === 0 && type !== 'custom') {
    console.log('[Raid] Ignorado <3 viewers o evento sin segundos');
    return;
  }

  remaining = Math.max(0, remaining + secs);

  if (username && secs > 0) {
    contributors[username] = (contributors[username] || 0) + secs;
  }

  saveState();

  const label = buildLabel(type, amount, username, secs);
  console.log(`[Evento] ${type} ${username||''} +${Math.floor(secs/60)}min = ${Math.floor(remaining/60)}min total`);

  // Notificar overlay (visual)
  broadcast(overlays, { type, secs, label, username, amount });
  broadcast(overlays2, { type, secs, label, username, amount });
  // Sincronizar tiempo a todos
  broadcastTime();
  // Mandar eventLog a panels para historial
  const eventLogData = JSON.stringify({ type: 'time', remaining, paused, top5: Object.entries(contributors).sort((a,b)=>b[1]-a[1]).slice(0,5), eventLog: { name: label, mins: Math.round(secs/60), label: (secs>=0?'+':'')+Math.round(secs/60)+' min' } });
  for (const c of panels) if (c.readyState === 1) c.send(eventLogData);
}

function buildLabel(type, amount, username, secs) {
  const u = username || '';
  const m = Math.round(secs / 60);
  switch(type) {
    case 'follower':  return `👤 ${u} te siguió +${m}min`;
    case 'sub':       return `⭐ ${u} se suscribió +${m}min`;
    case 'resub':     return `🔄 ${u} renovó +${m}min`;
    case 'raid':      return `⚔️ ${u} trajo ${amount} viewers +${m}min`;
    case 'donation':  return `💜 ${u} donó ${amount}€ +${secs < 60 ? (secs/60).toFixed(1) : m}min`;
    case 'bits':      return `💎 ${u} dio ${amount} bits +${m}min`;
    case 'custom':    return secs >= 0 ? `⏱️ +${m}min manual` : `⏱️ ${m}min manual`;
    default:          return `+${m}min`;
  }
}

function broadcastTime() {
  const top5 = Object.entries(contributors).sort((a,b) => b[1]-a[1]).slice(0,5);
  const data = JSON.stringify({ type: 'time', remaining, paused, top5 });
  for (const c of [...overlays, ...panels, ...overlays2]) if (c.readyState === 1) c.send(data);
}

function broadcast(set, payload) {
  const data = JSON.stringify(payload);
  for (const c of set) if (c.readyState === 1) c.send(data);
}

// ── WebSocket handler ─────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('[+] Conectado');

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    // Identificación
    if (msg.role === 'overlay2') {
      overlays2.add(ws);
      ws.send(JSON.stringify({ type: 'time', remaining, paused, top5: Object.entries(contributors).sort((a,b)=>b[1]-a[1]).slice(0,5) }));
      console.log('[overlay2] Registrado, total:', overlays2.size);
      return;
    }
    if (msg.role === 'overlay') {
      overlays.add(ws);
      ws.send(JSON.stringify({ type: 'time', remaining, paused }));
      console.log('[overlay] Registrado, total:', overlays.size);
      return;
    }
    if (msg.role === 'panel') {
      panels.add(ws);
      ws.send(JSON.stringify({ type: 'time', remaining, paused }));
      console.log('[panel] Registrado');
      return;
    }
    if (msg.role === 'tts') {
      ttsClients.add(ws);
      return;
    }

    // Eventos de StreamElements (sin clave, solo desde overlay)
    if (msg.role === 'event') {
      processEvent(msg.type, msg.amount || 0, msg.username || '', msg.eventId);
      return;
    }

    // Comandos del panel (requieren clave)
    if (msg.secret !== SECRET) { console.warn('[-] Clave incorrecta'); return; }

    switch(msg.type) {
      case 'set_time':
        remaining = Math.round((msg.amount || 0) * 60);
        saveState(); broadcastTime();
        break;
      case 'toggle':
        paused = !paused;
        saveState(); broadcastTime();
        broadcast(overlays, { type: 'toggle', paused });
        break;
      case 'start_stream':
        streamStart = Date.now();
        saveState();
        break;
      case 'custom':
        processEvent('custom', msg.amount || 0, '', null);
        break;
      case 'manual_donation':
        processEvent('donation', msg.amount || 0, msg.username || '', `manual_${msg.username}_${Date.now()}`);
        break;
      case 'mute':
        broadcast(overlays, { type: 'mute', amount: msg.amount });
        break;
      case 'reset':
        remaining = 0; paused = false; streamStart = null;
        saveState(); broadcastTime();
        broadcast(overlays, { type: 'reset' });
        break;
      case 'add_contributor':
        if (msg.username && msg.mins) {
          contributors[msg.username] = (contributors[msg.username] || 0) + (msg.mins * 60);
          saveState(); broadcastTime();
        }
        break;
      case 'reset_contributors':
        Object.keys(contributors).forEach(k => delete contributors[k]);
        saveState(); broadcastTime();
        break;
    }
  });

  ws.on('close', () => {
    overlays.delete(ws); overlays2.delete(ws); panels.delete(ws); ttsClients.delete(ws);
    console.log('[-] Desconectado');
  });
});

// ── Countdown del servidor ────────────────────────────────────
setInterval(() => {
  if (!paused && remaining > 0) remaining--;
  broadcastTime();
}, 1000);

setInterval(saveState, 10000);

server.listen(PORT, '0.0.0.0', () => console.log('[OK] Puerto', PORT));

// ── Twitch ────────────────────────────────────────────────────
function fmt(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

let lastTop = 0;

function connectTwitch() {
  if (!TWITCH_TOKEN) return;
  const tc = new tmi.Client({
    identity: { username: TWITCH_USER, password: TWITCH_TOKEN },
    channels: [TWITCH_USER], options: { debug: false }
  });
  tc.connect().then(() => console.log('[Twitch] Conectado')).catch(() => setTimeout(connectTwitch, 10000));
  tc.on('message', (ch, tags, msg, self) => {
    if (self) return;
    const m = msg.trim().toLowerCase();
    if (m === '!extensible') {
      const el = streamStart ? Math.floor((Date.now()-streamStart)/1000) : null;
      tc.say(ch, remaining > 0
        ? (el ? `Transcurrido: ${fmt(el)} | ` : '') + `Tiempo restante: ${fmt(remaining)}`
        : 'El contador está en 0!');
    } else if (m === '!top') {
      const now = Date.now();
      if (now - lastTop < 60000) { tc.say(ch, `⏳ !top disponible en ${Math.ceil((60000-(now-lastTop))/1000)}s`); return; }
      lastTop = now;
      const sorted = Object.entries(contributors).sort((a,b)=>b[1]-a[1]).slice(0,5);
      if (!sorted.length) { tc.say(ch, 'Sin contribuidores aún!'); return; }
      broadcast(new Set(/* overlay2 si existe */[]), { type: 'top', top5: sorted });
      tc.say(ch, '🏆 Top contribuidores:');
      sorted.forEach(([u,s],i) => setTimeout(() => tc.say(ch, ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣'][i]+` ${u} — ${Math.floor(s/60)} min`), i*600));
    } else if (m === '!mitiempo') {
      const s = contributors[tags.username] || 0;
      tc.say(ch, s ? `@${tags.username} has sumado ${Math.floor(s/60)} min! 🕐` : `@${tags.username} aún no has sumado tiempo!`);
    } else if (m === '!record') {
      const sorted = Object.entries(contributors).sort((a,b)=>b[1]-a[1]);
      tc.say(ch, sorted.length ? `🏆 Récord: ${sorted[0][0]} con ${Math.floor(sorted[0][1]/60)} min!` : 'Sin contribuidores aún!');
    } else if (m.startsWith('!tts ')) {
      const isMod = tags.mod || tags.badges?.broadcaster;
      const isSub = tags.subscriber || tags.badges?.subscriber;
      if (!isMod && !isSub) { tc.say(ch, `@${tags.username} !tts es solo para subs y mods.`); return; }
      const text = msg.trim().slice(5).trim();
      if (text) broadcast(ttsClients, { type: 'tts', text: `${tags.username} dice: ${text}` });
    }
  });
  tc.on('disconnected', () => setTimeout(connectTwitch, 10000));
}

// ── Discord ───────────────────────────────────────────────────
const dc = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
dc.on('clientReady', () => console.log('[OK] Discord:', dc.user.tag));
dc.on('messageCreate', async msg => {
  if (msg.author.bot) return;
  const parts = msg.content.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parseFloat(parts[1]) || 0;
  switch(cmd) {
    case '!seguidor':  processEvent('follower', 0, msg.author.username, `dc_follower_${Date.now()}`); msg.reply('👤 Seguidor añadido'); break;
    case '!sub':       processEvent('sub', 0, msg.author.username, `dc_sub_${Date.now()}`); msg.reply('⭐ Sub añadido'); break;
    case '!resub':     processEvent('resub', 0, msg.author.username, `dc_resub_${Date.now()}`); msg.reply('🔄 Resub añadido'); break;
    case '!raid':      if (!arg) { msg.reply('Uso: !raid 50'); return; } processEvent('raid', arg, msg.author.username, `dc_raid_${Date.now()}`); msg.reply(`⚔️ Raid de ${arg} añadido`); break;
    case '!donacion':  if (!arg) { msg.reply('Uso: !donacion 5'); return; } processEvent('donation', arg, msg.author.username, `dc_don_${Date.now()}`); msg.reply(`💜 Donación de ${arg}€ añadida`); break;
    case '!bits':      if (!arg) { msg.reply('Uso: !bits 500'); return; } processEvent('bits', arg, msg.author.username, `dc_bits_${Date.now()}`); msg.reply(`💎 ${arg} bits añadidos`); break;
    case '!sumar':     if (!arg) { msg.reply('Uso: !sumar 3'); return; } processEvent('custom', arg, '', null); msg.reply(`+${arg} min añadidos`); break;
    case '!quitar':    if (!arg) { msg.reply('Uso: !quitar 3'); return; } processEvent('custom', -arg, '', null); msg.reply(`-${arg} min quitados`); break;
    case '!pausar':    paused = !paused; saveState(); broadcastTime(); broadcast(overlays, { type: 'toggle', paused }); msg.reply(paused ? 'Pausado' : 'Reanudado'); break;
    case '!reiniciar': remaining = 0; paused = false; streamStart = null; saveState(); broadcastTime(); broadcast(overlays, { type: 'reset' }); msg.reply('Reiniciado'); break;
    case '!settimer':  if (!arg) { msg.reply('Uso: !settimer 180'); return; } remaining = Math.round(arg*60); saveState(); broadcastTime(); msg.reply(`Contador ajustado a ${arg} min`); break;
  }
});

async function main() {
  await loadState();
  connectTwitch();
  dc.login(DISCORD_TOKEN);
}
main();
