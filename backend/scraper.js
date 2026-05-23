const puppeteerCore = require('puppeteer-core');

const USD_TO_CAD = 1.36;
const DELAY_BETWEEN_SITES_MS = 5000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
    return await puppeteerCore.launch({
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
        return await puppeteerCore.launch({ args, executablePath: execPath, headless: true, ignoreHTTPSErrors: true });
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
  let page;
  try {
    page = await newPage(browser);
    await page.goto(event.ticketmasterUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    await sleep(4000);

    // 1. JSON-LD structured data (most reliable)
    const html = await page.content();
    const jsonLdPrice = extractJsonLdPrice(html);
    if (jsonLdPrice) {
      return { ...meta, price: jsonLdPrice, status: 'available', lastUpdated: new Date().toISOString() };
    }

    // 2. DOM selectors + broad text search
    const texts = await page.evaluate(() => {
      const found = [];
      const selectors = [
        '[data-testid*="price"]', '[data-tid*="price"]',
        '[class*="price-range"]', '[class*="priceRange"]',
        '[class*="lowest-price"]', '[class*="lowestPrice"]',
        '[class*="ticket-price"]', '[class*="ticketPrice"]',
        '[aria-label*="from $"]', '[aria-label*="price"]',
        '.sc-fzoLsD', '.price', '.priceSummary',
      ];
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          const t = el.textContent.trim();
          if (t.includes('$') && /\d/.test(t)) found.push(t);
        }
      }
      // Broad: "from $X" or "starting at $X" in full page text
      const pageText = document.body.innerText;
      const broadMatches = pageText.match(/(from|starting at|as low as)\s+\$\s*[\d,]+/gi) || [];
      found.push(...broadMatches);
      // Also grab any standalone $XXX patterns near "tickets"
      const ticketMatches = pageText.match(/\$\s*[\d,]+(?:\.\d{2})?\s*(CAD|cad)?/g) || [];
      found.push(...ticketMatches.slice(0, 10));
      return found;
    });

    const price = extractLowestPrice(texts);
    return {
      ...meta, price,
      status: price ? 'available' : 'unavailable',
      note: price ? null : 'Visit site to check prices',
      lastUpdated: new Date().toISOString(),
    };
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
    await page.goto(meta.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(2000);
    if (await isBlocked(page)) {
      return { ...meta, price: null, status: 'unavailable', note: 'Bot protection — check manually', lastUpdated: new Date().toISOString() };
    }
    const texts = await page.evaluate(() => {
      const found = [];
      for (const sel of ['[data-testid*="price"]', '[class*="price"]', '[class*="Price"]']) {
        for (const el of document.querySelectorAll(sel)) {
          const t = el.textContent.trim();
          if (t.includes('$') && /\d/.test(t)) found.push(t);
        }
      }
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
  let page;
  try {
    page = await newPage(browser);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 35000 });
    await sleep(4000);

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
    await page.goto(meta.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(2000);
    if (await isBlocked(page)) {
      return { ...meta, price: null, status: 'unavailable', note: 'Bot protection — check manually', lastUpdated: new Date().toISOString() };
    }
    const texts = await page.evaluate(() => {
      const found = [];
      for (const sel of ['[class*="price"]', '[class*="Price"]', '[data-qa*="price"]']) {
        for (const el of document.querySelectorAll(sel)) {
          const t = el.textContent.trim();
          if (t.includes('$') && /\d/.test(t)) found.push(t);
        }
      }
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

// ─── SeatGeek ────────────────────────────────────────────────────────────────
async function scrapeSeatGeek(browser, event) {
  // Try direct search on SeatGeek with artist name
  const artistSlug = event.name.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  const searchQuery = encodeURIComponent(event.name);
  const searchUrl = `https://seatgeek.com/search?q=${searchQuery}`;
  const meta = { name: 'SeatGeek', platform: 'seatgeek', currency: 'CAD', url: searchUrl };
  let page;
  try {
    page = await newPage(browser);
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 40000 });
    await sleep(4000);

    // 1. JSON-LD
    const html = await page.content();
    const jsonLdPrice = extractJsonLdPrice(html);
    if (jsonLdPrice) {
      return { ...meta, price: jsonLdPrice, status: 'available', lastUpdated: new Date().toISOString() };
    }

    // 2. DOM + page text
    const texts = await page.evaluate(() => {
      const found = [];
      for (const sel of [
        '[data-testid*="price"]', '[class*="price"]', '[class*="Price"]',
        '[class*="TicketBuy"]', '[class*="event-card"]',
      ]) {
        for (const el of document.querySelectorAll(sel)) {
          const t = el.textContent.trim();
          if (t.includes('$') && /\d/.test(t)) found.push(t);
        }
      }
      const pageText = document.body.innerText;
      const broadMatches = pageText.match(/(from|tickets from|starting)\s+\$\s*[\d,]+/gi) || [];
      found.push(...broadMatches);
      return found;
    });

    const price = extractLowestPrice(texts);
    return {
      ...meta, price,
      status: price ? 'available' : 'unavailable',
      note: price ? null : 'Visit site to check prices',
      lastUpdated: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[SeatGeek]', err.message);
    return { ...meta, price: null, status: 'unavailable', note: 'Scrape failed — check manually', lastUpdated: new Date().toISOString() };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ─── Orchestrator ────────────────────────────────────────────────────────────
async function scrapeEvent(event) {
  const scrapers = [
    browser => scrapeTicketmaster(browser, event),
    browser => scrapeStubHub(browser, event),
    browser => scrapeVividSeats(browser, event),
    browser => scrapeViagogo(browser, event),
    browser => scrapeSeatGeek(browser, event),
  ];

  let browser;
  const results = [];
  try {
    browser = await launchBrowser();
    for (let i = 0; i < scrapers.length; i++) {
      try {
        results.push(await scrapers[i](browser));
      } catch (err) {
        console.error(`Scraper ${i} threw:`, err.message);
      }
      if (i < scrapers.length - 1) await sleep(DELAY_BETWEEN_SITES_MS);
    }
  } finally {
    if (browser) await browser.close().catch(err => console.error('Browser close:', err.message));
  }
  return results;
}

module.exports = { scrapeEvent };
