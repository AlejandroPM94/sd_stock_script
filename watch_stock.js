const path = require('path');
const notifier = require('node-notifier');
const fs = require('fs');
const axios = require('axios');
const { fetchStock } = require('./sd_stock_script');

// Configuración via env
const INTERVAL_MINUTES = parseInt(process.env.INTERVAL_MINUTES || '15', 10);
const ALERT_THROTTLE_MIN = parseInt(process.env.ALERT_THROTTLE_MIN || '30', 10); // no spamear notificaciones
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, 'watch_log.txt');
const HEADLESS = (process.env.HEADLESS === 'true');

let lastAlertAt = 0;

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  fs.appendFileSync(LOG_FILE, line);
  console.log(...args);
}

async function checkOnce() {
  try {
    log('Chequeando stock...');
    const items = await fetchStock();

    if (!items) {
      log('No se obtuvieron items. Posible error en la carga.');
      notify('Error: no se obtuvieron items', 'Revisa la salida en la terminal o el log.');
      return;
    }

    const available = items.filter(i => !/sin stock/i.test(i.availability));

    if (available.length > 0) {
      const msg = `${available.length} artículo(s) posiblemente en stock.`;
      log('Stock detectado:', msg, JSON.stringify(available.map(a => ({ title: a.title, price: a.price }))))
      notify('Stock detectado', msg);
      await notifyTelegram('Stock detectado', msg + '\n' + available.map(a => `${a.title} — ${a.price || 'precio desconocido'}`).join('\n'));
    } else {
      log('No hay stock en esta comprobación.');
    }
  } catch (err) {
    log('Error durante la comprobación:', err && err.message ? err.message : err);
    notify('Error al comprobar stock', (err && err.message) || String(err));
    await notifyTelegram('Error al comprobar stock', (err && err.message) || String(err));
  }
}

function notify(title, message) {
  const now = Date.now();
  if (now - lastAlertAt < ALERT_THROTTLE_MIN * 60 * 1000) {
    log('Notificación suprimida por throttle');
    return;
  }
  lastAlertAt = now;
  try {
    notifier.notify({ title, message, wait: false });
  } catch (e) {
    log('No se pudo enviar notificación nativa:', e && e.message ? e.message : e);
  }
}

async function notifyTelegram(title, message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;
  try {
    const text = `*${title}*\n${message}`;
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown'
    }, { timeout: 10000 });
    log('Notificación enviada por Telegram');
  } catch (e) {
    log('Error enviando Telegram:', e && e.message ? e.message : e);
  }
}

async function loop() {
  // Primera comprobación inmediata
  await checkOnce();
  // Repetir cada INTERVAL_MINUTES
  setInterval(checkOnce, INTERVAL_MINUTES * 60 * 1000);
}

// Ejecutar
log('Iniciando watcher. Interval (min):', INTERVAL_MINUTES);
loop();
