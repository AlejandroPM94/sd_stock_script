const puppeteer = require('puppeteer');

const URL = 'https://store.steampowered.com/sale/steamdeckrefurbished';

(async () => {
    const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36');
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });

    try {
        // Esperar un poco para que el contenido dinámico se estabilice
        // pequeña espera independiente de la API de Puppeteer
        await new Promise(resolve => setTimeout(resolve, 2000));

        const data = await page.evaluate(() => {
            function findAncestorByHint(el) {
                let cur = el;
                for (let i = 0; i < 6 && cur; i++, cur = cur.parentElement) {
                    if (!cur) break;
                    const cls = (cur.className || '').toString();
                    if (/sale|row|item|listing|product|store|card|result|entry|container/i.test(cls)) return cur;
                }
                return el.parentElement || el;
            }

            // Buscar elementos que contengan exactamente 'Sin existencias' o similar
            const labels = Array.from(document.querySelectorAll('button, a, span, div')).filter(n => {
                const t = (n.innerText || '').trim();
                return /^(Sin existenci|Sin existencias|Sin stock|Out of stock|Sold out)/i.test(t);
            });

            // Si no encuentra exactos, buscar por texto parcial
            if (labels.length === 0) {
                const partial = Array.from(document.querySelectorAll('*')).filter(n => /(Sin existenci|Sin existencias|Sin stock|Out of stock|Sold out)/i.test(n.innerText || ''));
                return partial.slice(0, 10).map(n => ({
                    tag: n.tagName,
                    class: n.className || null,
                    text: (n.innerText||'').trim().slice(0,120),
                    outer: (n.outerHTML || '').slice(0,400)
                }));
            }

            const out = [];
            for (const lbl of labels) {
                const anc = findAncestorByHint(lbl);
                const titleEl = anc.querySelector('.tab_item_name, .title, .search_name, h2, h3, .sale_title, .store_sale_title, .sale_row_title');
                const priceEl = anc.querySelector('.discount_final_price, .price, .game_purchase_price, .search_price, .store_price, .sale_price');

                out.push({
                    labelTag: lbl.tagName,
                    labelClass: lbl.className || null,
                    labelText: (lbl.innerText||'').trim(),
                    containerTag: anc.tagName,
                    containerClass: anc.className || null,
                    title: titleEl ? (titleEl.innerText||'').trim() : (anc.querySelector('a') ? (anc.querySelector('a').innerText||'').trim() : null),
                    price: priceEl ? (priceEl.innerText||'').trim() : null,
                    containerSnippet: (anc.outerHTML||'').slice(0,600)
                });
            }

            return out;
        });

        console.log('Items encontrados con etiquetas "Sin existencias" (muestra):\n');
        if (!data || data.length === 0) {
            console.log('No se encontraron elementos con texto "Sin existencias".');
        } else {
            data.forEach((d, i) => {
                console.log(`#${i+1}`);
                console.log(' Label:', d.labelTag, d.labelClass, '->', d.labelText);
                console.log(' Container:', d.containerTag, d.containerClass);
                console.log(' Title:', d.title);
                console.log(' Price:', d.price);
                console.log(' Snippet:', d.containerSnippet.replace(/\n/g,' ').slice(0,300));
                console.log('---');
            });
        }

    } catch (err) {
        console.error('Error en debug:', err);
    } finally {
        await browser.close();
    }
})();
