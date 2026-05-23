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

  // @sparticuz/chromium — works on Render.com (Linux)
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
    // Local dev fallback — tries system Chrome/Chromium
    const localPaths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ];
    for (const execPath of localPaths) {
      try {
        return await puppeteerCore.launch({
          args,
          executablePath: execPath,
          headless: true,
          ignoreHTTPSErrors: true,
        });
      } catch { /* try next */ }
    }
    throw new Error('No Chrome/Chromium found. On Render.com this is handled automatically.');
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
  // Block images, fonts, and media to cut memory usage
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['image', 'font', 'media'].includes(req.resourceType())) {
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
    const matches = text.matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g);
    for (const m of matches) {
      const n = parseFloat(m[1].replace(/,/g, ''));
      if (n > 0 && n < 25000) prices.push(n);
    }
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

// ─── Ticketmaster CA ───────────────────────────────────────────────────────
async function scrapeTicketmaster(browser, event) {
  const meta = {
    name: 'Ticketmaster',
    platform: 'ticketmaster',
    currency: 'CAD',
    url: event.ticketmasterUrl,
  };
  let page;
  try {
    page = await newPage(browser);
    await page.goto(event.ticketmasterUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    const texts = await page.evaluate(() => {
      const found = [];
      // Primary: structured price elements
      const selectors = [
        '[data-testid*="price"]',
        '[class*="price"]',
        '[class*="Price"]',
        '.event-header__price',
        '.price-summary',
        '.js-lowest-price',
      ];
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          const t = el.textContent.trim();
          if (t.includes('$') && /\d/.test(t)) found.push(t);
        }
      }
      // Broad fallback: "from $X" in page text
      const fromMatches = document.body.innerText.match(/from\s+\$[\d,]+/gi) || [];
      found.push(...fromMatches);
      return found;
    });

    const price = extractLowestPrice(texts);
    return {
      ...meta,
      price,
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

// ─── StubHub CA ────────────────────────────────────────────────────────────
async function scrapeStubHub(browser, event) {
  const query = encodeURIComponent(event.name + ' Toronto');
  const meta = {
    name: 'StubHub',
    platform: 'stubhub',
    currency: 'CAD',
    url: `https://www.stubhub.ca/search?q=${query}`,
  };
  let page;
  try {
    page = await newPage(browser);
    await page.goto(meta.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(2000);

    if (await isBlocked(page)) {
      return { ...meta, price: null, status: 'unavailable', note: 'Bot protection active — check manually', lastUpdated: new Date().toISOString() };
    }

    const texts = await page.evaluate(() => {
      const found = [];
      for (const sel of ['[data-testid*="price"]', '[class*="price"]', '[class*="Price"]', '.price']) {
        for (const el of document.querySelectorAll(sel)) {
          const t = el.textContent.trim();
          if (t.includes('$') && /\d/.test(t)) found.push(t);
        }
      }
      return found;
    });

    const price = extractLowestPrice(texts);
    return {
      ...meta,
      price,
      status: price ? 'available' : 'unavailable',
      note: price ? null : 'Bot protection — check manually',
      lastUpdated: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[StubHub]', err.message);
    return { ...meta, price: null, status: 'unavailable', note: 'Bot protection — check manually', lastUpdated: new Date().toISOString() };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ─── VividSeats ─────────────────────────────────────────────────────────────
async function scrapeVividSeats(browser, event) {
  const url = event.vividSeatsUrl ||
    `https://www.vividseats.com/search?searchTerm=${encodeURIComponent(event.name)}`;
  const meta = {
    name: 'VividSeats',
    platform: 'vividseats',
    currency: 'USD',
    url,
  };
  let page;
  try {
    page = await newPage(browser);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3500);

    const texts = await page.evaluate(() => {
      const found = [];
      for (const sel of [
        '[data-testid*="price"]',
        '[class*="listingPrice"]',
        '[class*="listing-price"]',
        '[class*="price"]',
        '[class*="Price"]',
      ]) {
        for (const el of document.querySelectorAll(sel)) {
          const t = el.textContent.trim();
          if (t.includes('$') && /\d/.test(t)) found.push(t);
        }
      }
      if (found.length === 0) {
        // Broad sweep
        const raw = document.body.innerText.match(/\$\s*[\d,]+(?:\.\d{2})?/g) || [];
        found.push(...raw.slice(0, 20));
      }
      return found;
    });

    const lowestUsd = extractLowestPrice(texts);
    if (lowestUsd) {
      const cadPrice = Math.round(lowestUsd * USD_TO_CAD * 100) / 100;
      return {
        ...meta,
        price: lowestUsd,
        priceCAD: cadPrice,
        currencyNote: `≈ CAD $${cadPrice.toFixed(2)} (est. 1 USD = 1.36 CAD)`,
        status: 'available',
        lastUpdated: new Date().toISOString(),
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

// ─── Viagogo CA ─────────────────────────────────────────────────────────────
async function scrapeViagogo(browser, event) {
  const query = encodeURIComponent(event.name + ' Toronto');
  const meta = {
    name: 'Viagogo',
    platform: 'viagogo',
    currency: 'CAD',
    url: `https://www.viagogo.ca/search?q=${query}`,
  };
  let page;
  try {
    page = await newPage(browser);
    await page.goto(meta.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(2000);

    if (await isBlocked(page)) {
      return { ...meta, price: null, status: 'unavailable', note: 'Bot protection active — check manually', lastUpdated: new Date().toISOString() };
    }

    const texts = await page.evaluate(() => {
      const found = [];
      for (const sel of ['[class*="price"]', '[class*="Price"]', '.ticket-price', '[data-qa*="price"]']) {
        for (const el of document.querySelectorAll(sel)) {
          const t = el.textContent.trim();
          if (t.includes('$') && /\d/.test(t)) found.push(t);
        }
      }
      return found;
    });

    const price = extractLowestPrice(texts);
    return {
      ...meta,
      price,
      status: price ? 'available' : 'unavailable',
      note: price ? null : 'Bot protection — check manually',
      lastUpdated: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[Viagogo]', err.message);
    return { ...meta, price: null, status: 'unavailable', note: 'Bot protection — check manually', lastUpdated: new Date().toISOString() };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ─── SeatGeek CA ────────────────────────────────────────────────────────────
async function scrapeSeatGeek(browser, event) {
  const query = encodeURIComponent(event.name);
  // seatgeek.ca → seatgeek.com; pass Toronto lat/lon for local results
  const meta = {
    name: 'SeatGeek',
    platform: 'seatgeek',
    currency: 'CAD',
    url: `https://seatgeek.com/search?q=${query}&lat=43.6532&lon=-79.3832`,
  };
  let page;
  try {
    page = await newPage(browser);
    await page.goto(meta.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    const texts = await page.evaluate(() => {
      const found = [];
      for (const sel of [
        '[data-testid*="price"]',
        '[class*="price"]',
        '[class*="Price"]',
        '.TicketBuy-price',
        '.event-card-price',
      ]) {
        for (const el of document.querySelectorAll(sel)) {
          const t = el.textContent.trim();
          if (t.includes('$') && /\d/.test(t)) found.push(t);
        }
      }
      // Broad fallback: "from $X" text
      const raw = document.body.innerText.match(/from\s+\$[\d,]+/gi) || [];
      found.push(...raw);
      return found;
    });

    const price = extractLowestPrice(texts);
    return {
      ...meta,
      price,
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

// ─── Orchestrator ───────────────────────────────────────────────────────────
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
        const result = await scrapers[i](browser);
        results.push(result);
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
