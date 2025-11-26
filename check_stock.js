// Load local .env variables if present (do not commit .env to git)
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { fetchStock } = require('./sd_stock_script');

const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, 'watch_log.txt');

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
  console.log(...args);
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

(async () => {
  const startedAt = Date.now();
  try {
    log('Comprobación única: iniciando...');
    const items = await fetchStock();
    if (!items) {
      log('No se obtuvieron items. Posible error en la carga.');
      await notifyTelegram('Error al comprobar stock', 'No se obtuvieron items');
      const duration = Date.now() - startedAt;
      log('Duración de ejecución (ms):', duration);
      process.exitCode = 3;
      return;
    }

    const available = items.filter(i => !/sin stock/i.test(i.availability));

    if (available.length > 0) {
      const msg = `${available.length} artículo(s) posiblemente en stock.`;
      log('Stock detectado:', msg, JSON.stringify(available.map(a => ({ title: a.title, price: a.price }))));
      await notifyTelegram('Stock detectado', msg + '\n' + available.map(a => `${a.title} — ${a.price || 'precio desconocido'}`).join('\n'));
      const duration = Date.now() - startedAt;
      log('Duración de ejecución (ms):', duration);
      process.exitCode = 0;
    } else {
      log('No hay stock en esta comprobación.');
      const duration = Date.now() - startedAt;
      log('Duración de ejecución (ms):', duration);
      process.exitCode = 1;
    }
  } catch (err) {
    log('Error durante la comprobación:', err && err.message ? err.message : err);
    await notifyTelegram('Error al comprobar stock', (err && err.message) || String(err));
    const duration = Date.now() - startedAt;
    log('Duración de ejecución (ms):', duration);
    process.exitCode = 3;
  }
})();
