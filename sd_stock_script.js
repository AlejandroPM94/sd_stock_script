const puppeteer = require('puppeteer');

const URL = 'https://store.steampowered.com/sale/steamdeckrefurbished';

async function fetchStock(url = URL) {
    // Opciones para soporte de sesión
    const userDataDir = process.env.USER_DATA_DIR; // si se proporciona, Puppeteer usará este perfil (permite sesión persistente)
    const cookiesFile = process.env.COOKIES_FILE || 'cookies.json'; // si existe, cargaremos cookies
    const headlessEnv = process.env.HEADLESS; // 'true'|'false'
    const headless = headlessEnv ? (headlessEnv === 'true' || headlessEnv === '1') : true;

    const launchOptions = { args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--lang=es-ES,es',
        '--window-size=1366,768'
    ], headless };
    if (userDataDir) launchOptions.userDataDir = userDataDir;
    // Permitir especificar un ejecutable de Chrome/Chromium (útil para usar perfil de Chrome real)
    const chromePath = process.env.CHROME_PATH || process.env.CHROME_EXECUTABLE || process.env.CHROME_BIN;
    if (chromePath) launchOptions.executablePath = chromePath;

    const browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();
    // Si hay un fichero de cookies y no estamos usando userDataDir, intentar cargar cookies
    if (!userDataDir) {
        try {
            const fs = require('fs');
            if (fs.existsSync(cookiesFile)) {
                const raw = fs.readFileSync(cookiesFile, 'utf8');
                let cookies = JSON.parse(raw);
                if (Array.isArray(cookies) && cookies.length) {
                    // Normalizar formatos: asegurarse de que expires sea entero o no esté definido
                    cookies = cookies.map(c => ({
                        name: c.name,
                        value: c.value,
                        domain: c.domain,
                        path: c.path || '/',
                        expires: (c.expires && !isNaN(c.expires) && Number(c.expires) > 0) ? Math.floor(Number(c.expires)) : undefined,
                        httpOnly: !!c.httpOnly,
                        secure: !!c.secure,
                        sameSite: c.sameSite
                    }));

                    // Navegar al dominio del primer cookie antes de aplicar cookies para asegurar que se puedan establecer correctamente
                    try {
                        const firstDomain = cookies[0] && cookies[0].domain ? cookies[0].domain.replace(/^\./, '') : null;
                        if (firstDomain) {
                            const gotoRoot = `https://${firstDomain}/`;
                            await page.goto(gotoRoot, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
                        }
                    } catch (e) {
                        // no bloquear si la navegación inicial falla
                    }

                    // Aplicar cookies y luego verificar cuáles quedaron aplicadas
                    try {
                        await page.setCookie(...cookies);
                        console.log(`Cookies cargadas desde ${cookiesFile} (count=${cookies.length})`);
                        const applied = await page.cookies();
                        console.log('Cookies aplicadas en la página:', applied.map(a => `${a.name}@${a.domain}`).join(', '));
                    } catch (e) {
                        console.warn('Error aplicando cookies en la página:', e && e.message ? e.message : e);
                    }
                }
            }
        } catch (e) {
            console.warn('No se pudieron cargar cookies:', e.message || e);
        }
    }
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36');
    const targetUrl = url || URL;
    console.log('Navegando a:', targetUrl);
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    // Si se desea iniciar sesión manualmente, soportar modo interactivo:
    // - si se define WAIT_SELECTOR, esperará a ese selector (útil para detectar elemento de cuenta)
    // - si se define WAIT_FOR_LOGIN=true, esperará a que el usuario pulse ENTER en la terminal
    const waitSelector = process.env.WAIT_SELECTOR;
    if (waitSelector) {
        try {
            console.log('Esperando selector de login:', waitSelector);
            await page.waitForSelector(waitSelector, { timeout: 120000 });
            console.log('Selector detectado, continuando.');
            await page.reload({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        } catch (e) {
            console.warn('No se detectó el selector dentro del tiempo:', e && e.message ? e.message : e);
        }
    } else if (process.env.WAIT_FOR_LOGIN === 'true') {
        console.log('Modo interactivo: abre el navegador. Inicia sesión manualmente y pulsa ENTER en esta terminal cuando hayas terminado.');
        await new Promise((resolve) => {
            process.stdin.resume();
            process.stdin.once('data', () => {
                process.stdin.pause();
                resolve();
            });
        });
        await page.reload({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    }

    // Esperar selectores comunes de items (si existen)
    try {
        await page.waitForSelector('.tab_item, .search_result_row, .sale_row, .discount_row', { timeout: 8000 });
    } catch (e) {
        // puede que la página tenga otra estructura; seguiremos igualmente
    }

    const results = await page.evaluate(() => {
        const STOCK_RE = /(agotad|sin existenci|sin existencias|sold out|out of stock|no disponible|unavailable)/i;
        const AVAILABLE_RE = /(add to cart|add to basket|añadir al carrito|añadir a la cesta|comprar|buy now|buy|available|in stock|available for purchase)/i;

        // Buscar contenedores de oferta conocidos (incluye clase legible 'SaleSectionContainer')
        const containers = Array.from(document.querySelectorAll('.SaleSectionContainer, .tab_item, .sale_row, .store_sale_row, .discount_row, .search_result_row'));

        const seen = new Set();
        const items = [];

        // helper: buscar primer texto que parezca título (contenga 'Steam Deck')
        function findTitleWithin(node) {
            const candidates = Array.from(node.querySelectorAll('*'));
            for (const c of candidates) {
                const t = (c.innerText || '').trim();
                if (/Steam\s*Deck/i.test(t) && t.length < 200) return t;
            }
            // fallback: buscar h2/h3
            const h = node.querySelector('h2,h3');
            if (h) return (h.innerText||'').trim();
            return null;
        }

        function findPriceWithin(node) {
            const priceText = (node.innerText || '').match(/\d+[\.,]\d{2}\s*€/);
            if (priceText) return priceText[0];
            const priceEl = node.querySelector('.discount_final_price, .price, .game_purchase_price, .search_price, .StoreSalePriceWidgetContainer, .StoreSalePriceWidgetContainer *');
            if (priceEl) return (priceEl.innerText||'').trim();
            return null;
        }

        for (const container of containers) {
            const text = (container.innerText || '').trim();
            if (!text) continue;

            const title = findTitleWithin(container) || (container.querySelector('a') ? (container.querySelector('a').innerText||'').trim() : null);
            if (!title) continue;
            if (seen.has(title)) continue;
            seen.add(title);

            const price = findPriceWithin(container);

            let availability = 'posible stock';
            if (STOCK_RE.test(text)) availability = 'sin stock';
            // detectar botón o div con clase CartBtn
            const cartBtn = container.querySelector('.CartBtn, .cart_btn, .add_to_cart, .add_to_cart_button');
            if (cartBtn) {
                const btnText = (cartBtn.innerText||'').trim();
                if (/Sin existenci/i.test(btnText)) availability = 'sin stock';
                else if (AVAILABLE_RE.test(btnText)) availability = 'en stock';
            }

            // si aparece texto claro de compra
            if (AVAILABLE_RE.test(text)) availability = 'en stock';

            // url
            let url = null;
            const a = container.querySelector('a[href*="/app/"], a[href*="/sub/"]');
            if (a) url = a.href;

            items.push({ title, price, url, availability });
        }

        if (items.length === 0) {
            // fallback: buscar botones de 'Sin existencias' y obtener sus ancestros
            const buttons = Array.from(document.querySelectorAll('div')).filter(d => /(Sin existenci|Sin existencias)/i.test((d.innerText||'').trim()));
            return buttons.slice(0,5).map(b => ({ title: document.title || 'Página', price: null, url: location.href, availability: 'sin stock (detected via button)' }));
        }

        return items;
    });

    // Si se pide, guardar cookies después de la carga (útil tras iniciar sesión manualmente)
    try {
        const fs = require('fs');
        const cookiesFile = process.env.COOKIES_FILE || 'cookies.json';
        if (process.env.SAVE_COOKIES === 'true') {
            try {
                const cookies = await page.cookies();
                fs.writeFileSync(cookiesFile, JSON.stringify(cookies, null, 2));
                console.log('Cookies guardadas en', cookiesFile, `(userDataDir ${userDataDir ? 'usado' : 'no usado'})`);
                const steamCookies = cookies.filter(c => /steam|steampowered/i.test(c.domain));
                if (steamCookies.length) {
                    console.log(`Se han guardado ${steamCookies.length} cookie(s) relacionadas con Steam. Ejemplos: ${steamCookies.slice(0,3).map(c=>c.name).join(', ')}`);
                } else {
                    console.log('No se detectaron cookies de Steam en la lista guardada.');
                }
            } catch (e) {
                console.warn('Error al obtener/escribir cookies:', e && e.message ? e.message : e);
            }
        }
    } catch (e) {
        // no bloquear por fallos al guardar cookies
        console.warn('No se pudieron guardar cookies (FS):', e && e.message ? e.message : e);
    }

    // Intentar detectar el nombre de usuario actualmente mostrado en la página (si existe)
    // y comprobar cookies para deducir si hay sesión activa. Si se define FAIL_IF_NOT_LOGGED=true,
    // fallaremos con código 4 cuando no se detecte sesión.
    try {
        const cookies = await page.cookies();
        const steamCookie = cookies.find(c => /steamLoginSecure|steamLogin/i.test(c.name));

        const accountName = await page.evaluate(() => {
            const selectors = ['#account_pulldown .name', '#account_pulldown', '.user_persona_name', '.persona_name', '.account_name', '.user_name', '.global_actions .header_account_area .name'];
            for (const s of selectors) {
                const el = document.querySelector(s);
                if (el) {
                    const text = (el.innerText || el.textContent || '').trim();
                    if (text) return text;
                }
            }
            const link = document.querySelector('a[href*="steamcommunity.com/id/"], a[href*="steamcommunity.com/profiles/"]');
            if (link) return (link.innerText || link.textContent || '').trim();
            return null;
        });

        let loggedIn = false;
        if (accountName) {
            console.log('Usuario detectado en la página:', accountName);
            loggedIn = true;
        }
        if (steamCookie) {
            console.log('Cookie de Steam detectada:', steamCookie.name, `(dominio: ${steamCookie.domain})`);
            loggedIn = true;
        }
        if (!loggedIn) {
            console.warn('Advertencia: no parece haber una sesión iniciada en Steam (no se detectó usuario ni cookie de sesión).');
            if (process.env.FAIL_IF_NOT_LOGGED === 'true') {
                console.error('FAIL_IF_NOT_LOGGED=true: lanzando error NotLoggedIn.');
                try { await browser.close(); } catch (e) {}
                const err = new Error('NotLoggedIn: no session detected');
                err.code = 'NOT_LOGGED_IN';
                throw err;
            }
        }
    } catch (e) {
        // Si lanzamos explícitamente el error de 'NOT_LOGGED_IN', re-lanzarlo
        if (e && (e.code === 'NOT_LOGGED_IN' || (typeof e.message === 'string' && e.message.indexOf('NotLoggedIn') === 0))) {
            throw e;
        }
        // no bloquear por otros fallos de detección
        console.warn('Error durante la comprobación de sesión:', e && e.message ? e.message : e);
    }

    await browser.close();
    return results;
}

module.exports = { fetchStock };

if (require.main === module) {
    (async () => {
        try {
            const items = await fetchStock(URL);

            if (!items || items.length === 0) {
                console.log('No se detectaron productos en la página.');
                process.exitCode = 2;
                return;
            }

            let anyAvailable = false;
            console.log('Resultados de stock para:', URL);
            for (const it of items) {
                const avail = it.availability || 'desconocido';
                console.log(`- ${it.title} | ${it.price || 'precio no detectado'} | ${avail}`);
                if (!/sin stock/i.test(avail)) anyAvailable = true;
            }

            if (anyAvailable) {
                console.log('\nAl menos un producto podría estar disponible.');
                process.exitCode = 0;
            } else {
                console.log('\nParece que no hay stock disponible.');
                process.exitCode = 1;
            }
        } catch (err) {
            console.error('Error al comprobar stock:', err);
            process.exitCode = 3;
        }
    })();
}