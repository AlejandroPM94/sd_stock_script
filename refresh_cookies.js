require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const puppeteer = require('puppeteer');
// puppeteer-extra + stealth (used only for headless auto-login attempts)
let puppeteerExtra;
let StealthPlugin;
try {
  puppeteerExtra = require('puppeteer-extra');
  StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteerExtra.use(StealthPlugin());
} catch (e) {
  // optional dependency; auto-headless login will be less stealthy if missing
  puppeteerExtra = null;
  StealthPlugin = null;
}
const sodium = require('libsodium-wrappers');
const { Telegraf } = require('telegraf');

const COOKIES_FILE = process.env.COOKIES_FILE || path.join(__dirname, 'cookies.json');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // personal access token with repo access
const GITHUB_OWNER = process.env.GITHUB_OWNER; // owner/org
const GITHUB_REPO = process.env.GITHUB_REPO; // repo name
const GITHUB_SECRET_NAME = process.env.GITHUB_SECRET_NAME || 'STEAM_COOKIES';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ADMIN_ID = process.env.TELEGRAM_ADMIN_ID; // numeric chat id of the admin allowed to run the command
const REFRESH_TIMEOUT_MS = parseInt(process.env.REFRESH_TIMEOUT_MS || '30000', 10);
const REFRESH_DONE_TIMEOUT_MS = parseInt(process.env.REFRESH_DONE_TIMEOUT_MS || '60000', 10);
const DEBUG_DIR = process.env.DEBUG_DIR || path.join(__dirname, 'debug');
const USER_DATA_DIR = process.env.USER_DATA_DIR || process.env.PUPPETEER_USER_DATA_DIR;

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

  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36');

  try {
    await page.goto('https://store.steampowered.com/login/', { waitUntil: 'networkidle2', timeout: REFRESH_TIMEOUT_MS });

    // Wait for the login UI to appear (inputs/forms). Some pages require clicking
    // a link/button to open the login modal; try several triggers if inputs not found.
    async function waitForLoginUI(rootPage, timeout = REFRESH_TIMEOUT_MS) {
      const loginSelectors = ['input[type="password"]', 'input[type="text"]', 'form[action*="login"]', '#login_area', '#login_form', '.newlogindialog'];
      for (const sel of loginSelectors) {
        try { await rootPage.waitForSelector(sel, { timeout }); return true; } catch (e) {}
      }
      // Try frames
      for (const frame of rootPage.frames()) {
        for (const sel of loginSelectors) {
          try { await frame.waitForSelector(sel, { timeout: 2000 }); return true; } catch (e) {}
        }
      }
      // If still not found, try clicking common login triggers then wait again
      const triggerSelectors = ['a[href*="login"], a[href*="/login/"], .global_action_link, .login_link, .login', 'button[data-ga="header_signin"]'];
      for (const t of triggerSelectors) {
        try {
          const el = await rootPage.$(t);
          if (el) {
            try { await el.click(); } catch (e) {}
            // give the modal a little time
            for (const sel of loginSelectors) {
              try { await rootPage.waitForSelector(sel, { timeout: 3000 }); return true; } catch (e) {}
            }
          }
        } catch (e) {}
      }
      return false;
    }

    const loginUiReady = await waitForLoginUI(page);
    if (!loginUiReady) {
      // allow a longer grace period for slow or interactive elements
      await new Promise(r => setTimeout(r, 1500));
    }

    // findAndType: prefer inputs that belong to a login form (i.e. an ancestor form
    // that has a submit button or contains 'sign in' text). This avoids matching
    // global site search inputs.
    // Finds the best matching input among candidates and types into it.
    // Scoring prefers inputs that are part of a login form and de-prioritizes search boxes.
    async function findBestAndType(pageRoot, selectors, value) {
      const list = selectors.split(',').map(s => s.trim()).filter(Boolean);
      const candidates = [];

      // collect from pageRoot
      for (const sel of list) {
        try {
          const handles = await pageRoot.$$(sel);
          for (const h of handles) candidates.push(h);
        } catch (e) {}
      }

      // collect from frames
      for (const frame of pageRoot.frames()) {
        for (const sel of list) {
          try {
            const handles = await frame.$$(sel);
            for (const h of handles) candidates.push(h);
          } catch (e) {}
        }
      }

      if (candidates.length === 0) return false;

      // Evaluate score for each candidate in page context
      const scored = [];
        for (const h of candidates) {
        try {
          const score = await h.evaluate((node) => {
            const lower = (s) => (s || '').toString().toLowerCase();
            // heavy negative for search inputs
            const aria = lower(node.getAttribute('aria-label') || '');
            const name = lower(node.getAttribute('name') || '');
            const id = lower(node.id || '');
            const placeholder = lower(node.getAttribute('placeholder') || '');
            if (aria.includes('search') || name.includes('search') || placeholder.includes('buscar') || id.includes('search')) return -1000;

            let score = 0;
            if (/user|usuario|email|mail|account|login|nombre/.test(name)) score += 30;
            if (/user|usuario|email|mail|account|login|nombre/.test(id)) score += 20;
            if (/user|usuario|email|mail|account|login|nombre/.test(placeholder)) score += 15;
            if (node.type === 'password') score += 40;
            // check ancestor form
            const form = node.closest('form');
            if (form) {
              if (form.querySelector('button[type="submit"], input[type="submit"]')) score += 40;
              const ftxt = lower(form.innerText || '');
              if (/sign in|signin|iniciar sesión|entrar|acceder/.test(ftxt)) score += 30;
              if (/login|signin|auth|account/.test(form.className || '')) score += 20;
            }
            // ancestor classes
            const anc = lower((node.closest && node.closest('div') && node.closest('div').className) || '');
            if (/login|signin|auth|account/.test(anc)) score += 10;
            return score;
          });
          scored.push({ handle: h, score });
        } catch (e) {}
      }

      scored.sort((a, b) => b.score - a.score);
      if (scored.length === 0 || scored[0].score <= 0) return false;
      try { await scored[0].handle.focus(); await scored[0].handle.type(value, { delay: 50 }); return scored[0].handle; } catch (e) { return false; }
    }

    // Strict submit: prefer submitting the form that contains the provided
    // password handle by clicking the best submit button inside that form.
    // Falls back to form.submit() or global submit buttons. Optionally send
    // debug screenshot via sendDebug callback when provided.
    async function submitLogin(rootPage, passwordHandle = null, sendDebug = null) {
      // Try form-based submit using the passwordHandle's ancestor form
      if (passwordHandle) {
        try {
          const formHandle = (await passwordHandle.evaluateHandle(node => node.closest && node.closest('form') || null)).asElement();
          if (formHandle) {
            // Prefer explicit submit controls (buttons/inputs). Only consider anchors as last resort.
            let candidates = await formHandle.$$('button[type="submit"], input[type="submit"], button, input[type="button"]');
            if (candidates.length === 0) {
              // as a last resort include anchors
              candidates = await formHandle.$$('a');
            }
            let chosen = null;
            for (const c of candidates) {
              try {
                const txt = (await c.evaluate(n => (n.innerText || n.value || '').toString())).toLowerCase();
                if (/iniciar sesión|sign in|entrar|log in|login|acceder|signin/.test(txt)) { chosen = c; break; }
              } catch (e) {}
            }
            if (!chosen && candidates.length) chosen = candidates[0];

            if (chosen) {
              try {
                await chosen.focus();
                // prefer elementHandle.click() which simulates a user click
                // capture some debug info about the element before clicking
                try {
                  const info = await chosen.evaluate(n => ({ tag: n.tagName, text: n.innerText || n.value || '', id: n.id || null, cls: n.className || null }));
                  console.log('Attempting click on submit candidate:', info);
                } catch (e) {}
                await chosen.click({ delay: 50 });
                // after click, wait a short time for account indicator
                try {
                  await rootPage.waitForFunction(() => {
                    const selectors = ['#account_pulldown .name', '.user_persona_name', '.persona_name', '.account_name'];
                    return selectors.some(s => !!document.querySelector(s));
                  }, { timeout: 4000 });
                  return true;
                } catch (e) {
                  // not logged in yet — we'll continue to fallback checks
                }
              } catch (e) {
                // fallback to clicking by coordinates
                try {
                  const box = await chosen.boundingBox();
                  if (box) {
                    await rootPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 50 });
                    try {
                      await rootPage.waitForFunction(() => {
                        const selectors = ['#account_pulldown .name', '.user_persona_name', '.persona_name', '.account_name'];
                        return selectors.some(s => !!document.querySelector(s));
                      }, { timeout: 4000 });
                      return true;
                    } catch (e) {
                      // continue fallback
                    }
                  }
                } catch (e2) {}
              }
            }

            // last resort: submit the form directly in-page
            try {
              await formHandle.evaluate(f => { try { f.submit(); } catch (e) { /* ignore */ } });
              return true;
            } catch (e) {}
          }
        } catch (e) {}
      }

      // Fallback: try a set of global submit-like buttons (page or frames)
      const signSelectors = ['#login_btn_signin', 'button[type="submit"]', 'button#login_btn_signin', '.login_btn', '.auth_button', '.btn_green_white_innerfade.btn_medium'];
      for (const sel of signSelectors) {
        try {
          const el = await rootPage.$(sel);
          if (el) { try { await el.click({ delay: 50 }); return true; } catch (e) {} }
        } catch (e) {}
      }
      for (const frame of rootPage.frames()) {
        for (const sel of signSelectors) {
          try {
            const el = await frame.$(sel);
            if (el) { try { await el.click({ delay: 50 }); return true; } catch (e) {} }
          } catch (e) {}
        }
      }

      // If everything failed, capture debug screenshot/html to help diagnosis
      try {
        if (sendDebug && typeof sendDebug === 'function') {
          try {
            if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
            const ts = Date.now();
            const png = path.join(DEBUG_DIR, `failed_submit_${ts}.png`);
            const html = path.join(DEBUG_DIR, `failed_submit_${ts}.html`);
            await rootPage.screenshot({ path: png, fullPage: true }).catch(() => {});
            const content = await rootPage.content().catch(() => '');
            try { fs.writeFileSync(html, content); } catch (e) {}
            await sendDebug(png, html);
          } catch (e) { console.warn('sendDebug failed:', e && e.message); }
        }
      } catch (e) { console.warn('debug capture failed:', e && e.message); }

      return false;
    }

    const usernameSelectors = '#input_username, input[name="username"], input#username, input[name="accountname"], input[type="text"]';
    const passwordSelectors = '#input_password, input[name="password"], input#password, input[type="password"]';

    const typedUserHandle = await findBestAndType(page, usernameSelectors, process.env.STEAM_USERNAME || '');
    const typedPassHandle = await findBestAndType(page, passwordSelectors, process.env.STEAM_PASSWORD || '');

    // If we typed the password, attempt to submit the form using that handle
    if (typedPassHandle) {
      try { await submitLogin(page, typedPassHandle, sendDebug); } catch (e) {}
    }

    // Fallback: search forms and try to type into first text/password inputs
    if (!typedUserHandle || !typedPassHandle) {
      async function fillFormFallback(root) {
        async function inspect(node) {
          const forms = await node.$$('form');
          for (const form of forms) {
            let txt = '';
            try { txt = (await node.evaluate(f => f.innerText, form)).trim(); } catch (e) {}
            if (/iniciar sesión|sign in/i.test(txt) || await form.$('button[type="submit"]')) {
              const textInput = await form.$('input[type="text"], input:not([type])');
              const passInput = await form.$('input[type="password"]');
              let did = false;
              try { if (textInput) { await textInput.type(process.env.STEAM_USERNAME || '', { delay: 50 }); did = true; } } catch (e) {}
              try { if (passInput) { await passInput.type(process.env.STEAM_PASSWORD || '', { delay: 50 }); did = true; } } catch (e) {}
              if (did) return true;
            }
          }
          return false;
        }
        if (await inspect(root)) return true;
        for (const frame of root.frames()) { try { if (await inspect(frame)) return true; } catch (e) {} }
        return false;
      }
      await fillFormFallback(page);
    }

    // try click submit
    try {
      const signSelectors = ['#login_btn_signin', 'button[type="submit"]', 'button#login_btn_signin', '.login_btn', '.auth_button'];
      let clicked = false;
      for (const sel of signSelectors) {
        try { const el = await page.$(sel); if (el) { await el.click(); clicked = true; break; } } catch (e) {}
      }
      if (!clicked) {
        for (const frame of page.frames()) {
          for (const sel of signSelectors) {
            try { const el = await frame.$(sel); if (el) { await el.click(); clicked = true; break; } } catch (e) {}
          }
          if (clicked) break;
        }
      }
    } catch (e) {}

    // wait for account indicator
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
      // capture debug
      try { if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true }); } catch (e) {}
      const ts = Date.now();
      const png = path.join(DEBUG_DIR, `failed_login_${ts}.png`);
      const html = path.join(DEBUG_DIR, `failed_login_${ts}.html`);
      try { await page.screenshot({ path: png, fullPage: true }); } catch (e) {}
      try { const content = await page.content(); fs.writeFileSync(html, content); } catch (e) {}
      try { await sendDebug(png, html); } catch (e) {}
      await browser.close();
      throw new Error(`Login fields not found (headless). Debug files: ${png}, ${html}`);
    }

    await browser.close();
    return { loggedIn, cookies };
  } catch (err) {
    try { await browser.close(); } catch (e) {}
    throw err;
  }
}

// If running headless and no profile/cookies, try a visible temporary auto-login with provided credentials
async function autoLoginUsingCredentials(sendDebug = null) {
  if (!process.env.STEAM_USERNAME || !process.env.STEAM_PASSWORD) return false;
  const tmp = require('os').tmpdir();
  const tmpProfile = path.join(tmp, 'sd_stock_autologin_profile_' + Date.now());
  // Decide whether to try a headless stealth login or a visible login
  const tryHeadlessStealth = (process.env.REFRESH_HEADLESS === 'true' && process.env.REFRESH_TRY_HEADLESS_LOGIN === 'true' && puppeteerExtra);

  const commonArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'];
  let browser;
  if (tryHeadlessStealth) {
    const launchOptions = { headless: true, args: commonArgs };
    if (process.env.CHROME_PATH) launchOptions.executablePath = process.env.CHROME_PATH;
    browser = await puppeteerExtra.launch(launchOptions);
  } else {
    const launchOptions = { headless: false, args: commonArgs, userDataDir: tmpProfile };
    if (process.env.CHROME_PATH) launchOptions.executablePath = process.env.CHROME_PATH;
    browser = await puppeteer.launch(launchOptions);
  }
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36');
  try {
    await page.goto('https://store.steampowered.com/login/', { waitUntil: 'networkidle2', timeout: REFRESH_TIMEOUT_MS });
    // reuse the simple find/type logic
    // For the temporary visible login flow we also use the same smarter finder
    async function findBestAndType(pageRoot, selectors, value) {
      const list = selectors.split(',').map(s => s.trim()).filter(Boolean);
      const candidates = [];

      for (const sel of list) {
        try {
          const handles = await pageRoot.$$(sel);
          for (const h of handles) candidates.push(h);
        } catch (e) {}
      }
      for (const frame of pageRoot.frames()) {
        for (const sel of list) {
          try {
            const handles = await frame.$$(sel);
            for (const h of handles) candidates.push(h);
          } catch (e) {}
        }
      }
      if (candidates.length === 0) return false;
      const scored = [];
      for (const h of candidates) {
        try {
          const score = await h.evaluate((node) => {
            const lower = (s) => (s || '').toString().toLowerCase();
            const aria = lower(node.getAttribute('aria-label') || '');
            const name = lower(node.getAttribute('name') || '');
            const id = lower(node.id || '');
            const placeholder = lower(node.getAttribute('placeholder') || '');
            if (aria.includes('search') || name.includes('search') || placeholder.includes('buscar') || id.includes('search')) return -1000;
            let score = 0;
            if (/user|usuario|email|mail|account|login|nombre/.test(name)) score += 30;
            if (/user|usuario|email|mail|account|login|nombre/.test(id)) score += 20;
            if (/user|usuario|email|mail|account|login|nombre/.test(placeholder)) score += 15;
            if (node.type === 'password') score += 40;
            const form = node.closest('form');
            if (form) {
              if (form.querySelector('button[type="submit"], input[type="submit"]')) score += 40;
              const ftxt = lower(form.innerText || '');
              if (/sign in|signin|iniciar sesión|entrar|acceder/.test(ftxt)) score += 30;
              if (/login|signin|auth|account/.test(form.className || '')) score += 20;
            }
            const anc = lower((node.closest && node.closest('div') && node.closest('div').className) || '');
            if (/login|signin|auth|account/.test(anc)) score += 10;
            return score;
          });
          scored.push({ handle: h, score });
        } catch (e) {}
      }
      scored.sort((a, b) => b.score - a.score);
      if (scored.length === 0 || scored[0].score <= 0) return false;
      try { await scored[0].handle.focus(); await scored[0].handle.type(value, { delay: 50 }); return scored[0].handle; } catch (e) { return false; }
    }
    const usHandle = await findBestAndType(page, '#input_username, input[name="username"], input[type="text"]', process.env.STEAM_USERNAME);
    const pwHandle = await findBestAndType(page, '#input_password, input[name="password"], input[type="password"]', process.env.STEAM_PASSWORD);
    if (pwHandle) {
      try { await submitLogin(page, pwHandle, sendDebug); } catch (e) {}
    }
    try {
      await page.waitForFunction(() => {
        const selectors = ['#account_pulldown .name', '.user_persona_name', '.persona_name', '.account_name'];
        return selectors.some(s => !!document.querySelector(s));
      }, { timeout: REFRESH_DONE_TIMEOUT_MS });
    } catch (e) {}
    const cookies = await page.cookies();
    try { fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2)); } catch (e) {}
    await browser.close();
    return cookies && cookies.length > 0;
  } catch (e) {
    try { await browser.close(); } catch (_) {}
    return false;
  }
}

// Simple map to wait for interactive /done per chat
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
