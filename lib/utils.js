const fs = require('fs');
const path = require('path');
const os = require('os');

let sharedBrowser = null;

async function getOrLaunchBrowser({ puppeteer, puppeteerExtra, launchOptions = {}, usePuppeteerExtra = false, reuse = true } = {}) {
  try {
    if (reuse && sharedBrowser && sharedBrowser.isConnected && sharedBrowser.isConnected()) return sharedBrowser;
  } catch (e) {}
  let browser;
  if (usePuppeteerExtra && puppeteerExtra && puppeteerExtra.launch) {
    browser = await puppeteerExtra.launch(launchOptions);
  } else {
    browser = await puppeteer.launch(launchOptions);
  }
  if (reuse) sharedBrowser = browser;
  return browser;
}

async function closeSharedBrowser() {
  try {
    if (sharedBrowser) {
      await sharedBrowser.close();
      sharedBrowser = null;
    }
  } catch (e) {
    // ignore
  }
}

// findBestAndType: generic input finder with scoring to avoid search boxes
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

// submitLogin: tries to submit using a password handle's ancestor form, falling back and optionally calling sendDebug(png, html)
async function submitLogin(rootPage, passwordHandle = null, sendDebug = null, DEBUG_DIR = path.join(process.cwd(), 'debug')) {
  const fsLocal = fs;
  try {
    if (passwordHandle) {
      try {
        const formHandle = (await passwordHandle.evaluateHandle(node => node.closest && node.closest('form') || null)).asElement();
        if (formHandle) {
          let candidates = await formHandle.$$('button[type="submit"], input[type="submit"], button, input[type="button"]');
          if (candidates.length === 0) candidates = await formHandle.$$('a');
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
              try {
                const info = await chosen.evaluate(n => ({ tag: n.tagName, text: n.innerText || n.value || '', id: n.id || null, cls: n.className || null }));
                // console.log('Attempting click on submit candidate:', info);
              } catch (e) {}
              await chosen.click({ delay: 50 });
              try {
                await rootPage.waitForFunction(() => {
                  const selectors = ['#account_pulldown .name', '.user_persona_name', '.persona_name', '.account_name'];
                  return selectors.some(s => !!document.querySelector(s));
                }, { timeout: 4000 });
                return true;
              } catch (e) {}
            } catch (e) {
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
                  } catch (e) {}
                }
              } catch (e2) {}
            }
          }
          try { await formHandle.evaluate(f => { try { f.submit(); } catch (e) {} }); return true; } catch (e) {}
        }
      } catch (e) {}
    }
    const signSelectors = ['#login_btn_signin', 'button[type="submit"]', 'button#login_btn_signin', '.login_btn', '.auth_button', '.btn_green_white_innerfade.btn_medium'];
    for (const sel of signSelectors) {
      try { const el = await rootPage.$(sel); if (el) { try { await el.click({ delay: 50 }); return true; } catch (e) {} } } catch (e) {}
    }
    for (const frame of rootPage.frames()) {
      for (const sel of signSelectors) {
        try { const el = await frame.$(sel); if (el) { try { await el.click({ delay: 50 }); return true; } catch (e) {} } } catch (e) {}
      }
    }
    // capture debug
    try {
      if (sendDebug && typeof sendDebug === 'function') {
        try {
          if (!fsLocal.existsSync(DEBUG_DIR)) fsLocal.mkdirSync(DEBUG_DIR, { recursive: true });
          const ts = Date.now();
          const png = path.join(DEBUG_DIR, `failed_submit_${ts}.png`);
          const html = path.join(DEBUG_DIR, `failed_submit_${ts}.html`);
          await rootPage.screenshot({ path: png, fullPage: true }).catch(() => {});
          const content = await rootPage.content().catch(() => '');
          try { fsLocal.writeFileSync(html, content); } catch (e) {}
          await sendDebug(png, html);
        } catch (e) { /* ignore */ }
      }
    } catch (e) {}
    return false;
  } catch (e) { return false; }
}

// waitForLoginUI: try variety of selectors and triggers
async function waitForLoginUI(rootPage, timeout = 30000) {
  const loginSelectors = ['input[type="password"]', 'input[type="text"]', 'form[action*="login"]', '#login_area', '#login_form', '.newlogindialog'];
  for (const sel of loginSelectors) {
    try { await rootPage.waitForSelector(sel, { timeout }); return true; } catch (e) {}
  }
  for (const frame of rootPage.frames()) {
    for (const sel of loginSelectors) {
      try { await frame.waitForSelector(sel, { timeout: 2000 }); return true; } catch (e) {}
    }
  }
  const triggerSelectors = ['a[href*="login"], a[href*="/login/"], .global_action_link, .login_link, .login', 'button[data-ga="header_signin"]'];
  for (const t of triggerSelectors) {
    try {
      const el = await rootPage.$(t);
      if (el) {
        try { await el.click(); } catch (e) {}
        for (const sel of loginSelectors) {
          try { await rootPage.waitForSelector(sel, { timeout: 3000 }); return true; } catch (e) {}
        }
      }
    } catch (e) {}
  }
  return false;
}

// saveDebugArtifacts: save screenshot and html to DEBUG_DIR and return paths
async function saveDebugArtifacts(page, DEBUG_DIR = path.join(process.cwd(), 'debug')) {
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const ts = Date.now();
    const png = path.join(DEBUG_DIR, `failed_${ts}.png`);
    const html = path.join(DEBUG_DIR, `failed_${ts}.html`);
    await page.screenshot({ path: png, fullPage: true }).catch(() => {});
    const content = await page.content().catch(() => '');
    try { fs.writeFileSync(html, content); } catch (e) {}
    return { png, html };
  } catch (e) { return {}; }
}

module.exports = {
  getOrLaunchBrowser,
  closeSharedBrowser,
  findBestAndType,
  submitLogin,
  waitForLoginUI,
  saveDebugArtifacts
};
