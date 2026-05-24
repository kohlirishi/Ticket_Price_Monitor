const https = require('https');
const http = require('http');
const zlib = require('zlib');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());

const USD_TO_CAD = 1.36;
const DELAY_BETWEEN_SITES_MS = 2000; // 2s between sites — saves ~24s per full cycle
const SCRAPER_CONCURRENCY = 2;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Plain HTTP fetch — no Puppeteer, works for SSR/API endpoints
function fetchUrl(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-CA,en;q=0.9',
        ...extraHeaders,
      },
      timeout: 15000,
    }, res => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return fetchUrl(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', chunk => { chunks.push(chunk); });
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
        const done = (err, decoded) => {
          if (err) return reject(err);
          resolve({ status: res.statusCode, body: decoded.toString('utf8'), headers: res.headers });
        };
        if (encoding.includes('br')) return zlib.brotliDecompress(raw, done);
        if (encoding.includes('gzip')) return zlib.gunzip(raw, done);
        if (encoding.includes('deflate')) return zlib.inflate(raw, done);
        done(null, raw);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

async function launchBrowser() {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--no-first-run',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--hide-scrollbars',
    '--mute-audio',
    '--window-size=1280,800',
  ];

  try {
    const chromium = require('@sparticuz/chromium');
    const execPath = await chromium.executablePath();
    return await puppeteerExtra.launch({
      args: [...chromium.args, ...args],
      defaultViewport: { width: 1280, height: 800 },
      executablePath: execPath,
      headless: true,
      ignoreHTTPSErrors: true,
    });
  } catch {
    const localPaths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ];
    for (const execPath of localPaths) {
      try {
        return await puppeteerExtra.launch({ args, executablePath: execPath, headless: true, ignoreHTTPSErrors: true });
      } catch { /* try next */ }
    }
    throw new Error('No Chrome/Chromium found.');
  }
}

async function newPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-CA,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  });
  // Block only images and media — keep CSS/JS so pages render fully
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['image', 'media'].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });
  return page;
}

function extractLowestPrice(texts) {
  const prices = [];
  for (const text of texts) {
    if (!text) continue;
    for (const m of String(text).matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g)) {
      const n = parseFloat(m[1].replace(/,/g, ''));
      if (n > 0 && n < 25000) prices.push(n);
    }
  }
  return prices.length ? Math.min(...prices) : null;
}

function extractEmbeddedPrice(html) {
  const patterns = [
    /"lowPrice"\s*:\s*"?([\d.]+)"?/gi,
    /"minPrice"\s*:\s*"?([\d.]+)"?/gi,
    /"lowestPrice"\s*:\s*"?([\d.]+)"?/gi,
    /"startingPrice"\s*:\s*"?([\d.]+)"?/gi,
    /"basePrice"\s*:\s*"?([\d.]+)"?/gi,
    /"price"\s*:\s*"?([\d.]+)"?/gi,
    /from\s+\$\s*([\d,]+(?:\.\d{1,2})?)/gi,
  ];
  const prices = [];
  for (const rx of patterns) {
    for (const m of html.matchAll(rx)) {
      const p = parseFloat(m[1].replace(/,/g, ''));
      if (p > 0 && p < 25000) prices.push(p);
    }
  }
  return prices.length ? Math.min(...prices) : null;
}

function extractVividProductionId(url) {
  const match = String(url || '').match(/\/production\/(\d+)/);
  return match ? match[1] : null;
}

// Extract lowest price from JSON-LD structured data
function extractJsonLdPrice(html) {
  const matches = html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  const prices = [];
  for (const m of matches) {
    try {
      const data = JSON.parse(m[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const offers = item.offers ? (Array.isArray(item.offers) ? item.offers : [item.offers]) : [];
        for (const o of offers) {
          const p = parseFloat(o.price || o.lowPrice || 0);
          if (p > 0) prices.push(p);
        }
      }
    } catch { /* ignore */ }
  }
  return prices.length ? Math.min(...prices) : null;
}

async function isBlocked(page) {
  return page.evaluate(() => {
    const t = document.title.toLowerCase();
    const b = document.body ? document.body.innerText.toLowerCase() : '';
    return (
      t.includes('just a moment') ||
      t.includes('attention required') ||
      t.includes('access denied') ||
      b.includes('enable javascript and cookies') ||
      b.includes('cf-browser-verification')
    );
  });
}

// ─── Ticketmaster CA ────────────────────────────────────────────────────────
async function scrapeTicketmaster(browser, event) {
  const meta = { name: 'Ticketmaster', platform: 'ticketmaster', currency: 'CAD', url: event.ticketmasterUrl };

  // Step 1: plain HTTP fetch — fast, no bot detection for initial HTML
  try {
    const { status, body } = await fetchUrl(event.ticketmasterUrl);
    if (status === 401 || status === 403) {
      return { ...meta, price: null, status: 'unavailable', note: 'Bot protection — check manually', lastUpdated: new Date().toISOString() };
    }

    // JSON-LD (most reliable — TM embeds structured event data)
    const jsonLdPrice = extractJsonLdPrice(body);
    if (jsonLdPrice) {
      console.log('[Ticketmaster] JSON-LD price:', jsonLdPrice);
      return { ...meta, price: jsonLdPrice, status: 'available', lastUpdated: new Date().toISOString() };
    }

    // __NEXT_DATA__ or embedded JSON price patterns
    const patterns = [
      /"minPrice"\s*:\s*([\d.]+)/,
      /"lowestPrice"\s*:\s*([\d.]+)/,
      /"startingPrice"\s*:\s*([\d.]+)/,
      /"basePrice"\s*:\s*([\d.]+)/,
      /from\s+\$\s*([\d,]+)/i,
      /"price"\s*:\s*"?([\d.]+)"?/,
    ];
    for (const rx of patterns) {
      const m = body.match(rx);
      if (m) {
        const p = parseFloat(m[1].replace(/,/g, ''));
        if (p > 0 && p < 25000) {
          console.log('[Ticketmaster] regex price:', p);
          return { ...meta, price: p, status: 'available', lastUpdated: new Date().toISOString() };
        }
      }
    }
  } catch (err) {
    console.warn('[Ticketmaster] fetch failed, falling back to Puppeteer:', err.message);
  }

  // Step 2: Puppeteer fallback with stealth
  let page;
  try {
    page = await newPage(browser);
    await page.goto(event.ticketmasterUrl, { waitUntil: 'networkidle2', timeout: 25000 });
    await sleep(2500);

    const html = await page.content();
    const jsonLdPrice = extractJsonLdPrice(html);
    if (jsonLdPrice) return { ...meta, price: jsonLdPrice, status: 'available', lastUpdated: new Date().toISOString() };

    const texts = await page.evaluate(() => {
      const found = [];
      for (const sel of [
        '[data-testid*="price"]', '[data-tid*="price"]',
        '[class*="price-range"]', '[class*="priceRange"]',
        '[class*="lowest-price"]', '[class*="lowestPrice"]',
        '[class*="ticket-price"]', '[class*="ticketPrice"]',
        '[aria-label*="from $"]', '.price', '.priceSummary',
      ]) {
        for (const el of document.querySelectorAll(sel)) {
          const t = el.textContent.trim();
          if (t.includes('$') && /\d/.test(t)) found.push(t);
        }
      }
      const pageText = document.body.innerText;
      found.push(...(pageText.match(/(from|starting at|as low as)\s+\$\s*[\d,]+/gi) || []));
      found.push(...(pageText.match(/\$\s*[\d,]+(?:\.\d{2})?/g) || []).slice(0, 15));
      return found;
    });

    const price = extractLowestPrice(texts);
    return { ...meta, price, status: price ? 'available' : 'unavailable', note: price ? null : 'Visit site to check prices', lastUpdated: new Date().toISOString() };
  } catch (err) {
    console.error('[Ticketmaster]', err.message);
    return { ...meta, price: null, status: 'unavailable', note: 'Scrape failed — check manually', lastUpdated: new Date().toISOString() };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ─── StubHub CA ─────────────────────────────────────────────────────────────
async function scrapeStubHub(browser, event) {
  const query = encodeURIComponent(event.name + ' Toronto');
  const meta = { name: 'StubHub', platform: 'stubhub', currency: 'CAD', url: `https://www.stubhub.ca/search?q=${query}` };
  let page;
  try {
    page = await newPage(browser);
    // networkidle2 + long wait gives stealth time to pass JS challenge
    await page.goto(meta.url, { waitUntil: 'networkidle2', timeout: 25000 });
    await sleep(2500);

    if (await isBlocked(page)) {
      return { ...meta, price: null, status: 'unavailable', note: 'Bot protection — check manually', lastUpdated: new Date().toISOString() };
    }

    // JSON-LD first
    const html = await page.content();
    const jsonLdPrice = extractJsonLdPrice(html);
    if (jsonLdPrice) {
      return { ...meta, price: jsonLdPrice, status: 'available', lastUpdated: new Date().toISOString() };
    }

    const texts = await page.evaluate(() => {
      const found = [];
      for (const sel of [
        '[data-testid*="price"]', '[class*="price"]', '[class*="Price"]',
        '[class*="ticket"]', '[class*="listing"]', '.price',
      ]) {
        for (const el of document.querySelectorAll(sel)) {
          const t = el.textContent.trim();
          if (t.includes('$') && /\d/.test(t)) found.push(t);
        }
      }
      // Broad sweep
      const broad = document.body.innerText.match(/\$\s*[\d,]+(?:\.\d{2})?/g) || [];
      found.push(...broad.slice(0, 20));
      return found;
    });

    const price = extractLowestPrice(texts);
    return { ...meta, price, status: price ? 'available' : 'unavailable', note: price ? null : 'Bot protection — check manually', lastUpdated: new Date().toISOString() };
  } catch (err) {
    console.error('[StubHub]', err.message);
    return { ...meta, price: null, status: 'unavailable', note: 'Bot protection — check manually', lastUpdated: new Date().toISOString() };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ─── VividSeats ──────────────────────────────────────────────────────────────
async function scrapeVividSeats(browser, event) {
  const url = event.vividSeatsUrl || `https://www.vividseats.com/search?searchTerm=${encodeURIComponent(event.name)}`;
  const meta = { name: 'VividSeats', platform: 'vividseats', currency: 'USD', url };

  const productionId = extractVividProductionId(event.vividSeatsUrl);
  if (productionId) {
    try {
      const apiUrl = `https://www.vividseats.com/hermes/api/v1/productions/${productionId}`;
      const { status, body } = await fetchUrl(apiUrl, { Accept: 'application/json' });
      if (status === 200) {
        const data = JSON.parse(body);
        const lowestUsd = data.minAipPrice || data.minPrice || data.avgPrice || null;
        if (lowestUsd) {
          const cadPrice = Math.round(lowestUsd * USD_TO_CAD * 100) / 100;
          return {
            ...meta, price: lowestUsd, priceCAD: cadPrice,
            currencyNote: `≈ CAD $${cadPrice.toFixed(2)} (est. 1 USD = 1.36 CAD)`,
            status: 'available', lastUpdated: new Date().toISOString(),
          };
        }
      }
    } catch (err) {
      console.warn('[VividSeats] API failed, falling back to page fetch:', err.message);
    }
  }

  try {
    const { body } = await fetchUrl(url);
    const jsonLdPrice = extractJsonLdPrice(body);
    const lowestUsd = jsonLdPrice || extractEmbeddedPrice(body);
    if (lowestUsd) {
      const cadPrice = Math.round(lowestUsd * USD_TO_CAD * 100) / 100;
      return {
        ...meta, price: lowestUsd, priceCAD: cadPrice,
        currencyNote: `≈ CAD $${cadPrice.toFixed(2)} (est. 1 USD = 1.36 CAD)`,
        status: 'available', lastUpdated: new Date().toISOString(),
      };
    }
  } catch (err) {
    console.warn('[VividSeats] fetch failed, falling back to Puppeteer:', err.message);
  }

  let page;
  try {
    page = await newPage(browser);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
    await sleep(2500);

    const texts = await page.evaluate(() => {
      const found = [];
      for (const sel of [
        '[data-testid*="price"]', '[class*="listingPrice"]',
        '[class*="listing-price"]', '[class*="price"]', '[class*="Price"]',
      ]) {
        for (const el of document.querySelectorAll(sel)) {
          const t = el.textContent.trim();
          if (t.includes('$') && /\d/.test(t)) found.push(t);
        }
      }
      if (!found.length) {
        const raw = document.body.innerText.match(/\$\s*[\d,]+(?:\.\d{2})?/g) || [];
        found.push(...raw.slice(0, 20));
      }
      return found;
    });

    const lowestUsd = extractLowestPrice(texts);
    if (lowestUsd) {
      const cadPrice = Math.round(lowestUsd * USD_TO_CAD * 100) / 100;
      return {
        ...meta, price: lowestUsd, priceCAD: cadPrice,
        currencyNote: `≈ CAD $${cadPrice.toFixed(2)} (est. 1 USD = 1.36 CAD)`,
        status: 'available', lastUpdated: new Date().toISOString(),
      };
    }
    return { ...meta, price: null, status: 'unavailable', note: 'Visit site to check prices', lastUpdated: new Date().toISOString() };
  } catch (err) {
    console.error('[VividSeats]', err.message);
    return { ...meta, price: null, status: 'unavailable', note: 'Scrape failed — check manually', lastUpdated: new Date().toISOString() };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ─── Viagogo CA ──────────────────────────────────────────────────────────────
async function scrapeViagogo(browser, event) {
  const query = encodeURIComponent(event.name + ' Toronto');
  const meta = { name: 'Viagogo', platform: 'viagogo', currency: 'CAD', url: `https://www.viagogo.ca/search?q=${query}` };
  let page;
  try {
    page = await newPage(browser);
    await page.goto(meta.url, { waitUntil: 'networkidle2', timeout: 25000 });
    await sleep(2500);

    if (await isBlocked(page)) {
      return { ...meta, price: null, status: 'unavailable', note: 'Bot protection — check manually', lastUpdated: new Date().toISOString() };
    }

    // JSON-LD first
    const html = await page.content();
    const jsonLdPrice = extractJsonLdPrice(html);
    if (jsonLdPrice) {
      return { ...meta, price: jsonLdPrice, status: 'available', lastUpdated: new Date().toISOString() };
    }

    const texts = await page.evaluate(() => {
      const found = [];
      for (const sel of [
        '[class*="price"]', '[class*="Price"]', '[data-qa*="price"]',
        '[class*="ticket"]', '[class*="listing"]',
      ]) {
        for (const el of document.querySelectorAll(sel)) {
          const t = el.textContent.trim();
          if (t.includes('$') && /\d/.test(t)) found.push(t);
        }
      }
      const broad = document.body.innerText.match(/\$\s*[\d,]+(?:\.\d{2})?/g) || [];
      found.push(...broad.slice(0, 20));
      return found;
    });

    const price = extractLowestPrice(texts);
    return { ...meta, price, status: price ? 'available' : 'unavailable', note: price ? null : 'Bot protection — check manually', lastUpdated: new Date().toISOString() };
  } catch (err) {
    console.error('[Viagogo]', err.message);
    return { ...meta, price: null, status: 'unavailable', note: 'Bot protection — check manually', lastUpdated: new Date().toISOString() };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ─── SeatGeek — public JSON API (no key needed for basic queries) ─────────────
async function scrapeSeatGeek(browser, event) {
  const searchQuery = encodeURIComponent(event.name);
  const apiUrl = `https://api.seatgeek.com/2/events?q=${searchQuery}&venue.city=Toronto&per_page=10&sort=datetime_local.asc`;
  const webUrl = `https://seatgeek.com/search?q=${searchQuery}`;
  const meta = { name: 'SeatGeek', platform: 'seatgeek', currency: 'CAD', url: webUrl };

  // Step 1: SeatGeek public API
  try {
    const { status, body } = await fetchUrl(apiUrl, { Accept: 'application/json' });
    if (status === 200) {
      const data = JSON.parse(body);
      const events = (data.events || []).filter(e =>
        e.stats && (e.stats.lowest_price || e.stats.average_price)
      );
      if (events.length > 0) {
        // Pick closest upcoming event
        const ev = events[0];
        const price = ev.stats.lowest_price || ev.stats.average_price;
        console.log('[SeatGeek] API price:', price, ev.url);
        return {
          ...meta,
          price,
          url: ev.url || webUrl,
          status: 'available',
          lastUpdated: new Date().toISOString(),
        };
      }
    }
  } catch (err) {
    console.warn('[SeatGeek] API failed:', err.message);
  }

  // Step 2: Puppeteer fallback
  let page;
  try {
    page = await newPage(browser);
    await page.goto(webUrl, { waitUntil: 'networkidle2', timeout: 25000 });
    await sleep(2500);

    const html = await page.content();
    const jsonLdPrice = extractJsonLdPrice(html);
    if (jsonLdPrice) return { ...meta, price: jsonLdPrice, status: 'available', lastUpdated: new Date().toISOString() };

    const texts = await page.evaluate(() => {
      const found = [];
      for (const sel of ['[data-testid*="price"]', '[class*="price"]', '[class*="Price"]', '[class*="event-card"]']) {
        for (const el of document.querySelectorAll(sel)) {
          const t = el.textContent.trim();
          if (t.includes('$') && /\d/.test(t)) found.push(t);
        }
      }
      found.push(...(document.body.innerText.match(/(from|tickets from|starting)\s+\$\s*[\d,]+/gi) || []));
      return found;
    });

    const price = extractLowestPrice(texts);
    return { ...meta, price, status: price ? 'available' : 'unavailable', note: price ? null : 'Visit site to check prices', lastUpdated: new Date().toISOString() };
  } catch (err) {
    console.error('[SeatGeek]', err.message);
    return { ...meta, price: null, status: 'unavailable', note: 'Scrape failed — check manually', lastUpdated: new Date().toISOString() };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ─── Gametime ─────────────────────────────────────────────────────────────────
async function scrapeGametime(browser, event) {
  const searchQuery = encodeURIComponent(event.name);
  const searchUrl = `https://gametime.co/search?query=${searchQuery}`;
  const meta = { name: 'Gametime', platform: 'gametime', currency: 'USD', url: searchUrl };

  // Step 1: plain fetch — look for JSON-LD or embedded price data
  try {
    const { body } = await fetchUrl(searchUrl);
    const jsonLdPrice = extractJsonLdPrice(body);
    if (jsonLdPrice) {
      const cadPrice = Math.round(jsonLdPrice * USD_TO_CAD * 100) / 100;
      return { ...meta, price: jsonLdPrice, priceCAD: cadPrice, currencyNote: `≈ CAD $${cadPrice.toFixed(2)} (est. 1 USD = 1.36 CAD)`, status: 'available', lastUpdated: new Date().toISOString() };
    }
    const patterns = [/"minPrice"\s*:\s*([\d.]+)/, /"lowestPrice"\s*:\s*([\d.]+)/, /"price"\s*:\s*"?([\d.]+)"?/];
    for (const rx of patterns) {
      const m = body.match(rx);
      if (m) {
        const p = parseFloat(m[1]);
        if (p > 0 && p < 25000) {
          const cadPrice = Math.round(p * USD_TO_CAD * 100) / 100;
          console.log('[Gametime] fetch price:', p);
          return { ...meta, price: p, priceCAD: cadPrice, currencyNote: `≈ CAD $${cadPrice.toFixed(2)} (est. 1 USD = 1.36 CAD)`, status: 'available', lastUpdated: new Date().toISOString() };
        }
      }
    }
  } catch (err) {
    console.warn('[Gametime] fetch failed:', err.message);
  }

  // Step 2: Puppeteer fallback
  let page;
  try {
    page = await newPage(browser);
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 25000 });
    await sleep(2500);
    if (await isBlocked(page)) return { ...meta, price: null, status: 'unavailable', note: 'Bot protection — check manually', lastUpdated: new Date().toISOString() };

    const html = await page.content();
    const jsonLdPrice = extractJsonLdPrice(html);
    if (jsonLdPrice) {
      const cadPrice = Math.round(jsonLdPrice * USD_TO_CAD * 100) / 100;
      return { ...meta, price: jsonLdPrice, priceCAD: cadPrice, currencyNote: `≈ CAD $${cadPrice.toFixed(2)} (est. 1 USD = 1.36 CAD)`, status: 'available', lastUpdated: new Date().toISOString() };
    }

    const texts = await page.evaluate(() => {
      const found = [];
      for (const sel of ['[data-testid*="price"]', '[class*="price"]', '[class*="Price"]', '[class*="ticket"]']) {
        for (const el of document.querySelectorAll(sel)) {
          const t = el.textContent.trim();
          if (t.includes('$') && /\d/.test(t)) found.push(t);
        }
      }
      found.push(...(document.body.innerText.match(/\$\s*[\d,]+(?:\.\d{2})?/g) || []).slice(0, 15));
      return found;
    });

    const lowestUsd = extractLowestPrice(texts);
    if (lowestUsd) {
      const cadPrice = Math.round(lowestUsd * USD_TO_CAD * 100) / 100;
      return { ...meta, price: lowestUsd, priceCAD: cadPrice, currencyNote: `≈ CAD $${cadPrice.toFixed(2)} (est. 1 USD = 1.36 CAD)`, status: 'available', lastUpdated: new Date().toISOString() };
    }
    return { ...meta, price: null, status: 'unavailable', note: 'Visit site to check prices', lastUpdated: new Date().toISOString() };
  } catch (err) {
    console.error('[Gametime]', err.message);
    return { ...meta, price: null, status: 'unavailable', note: 'Scrape failed — check manually', lastUpdated: new Date().toISOString() };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ─── SeatPick ─────────────────────────────────────────────────────────────────
async function scrapeSeatPick(browser, event) {
  const searchQuery = encodeURIComponent(event.name + ' toronto');
  const searchUrl = `https://seatpick.com/search?q=${searchQuery}`;
  const meta = { name: 'SeatPick', platform: 'seatpick', currency: 'CAD', url: searchUrl };

  // Step 1: plain fetch
  try {
    const { body } = await fetchUrl(searchUrl);
    const jsonLdPrice = extractJsonLdPrice(body);
    if (jsonLdPrice) {
      console.log('[SeatPick] JSON-LD price:', jsonLdPrice);
      return { ...meta, price: jsonLdPrice, status: 'available', lastUpdated: new Date().toISOString() };
    }
    const patterns = [/"minPrice"\s*:\s*([\d.]+)/, /"lowestPrice"\s*:\s*([\d.]+)/, /"lowest_price"\s*:\s*([\d.]+)/];
    for (const rx of patterns) {
      const m = body.match(rx);
      if (m) {
        const p = parseFloat(m[1]);
        if (p > 0 && p < 25000) {
          console.log('[SeatPick] fetch price:', p);
          return { ...meta, price: p, status: 'available', lastUpdated: new Date().toISOString() };
        }
      }
    }
  } catch (err) {
    console.warn('[SeatPick] fetch failed:', err.message);
  }

  // Step 2: Puppeteer fallback
  let page;
  try {
    page = await newPage(browser);
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 25000 });
    await sleep(2500);
    if (await isBlocked(page)) return { ...meta, price: null, status: 'unavailable', note: 'Bot protection — check manually', lastUpdated: new Date().toISOString() };

    const html = await page.content();
    const jsonLdPrice = extractJsonLdPrice(html);
    if (jsonLdPrice) return { ...meta, price: jsonLdPrice, status: 'available', lastUpdated: new Date().toISOString() };

    const texts = await page.evaluate(() => {
      const found = [];
      for (const sel of [
        '[data-testid*="price"]', '[class*="price"]', '[class*="Price"]',
        '[class*="ticket"]', '[class*="listing"]', '[class*="event"]',
      ]) {
        for (const el of document.querySelectorAll(sel)) {
          const t = el.textContent.trim();
          if (t.includes('$') && /\d/.test(t)) found.push(t);
        }
      }
      found.push(...(document.body.innerText.match(/(from|lowest|starting)\s+\$\s*[\d,]+/gi) || []));
      found.push(...(document.body.innerText.match(/\$\s*[\d,]+(?:\.\d{2})?/g) || []).slice(0, 15));
      return found;
    });

    const price = extractLowestPrice(texts);
    return { ...meta, price, status: price ? 'available' : 'unavailable', note: price ? null : 'Visit site to check prices', lastUpdated: new Date().toISOString() };
  } catch (err) {
    console.error('[SeatPick]', err.message);
    return { ...meta, price: null, status: 'unavailable', note: 'Scrape failed — check manually', lastUpdated: new Date().toISOString() };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ─── TicketSmarter ────────────────────────────────────────────────────────────
async function scrapeTicketSmarter(browser, event) {
  const searchQuery = encodeURIComponent(event.name + ' toronto');
  const searchUrl = `https://www.ticketsmarter.com/search?q=${searchQuery}`;
  const meta = { name: 'TicketSmarter', platform: 'ticketsmarter', currency: 'USD', url: searchUrl };

  // Step 1: plain HTTP fetch — JSON-LD + embedded patterns
  try {
    const { body } = await fetchUrl(searchUrl);
    const jsonLdPrice = extractJsonLdPrice(body);
    if (jsonLdPrice) {
      const cadPrice = Math.round(jsonLdPrice * USD_TO_CAD * 100) / 100;
      console.log('[TicketSmarter] JSON-LD price:', jsonLdPrice);
      return { ...meta, price: jsonLdPrice, priceCAD: cadPrice, currencyNote: `≈ CAD $${cadPrice.toFixed(2)} (est. 1 USD = 1.36 CAD)`, status: 'available', lastUpdated: new Date().toISOString() };
    }
    const patterns = [
      /"minPrice"\s*:\s*([\d.]+)/,
      /"lowestPrice"\s*:\s*([\d.]+)/,
      /"startingPrice"\s*:\s*([\d.]+)/,
      /"price"\s*:\s*"?([\d.]+)"?/,
      /from\s+\$\s*([\d,]+)/i,
    ];
    for (const rx of patterns) {
      const m = body.match(rx);
      if (m) {
        const p = parseFloat(m[1].replace(/,/g, ''));
        if (p > 0 && p < 25000) {
          const cadPrice = Math.round(p * USD_TO_CAD * 100) / 100;
          console.log('[TicketSmarter] fetch price:', p);
          return { ...meta, price: p, priceCAD: cadPrice, currencyNote: `≈ CAD $${cadPrice.toFixed(2)} (est. 1 USD = 1.36 CAD)`, status: 'available', lastUpdated: new Date().toISOString() };
        }
      }
    }
  } catch (err) {
    console.warn('[TicketSmarter] fetch failed:', err.message);
  }

  // Step 2: Puppeteer fallback
  let page;
  try {
    page = await newPage(browser);
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 25000 });
    await sleep(2500);
    if (await isBlocked(page)) return { ...meta, price: null, status: 'unavailable', note: 'Bot protection — check manually', lastUpdated: new Date().toISOString() };

    const html = await page.content();
    const jsonLdPrice = extractJsonLdPrice(html);
    if (jsonLdPrice) {
      const cadPrice = Math.round(jsonLdPrice * USD_TO_CAD * 100) / 100;
      return { ...meta, price: jsonLdPrice, priceCAD: cadPrice, currencyNote: `≈ CAD $${cadPrice.toFixed(2)} (est. 1 USD = 1.36 CAD)`, status: 'available', lastUpdated: new Date().toISOString() };
    }

    const texts = await page.evaluate(() => {
      const found = [];
      for (const sel of [
        '[data-testid*="price"]', '[class*="price"]', '[class*="Price"]',
        '[class*="ticket"]', '[class*="listing"]', '[class*="event"]',
      ]) {
        for (const el of document.querySelectorAll(sel)) {
          const t = el.textContent.trim();
          if (t.includes('$') && /\d/.test(t)) found.push(t);
        }
      }
      found.push(...(document.body.innerText.match(/(from|lowest|starting)\s+\$\s*[\d,]+/gi) || []));
      found.push(...(document.body.innerText.match(/\$\s*[\d,]+(?:\.\d{2})?/g) || []).slice(0, 15));
      return found;
    });

    const lowestUsd = extractLowestPrice(texts);
    if (lowestUsd) {
      const cadPrice = Math.round(lowestUsd * USD_TO_CAD * 100) / 100;
      return { ...meta, price: lowestUsd, priceCAD: cadPrice, currencyNote: `≈ CAD $${cadPrice.toFixed(2)} (est. 1 USD = 1.36 CAD)`, status: 'available', lastUpdated: new Date().toISOString() };
    }
    return { ...meta, price: null, status: 'unavailable', note: 'Visit site to check prices', lastUpdated: new Date().toISOString() };
  } catch (err) {
    console.error('[TicketSmarter]', err.message);
    return { ...meta, price: null, status: 'unavailable', note: 'Scrape failed — check manually', lastUpdated: new Date().toISOString() };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ─── Orchestrator ────────────────────────────────────────────────────────────
// onPlatformComplete(result) is called immediately as each platform finishes —
// server.js uses this to write partial results to db so the frontend can poll
// and see live progress instead of waiting for all 8 to finish.
async function scrapeEvent(event, onPlatformComplete) {
  const scrapers = [
    browser => scrapeTicketmaster(browser, event),
    browser => scrapeStubHub(browser, event),
    browser => scrapeVividSeats(browser, event),
    browser => scrapeViagogo(browser, event),
    browser => scrapeSeatGeek(browser, event),
    browser => scrapeGametime(browser, event),
    browser => scrapeSeatPick(browser, event),
    browser => scrapeTicketSmarter(browser, event),
  ];

  let browser;
  try {
    browser = await launchBrowser();
    const results = [];
    for (let i = 0; i < scrapers.length; i += SCRAPER_CONCURRENCY) {
      const batch = scrapers.slice(i, i + SCRAPER_CONCURRENCY);
      await Promise.allSettled(batch.map(fn =>
        fn(browser).then(result => {
          results.push(result);
          if (onPlatformComplete) onPlatformComplete(result);
        }).catch(err => {
          console.error('[scraper batch]', err.message);
        })
      ));
      if (i + SCRAPER_CONCURRENCY < scrapers.length) await sleep(DELAY_BETWEEN_SITES_MS);
    }
    return results;
  } finally {
    if (browser) await browser.close().catch(err => console.error('Browser close:', err.message));
  }
}

module.exports = { scrapeEvent };
