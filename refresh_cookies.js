require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const puppeteer = require('puppeteer');
let puppeteerExtra;
let StealthPlugin;
try {
  puppeteerExtra = require('puppeteer-extra');
  StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteerExtra.use(StealthPlugin());
} catch (e) {
  puppeteerExtra = null;
}
// removed libsodium/upload-to-github code: this service now persists cookies locally only
const { Telegraf } = require('telegraf');
const utils = require('./lib/utils');
const { fetchStock } = require('./sd_stock_script');

// Config
const COOKIES_FILE = process.env.COOKIES_FILE || path.join(__dirname, 'cookies.json');
// GitHub-related configuration removed: this container persists cookies locally.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;
const REFRESH_TIMEOUT_MS = parseInt(process.env.REFRESH_TIMEOUT_MS || '60000', 10);
const REFRESH_DONE_TIMEOUT_MS = parseInt(process.env.REFRESH_DONE_TIMEOUT_MS || '90000', 10);
const DEBUG_DIR = process.env.DEBUG_DIR || path.join(__dirname, 'debug');
const USER_DATA_DIR = process.env.USER_DATA_DIR || process.env.PUPPETEER_USER_DATA_DIR;
const DEBUG_MODE = (process.env.DEBUG === 'true');
const BROWSER_REUSE = (process.env.BROWSER_REUSE !== 'false');

if (!TELEGRAM_BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN no definido en .env');
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

function isAdminFromCtx(ctx) {
  if (!TELEGRAM_ADMIN_ID) return true;
  const from = ctx && ctx.from && (ctx.from.id || ctx.from.id === 0 ? ctx.from.id : ctx.chat && ctx.chat.id);
  return String(from) === String(TELEGRAM_ADMIN_ID);
}

// upload to GitHub removed: cookies are persisted locally in `COOKIES_FILE`.

async function performLoginAndSaveCookies(sendProgress = () => {}, waitForDone = () => Promise.resolve(), sendDebug = async () => {}) {
  const headless = (process.env.REFRESH_HEADLESS === 'true');
  const commonArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-gpu',
    '--single-process',
    '--no-zygote',
    '--lang=es-ES,es',
    '--window-size=1366,768'
  ];
  const launchOptions = { headless, args: commonArgs, timeout: REFRESH_TIMEOUT_MS, protocolTimeout: REFRESH_TIMEOUT_MS };
  if (process.env.CHROME_PATH) launchOptions.executablePath = process.env.CHROME_PATH;
  if (USER_DATA_DIR) launchOptions.userDataDir = USER_DATA_DIR;

  // Limpiar locks antes de intentar lanzar el browser
  if (USER_DATA_DIR && fs.existsSync(USER_DATA_DIR)) {
    const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort'];
    for (const lockFile of lockFiles) {
      const lockPath = path.join(USER_DATA_DIR, lockFile);
      try { if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath); } catch (e) {}
    }
    // Matar procesos chromium huérfanos que dejen el perfil bloqueado (ARM/QEMU)
    try {
      require('child_process').execSync('pkill -9 chromium || true', { stdio: 'ignore' });
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {}
  }

  const reuseBrowser = BROWSER_REUSE && Boolean(USER_DATA_DIR || process.env.BROWSER_REUSE);
  const useExtra = !!(puppeteerExtra && process.env.REFRESH_TRY_HEADLESS_LOGIN === 'true');
  let browser;
  try {
    browser = await utils.getOrLaunchBrowser({ puppeteer, puppeteerExtra, launchOptions, usePuppeteerExtra: useExtra, reuse: reuseBrowser });
  } catch (errLaunch) {
    const msg = (errLaunch && (errLaunch.message || String(errLaunch))).toLowerCase();
    // Detect common profile-in-use errors from Chromium/puppeteer
    if (msg.includes('profile appears to be in use') || msg.includes('the browser is already running') || msg.includes('process_singleton_posix') || msg.includes('code: 21')) {
      sendProgress('Perfil de Chrome en uso o bloqueado. Intentando login alternativo en perfil temporal...');
      try {
        const ok = await autoLoginUsingCredentials(sendDebug);
        if (ok) {
          // read cookies file written by autoLoginUsingCredentials
          try {
            const raw = fs.readFileSync(COOKIES_FILE, 'utf8');
            const cookies = JSON.parse(raw || '[]');
            return { loggedIn: true, cookies };
          } catch (e) {
            // if reading fails, still return success boolean
            return { loggedIn: true, cookies: [] };
          }
        }
      } catch (e) {
        // fall through to try temp profile
      }

      // As a last resort, try launching Chromium with a temporary userDataDir
      try {
        const tmp = require('os').tmpdir();
        const tmpProfile = path.join(tmp, 'sd_stock_profile_fallback_' + Date.now());
        launchOptions.userDataDir = tmpProfile;
        sendProgress('Intentando lanzar Chromium con perfil temporal: ' + tmpProfile);
        browser = await utils.getOrLaunchBrowser({ puppeteer, puppeteerExtra, launchOptions, usePuppeteerExtra: useExtra, reuse: false });
      } catch (e2) {
        // rethrow original error if fallback also failed
        throw errLaunch;
      }
    } else {
      throw errLaunch;
    }
  }
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36');

  try {
    await page.goto('https://store.steampowered.com/login/', { waitUntil: 'networkidle2', timeout: REFRESH_TIMEOUT_MS });
    await utils.waitForLoginUI(page, REFRESH_TIMEOUT_MS).catch(() => {});

    const usernameSelectors = '#input_username, input[name="username"], input#username, input[name="accountname"], input[type="text"]';
    const passwordSelectors = '#input_password, input[name="password"], input#password, input[type="password"]';

    const typedUserHandle = await utils.findBestAndType(page, usernameSelectors, process.env.STEAM_USERNAME || '');
    const typedPassHandle = await utils.findBestAndType(page, passwordSelectors, process.env.STEAM_PASSWORD || '');

    if (typedPassHandle) {
      try { await utils.submitLogin(page, typedPassHandle, sendDebug, DEBUG_DIR); } catch (e) {}
    } else {
      // fallback simple fill
      await (async function fillFormFallback(root) {
        async function inspect(node) {
          const forms = await node.$$('form');
          for (const form of forms) {
            let txt = '';
            try { txt = (await node.evaluate(f => f.innerText, form)).trim(); } catch (e) {}
            if (/iniciar sesión|sign in/i.test(txt) || await form.$('button[type="submit"]')) {
              const textInput = await form.$('input[type="text"], input:not([type])');
              const passInput = await form.$('input[type="password"]');
              try { if (textInput) await textInput.type(process.env.STEAM_USERNAME || '', { delay: 50 }); } catch (e) {}
              try { if (passInput) await passInput.type(process.env.STEAM_PASSWORD || '', { delay: 50 }); } catch (e) {}
              return true;
            }
          }
          return false;
        }
        if (await inspect(root)) return true;
        for (const frame of root.frames()) { try { if (await inspect(frame)) return true; } catch (e) {} }
        return false;
      })(page);
    }

    // global submit fallback
    try { await utils.submitLogin(page, null, sendDebug, DEBUG_DIR); } catch (e) {}

    let loggedIn = false;
    try {
      await page.waitForFunction(() => {
        const selectors = ['#account_pulldown .name', '.user_persona_name', '.persona_name', '.account_name'];
        return selectors.some(s => !!document.querySelector(s));
      }, { timeout: REFRESH_DONE_TIMEOUT_MS });
      loggedIn = true;
    } catch (e) {
      if (!headless) {
        sendProgress('No sesión detectada automáticamente; complete el login manualmente y envía /done cuando termines.');
        await waitForDone();
        try {
          await page.waitForFunction(() => {
            const selectors = ['#account_pulldown .name', '.user_persona_name', '.persona_name', '.account_name'];
            return selectors.some(s => !!document.querySelector(s));
          }, { timeout: 60000 });
          loggedIn = true;
        } catch (e2) {}
      }
    }

    const cookies = await page.cookies();
    try { fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2)); } catch (e) { console.warn('No se pudo escribir cookies:', e && e.message); }

    if (!loggedIn && headless) {
      try { const { png, html } = await utils.saveDebugArtifacts(page, DEBUG_DIR); try { await sendDebug(png, html); } catch (e) {} } catch (e) {}
      if (!reuseBrowser) try { await browser.close(); } catch (e) {}
      throw new Error('Login fields not found (headless).');
    }

    if (!reuseBrowser) {
      try { await browser.close(); } catch (e) {}
      // Dar tiempo a Chromium para liberar el lock
      await new Promise(r => setTimeout(r, 1000));
    }
    return { loggedIn, cookies };
  } catch (err) {
    try { await browser.close(); } catch (e) {}
    // Dar tiempo a Chromium para liberar el lock
    await new Promise(r => setTimeout(r, 1000));
    throw err;
  }
}

async function autoLoginUsingCredentials(sendDebug = null) {
  if (!process.env.STEAM_USERNAME || !process.env.STEAM_PASSWORD) return false;
  const tmp = require('os').tmpdir();
  const tmpProfile = path.join(tmp, 'sd_stock_autologin_profile_' + Date.now());
  const tryHeadlessStealth = (process.env.REFRESH_HEADLESS === 'true' && process.env.REFRESH_TRY_HEADLESS_LOGIN === 'true' && puppeteerExtra);
  const commonArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--lang=es-ES,es', '--window-size=1366,768'];

  const launchOptions = tryHeadlessStealth
    ? { headless: true, args: commonArgs, timeout: REFRESH_TIMEOUT_MS, protocolTimeout: REFRESH_TIMEOUT_MS }
    : { headless: false, args: commonArgs, userDataDir: tmpProfile, timeout: REFRESH_TIMEOUT_MS, protocolTimeout: REFRESH_TIMEOUT_MS };
  if (process.env.CHROME_PATH) launchOptions.executablePath = process.env.CHROME_PATH;

  const browser = await utils.getOrLaunchBrowser({ puppeteer, puppeteerExtra, launchOptions, usePuppeteerExtra: tryHeadlessStealth, reuse: false });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36');
  try {
    await page.goto('https://store.steampowered.com/login/', { waitUntil: 'networkidle2', timeout: REFRESH_TIMEOUT_MS });
    await utils.waitForLoginUI(page, REFRESH_TIMEOUT_MS).catch(() => {});
    const usHandle = await utils.findBestAndType(page, '#input_username, input[name="username"], input[type="text"]', process.env.STEAM_USERNAME);
    const pwHandle = await utils.findBestAndType(page, '#input_password, input[name="password"], input[type="password"]', process.env.STEAM_PASSWORD);
    if (pwHandle) { try { await utils.submitLogin(page, pwHandle, sendDebug, DEBUG_DIR); } catch (e) {} }
    try { await page.waitForFunction(() => { const selectors = ['#account_pulldown .name', '.user_persona_name', '.persona_name', '.account_name']; return selectors.some(s => !!document.querySelector(s)); }, { timeout: REFRESH_DONE_TIMEOUT_MS }); } catch (e) {}
    const cookies = await page.cookies();
    try { fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2)); } catch (e) {}
    try { await browser.close(); } catch (e) {}
    // cleanup temporary profile directory if it was created
    try {
      if (tmpProfile && tmpProfile.indexOf('sd_stock_autologin_profile_') !== -1) {
        fs.rmSync(tmpProfile, { recursive: true, force: true });
      }
    } catch (_) {}
    return cookies && cookies.length > 0;
  } catch (e) {
    try { if (browser) await browser.close(); } catch (_) {}
    try {
      if (tmpProfile && tmpProfile.indexOf('sd_stock_autologin_profile_') !== -1) {
        fs.rmSync(tmpProfile, { recursive: true, force: true });
      }
    } catch (_) {}
    return false;
  }
}

const doneResolvers = new Map();

bot.command('refresh_cookies', async (ctx) => {
  if (!isAdminFromCtx(ctx)) return ctx.reply('No estás autorizado para usar este comando.');
  const chatId = ctx.chat.id;
  const sendProgress = (t) => ctx.reply(t);
  sendProgress('Iniciando proceso de refresco de cookies...');

  const headlessEnv = (process.env.REFRESH_HEADLESS === 'true');
  function hasValidSteamCookies() {
    try {
      if (!fs.existsSync(COOKIES_FILE)) return false;
      const raw = fs.readFileSync(COOKIES_FILE, 'utf8');
      const cookies = JSON.parse(raw || '[]');
      if (!Array.isArray(cookies)) return false;
      return cookies.some(c => /steamLoginSecure|steamLogin/i.test(c.name));
    } catch (e) { return false; }
  }

  if (headlessEnv) {
    if (!USER_DATA_DIR && !hasValidSteamCookies()) {
      sendProgress('Modo headless detectado y no hay perfil ni cookies. Intentaré un login automático en modo visible (temporal).');
      const ok = await autoLoginUsingCredentials(sendDebug);
      if (!ok) {
        return ctx.reply('Login automático falló. Ejecuta una vez con REFRESH_HEADLESS=false y completa el login manualmente para crear un perfil o establece USER_DATA_DIR apuntando a tu perfil de Chrome.');
      }
      sendProgress('Login automático completado, continúo con el proceso.');
    }
    if (USER_DATA_DIR && !fs.existsSync(USER_DATA_DIR)) {
      return ctx.reply(`Has establecido USER_DATA_DIR=${USER_DATA_DIR} pero la carpeta no existe. Crea la carpeta o ejecuta primero en modo no-headless para que se cree automáticamente.`);
    }
  }

  const waitForDone = () => new Promise((resolve) => { doneResolvers.set(chatId, resolve); });

  const sendDebug = async (pngPath, htmlPath) => {
    if (!DEBUG_MODE) return;
    try {
      if (fs.existsSync(pngPath)) await ctx.replyWithDocument({ source: fs.createReadStream(pngPath) });
      if (fs.existsSync(htmlPath)) await ctx.replyWithDocument({ source: fs.createReadStream(htmlPath) });
    } catch (e) { try { await ctx.reply('No se pudieron enviar los archivos de debug: ' + (e && e.message)); } catch (_) {} }
  };

  try {
    const { loggedIn, cookies } = await performLoginAndSaveCookies(sendProgress, waitForDone, sendDebug);
    if (!cookies || cookies.length === 0) return sendProgress('No se obtuvieron cookies tras el intento de login.');
    const steamCookies = cookies.filter(c => /steam|steampowered/i.test(c.domain));
    const payload = JSON.stringify(steamCookies, null, 2);
    try {
      fs.writeFileSync(COOKIES_FILE, payload);
      sendProgress(`Cookies guardadas localmente en ${COOKIES_FILE}`);
    } catch (e) {
      sendProgress('Cookies obtenidas pero no se pudo escribir el archivo local de cookies: ' + (e && e.message));
    }
  } catch (err) {
    console.error(err);
    sendProgress('Error durante el proceso: ' + (err && err.message ? err.message : String(err)));
  }
});

bot.command('status', (ctx) => {
  if (!isAdminFromCtx(ctx)) return ctx.reply('No estás autorizado para usar este comando.');
  try {
    if (fs.existsSync(COOKIES_FILE)) {
      const stat = fs.statSync(COOKIES_FILE);
      return ctx.reply(`Cookies file: ${COOKIES_FILE}\nÚltima modificación: ${stat.mtime.toISOString()}\nTamaño: ${stat.size} bytes`);
    }
    ctx.reply(`No existe ${COOKIES_FILE}`);
  } catch (e) { ctx.reply('Error obteniendo estado: ' + (e && e.message)); }
});

bot.command('done', (ctx) => {
  const chatId = ctx.chat.id;
  const resolver = doneResolvers.get(chatId);
  if (resolver) { resolver(); doneResolvers.delete(chatId); return ctx.reply('OK: recibiré que has terminado el login manual.'); }
  ctx.reply('No hay proceso interactivo pendiente.');
});

bot.command('help', (ctx) => {
  ctx.reply('/refresh_cookies — Inicia login y guarda cookies localmente\n/status — Muestra estado del fichero de cookies\n/done — Indica que has terminado el login manual en navegador (para modo no-headless)');
});

// Send logs to admin: if file is small enough send as document, otherwise send tail
bot.command(['logs', 'send_logs'], async (ctx) => {
  if (!isAdminFromCtx(ctx)) return ctx.reply('No estás autorizado para usar este comando.');
  try {
    if (!fs.existsSync(LOG_FILE)) return ctx.reply(`No se encontró el fichero de logs en ${LOG_FILE}`);
    const text = fs.readFileSync(LOG_FILE, 'utf8');
    const parts = (ctx.message && ctx.message.text) ? ctx.message.text.trim().split(/\s+/) : [];
    const requestedLines = parts[1] ? Math.max(1, parseInt(parts[1], 10) || 200) : 200;
    const lines = text.split(/\r?\n/);
    const start = Math.max(0, lines.length - requestedLines);
    const tailLines = lines.slice(start).join('\n');
    const header = `Últimas ${Math.min(requestedLines, lines.length)} líneas de ${LOG_FILE} (mostrando ${lines.length - start}):`;
    await ctx.reply(header);

    // Telegram max message size ~4096 characters. Use a safe chunk size.
    const CHUNK_SIZE = 3800;
    for (let i = 0; i < tailLines.length; i += CHUNK_SIZE) {
      const chunk = tailLines.slice(i, i + CHUNK_SIZE);
      // send as plain text (monospace not strictly necessary)
      await ctx.reply(chunk);
    }
  } catch (e) {
    console.error('Error enviando logs:', e && e.stack ? e.stack : e);
    try { await ctx.reply('Error al enviar logs: ' + (e && e.message)); } catch (_) {}
  }
});

// Cleanup locks from previous runs before starting the bot
try { cleanupProfileLocks(); } catch (e) { console.error('Error during initial cleanup:', e && e.message); }
bot.launch().then(() => console.log('Bot de Telegram iniciado (telegraf).'));

// Graceful shutdown
process.once('SIGINT', async () => { try { await utils.closeSharedBrowser(); } catch (e) {} process.exit(0); });
process.once('SIGTERM', async () => { try { await utils.closeSharedBrowser(); } catch (e) {} process.exit(0); });

process.on('unhandledRejection', (reason) => { console.error('Unhandled Rejection:', reason); });
process.on('uncaughtException', (err) => { console.error('Uncaught Exception:', err && err.stack ? err.stack : err); });

module.exports = { performLoginAndSaveCookies, autoLoginUsingCredentials };
// ======= Periodic stock checker (runs inside the same container) =======
// Behavior: every CHECK_INTERVAL_MINUTES it runs `fetchStock()`; if a login/session
// failure is detected it will try `performLoginAndSaveCookies()` automatically.
// If auto-login fails it will notify the admin via Telegram.

const CHECK_INTERVAL_MINUTES = parseInt(process.env.CHECK_INTERVAL_MINUTES || '5', 10);
const TELEGRAM_NOTIFY_CHAT = process.env.TELEGRAM_CHAT_ID || TELEGRAM_ADMIN_ID;
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, 'watch_log.txt');

// Max document size safe to send via Telegram bot (approx). If larger, we'll send a tail.
const TELEGRAM_MAX_DOC_BYTES = 48 * 1024 * 1024; // 48 MB

// Ensure the log file exists (append-only for this process)
try { fs.appendFileSync(LOG_FILE, ''); } catch (e) {}

// Helper to append a timestamped line synchronously
function writeLogLine(text) {
  const line = `[${new Date().toISOString()}] ${text}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
}

// Override console.log and console.error so logs go to watch_log.txt as well
const _origConsoleLog = console.log.bind(console);
const _origConsoleError = console.error.bind(console);
console.log = (...args) => {
  const text = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  writeLogLine(text);
  _origConsoleLog(...args);
};
console.error = (...args) => {
  const text = args.map(a => (a && a.stack) ? a.stack : (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  writeLogLine(text);
  _origConsoleError(...args);
};

// Cleanup Chromium lock files in USER_DATA_DIR to avoid 'profile in use' after restart
function cleanupProfileLocks() {
  try {
    const dir = USER_DATA_DIR || path.join(__dirname, 'data');
    if (!dir) return;
    if (!fs.existsSync(dir)) return;
    writeLogLine('Cleaning Chromium lock files in ' + dir);
    const walk = (p) => {
      let names = [];
      try { names = fs.readdirSync(p); } catch (e) { return; }
      for (const name of names) {
        const full = path.join(p, name);
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            // Recurse into directories
            walk(full);
          }
          // If filename matches common Chromium lock patterns, remove it
          if (/^Singleton|SingletonLock|SingletonSocket|.*lock.*$/i.test(name)) {
            try {
              // Try relax permissions then remove
              try { fs.chmodSync(full, 0o700); } catch (_) {}
              try { fs.unlinkSync(full); writeLogLine('Unlinked lock file: ' + full); } catch (_) {
                try { fs.rmSync(full, { recursive: true, force: true }); writeLogLine('Removed lock: ' + full); } catch (e) { writeLogLine('Could not remove lock: ' + full + ' (' + (e && e.message) + ')'); }
              }
            } catch (e) {}
          }
        } catch (e) { /* ignore */ }
      }
    };
    walk(dir);
  } catch (e) {
    writeLogLine('Error limpiando locks: ' + (e && e.message));
  }
}

async function notifyTelegramSimple(title, message) {
  if (!TELEGRAM_NOTIFY_CHAT || !TELEGRAM_BOT_TOKEN) return;
  try {
    const text = `*${title}*\n${message}`;
    await require('axios').post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_NOTIFY_CHAT,
      text,
      parse_mode: 'Markdown'
    }, { timeout: 10000 });
    console.log('Notificación enviada por Telegram:', title);
  } catch (e) { console.warn('Error enviando Telegram:', e && e.message ? e.message : e); }
}

let checkerTimer = null;
let isChecking = false;

async function runCheckOnce() {
  if (isChecking) return;
  isChecking = true;
  console.log(`[checker] Iniciando comprobación de stock (${new Date().toISOString()})`);
  const startedAt = Date.now();
  try {
    const items = await fetchStock();
    if (!items) {
      console.warn('[checker] No se obtuvieron items — posible problema de sesión o de scraping. Intentando auto-login...');
      const ok = await attemptAutoLoginAndNotify();
      if (!ok) {
        await notifyTelegramSimple('Auto-login fallido', 'El intento automático de login ha fallado. Revisa el contenedor.');
      }
      return;
    }
    const available = items.filter(i => !/sin stock/i.test(i.availability));
    if (available.length > 0) {
      const msg = `${available.length} artículo(s) posiblemente en stock.`;
      console.log('[checker] Stock detectado:', msg);
      await notifyTelegramSimple('Stock detectado', msg + '\n' + available.map(a => `${a.title} — ${a.price || 'precio desconocido'}`).join('\n'));
    } else {
      console.log('[checker] No hay stock en esta comprobación.');
    }
    const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(2);
    console.log(`[checker] Duración de ejecución (s): ${durationSeconds}`);
  } catch (err) {
    console.error('[checker] Error durante la comprobación:', err && err.message ? err.message : err);
    // On error, try to auto-login and notify if it fails
    const ok = await attemptAutoLoginAndNotify();
    if (!ok) await notifyTelegramSimple('Error crítico', `Error al comprobar stock: ${(err && err.message) || String(err)}`);
  } finally {
    isChecking = false;
  }
}

async function attemptAutoLoginAndNotify() {
  try {
    // Esperar 2 segundos antes de intentar login para asegurar que se liberan locks
    await new Promise(r => setTimeout(r, 2000));
    console.log('[checker] Ejecutando performLoginAndSaveCookies para intentar renovar sesión...');
    try {
      const { loggedIn, cookies } = await performLoginAndSaveCookies((t) => console.log('[checker] ' + t));
      if (loggedIn) {
        console.log('[checker] Auto-login OK — cookies guardadas.');
        await notifyTelegramSimple('Auto-login exitoso', 'He renovado la sesión y actualizado las cookies.');
        return true;
      }
    } catch (e) {
      console.warn('[checker] performLoginAndSaveCookies arrojó excepción:', e && e.message ? e.message : e);
    }
    // Fallback: try autoLoginUsingCredentials (visible flow or stealth)
    const ok = await autoLoginUsingCredentials(async (png, html) => {
      if (DEBUG_MODE) {
        // try to send debug artifacts to admin
        try {
          const fs = require('fs');
          if (fs.existsSync(png)) await bot.telegram.sendDocument(TELEGRAM_NOTIFY_CHAT, { source: png });
          if (fs.existsSync(html)) await bot.telegram.sendDocument(TELEGRAM_NOTIFY_CHAT, { source: html });
        } catch (e) { /* ignore */ }
      }
    });
    if (ok) {
      await notifyTelegramSimple('Auto-login exitoso', 'Auto-login alternativo completado y cookies guardadas.');
      return true;
    }
    console.warn('[checker] Auto-login no logró renovar la sesión.');
    return false;
  } catch (e) {
    console.error('[checker] Error durante intento de auto-login:', e && e.message ? e.message : e);
    return false;
  }
}

// Start periodic checks after bot is launched
setTimeout(() => {
  // run immediately once
  runCheckOnce();
  // schedule interval
  checkerTimer = setInterval(runCheckOnce, CHECK_INTERVAL_MINUTES * 60 * 1000);
  console.log(`[checker] Programado cada ${CHECK_INTERVAL_MINUTES} minutos.`);
}, 2000);
// end of file
