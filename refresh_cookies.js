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
const sodium = require('libsodium-wrappers');
const { Telegraf } = require('telegraf');
const utils = require('./lib/utils');

// Config
const COOKIES_FILE = process.env.COOKIES_FILE || path.join(__dirname, 'cookies.json');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_SECRET_NAME = process.env.GITHUB_SECRET_NAME || 'STEAM_COOKIES';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;
const REFRESH_TIMEOUT_MS = parseInt(process.env.REFRESH_TIMEOUT_MS || '30000', 10);
const REFRESH_DONE_TIMEOUT_MS = parseInt(process.env.REFRESH_DONE_TIMEOUT_MS || '60000', 10);
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

async function uploadSecretToGitHub(secretName, valueBase64) {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) throw new Error('Faltan GITHUB_TOKEN/GITHUB_OWNER/GITHUB_REPO en .env');
  await sodium.ready;
  const keyResp = await axios.get(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/secrets/public-key`, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
  });
  const { key, key_id } = keyResp.data;
  const pubKey = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(Buffer.from(valueBase64, 'utf8'), pubKey);
  const encrypted_value = Buffer.from(sealed).toString('base64');
  await axios.put(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/secrets/${secretName}`, {
    encrypted_value,
    key_id
  }, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
  });
}

async function performLoginAndSaveCookies(sendProgress = () => {}, waitForDone = () => Promise.resolve(), sendDebug = async () => {}) {
  const headless = (process.env.REFRESH_HEADLESS === 'true');
  const launchOptions = { headless, args: ['--no-sandbox', '--disable-setuid-sandbox'] };
  if (process.env.CHROME_PATH) launchOptions.executablePath = process.env.CHROME_PATH;
  if (USER_DATA_DIR) launchOptions.userDataDir = USER_DATA_DIR;

  const reuseBrowser = BROWSER_REUSE && Boolean(USER_DATA_DIR || process.env.BROWSER_REUSE);
  const useExtra = !!(puppeteerExtra && process.env.REFRESH_TRY_HEADLESS_LOGIN === 'true');
  const browser = await utils.getOrLaunchBrowser({ puppeteer, puppeteerExtra, launchOptions, usePuppeteerExtra: useExtra, reuse: reuseBrowser });
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

    if (!reuseBrowser) await browser.close();
    return { loggedIn, cookies };
  } catch (err) {
    try { await browser.close(); } catch (e) {}
    throw err;
  }
}

async function autoLoginUsingCredentials(sendDebug = null) {
  if (!process.env.STEAM_USERNAME || !process.env.STEAM_PASSWORD) return false;
  const tmp = require('os').tmpdir();
  const tmpProfile = path.join(tmp, 'sd_stock_autologin_profile_' + Date.now());
  const tryHeadlessStealth = (process.env.REFRESH_HEADLESS === 'true' && process.env.REFRESH_TRY_HEADLESS_LOGIN === 'true' && puppeteerExtra);
  const commonArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'];

  const launchOptions = tryHeadlessStealth ? { headless: true, args: commonArgs } : { headless: false, args: commonArgs, userDataDir: tmpProfile };
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
    return cookies && cookies.length > 0;
  } catch (e) {
    try { if (browser) await browser.close(); } catch (_) {}
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
    sendProgress('Subiendo cookies a GitHub (secret)...');
    const base64 = Buffer.from(payload).toString('base64');
    await uploadSecretToGitHub(GITHUB_SECRET_NAME, base64);
    sendProgress('Cookies guardadas y secret subido correctamente.');
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
  ctx.reply('/refresh_cookies — Inicia login y sube cookies a GitHub\n/status — Muestra estado del fichero de cookies\n/done — Indica que has terminado el login manual en navegador (para modo no-headless)');
});

bot.launch().then(() => console.log('Bot de Telegram iniciado (telegraf).'));

// Graceful shutdown
process.once('SIGINT', async () => { try { await utils.closeSharedBrowser(); } catch (e) {} process.exit(0); });
process.once('SIGTERM', async () => { try { await utils.closeSharedBrowser(); } catch (e) {} process.exit(0); });

process.on('unhandledRejection', (reason) => { console.error('Unhandled Rejection:', reason); });
process.on('uncaughtException', (err) => { console.error('Uncaught Exception:', err && err.stack ? err.stack : err); });

module.exports = { performLoginAndSaveCookies, autoLoginUsingCredentials };
// end of file
