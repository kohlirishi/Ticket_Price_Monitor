const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const https = require('https');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { scrapeEvent } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CORS ───────────────────────────────────────────────────────────────────
const ALLOWED_ORIGIN = process.env.FRONTEND_URL || '*';

app.use(cors({
  origin: ALLOWED_ORIGIN,
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json());

// ─── In-memory scrape status ──────────────────────────────────────────────────
// Tracks live progress for each event currently being scraped.
// Written here first (fast), then persisted to db as each platform finishes.
const scrapeStatus = {};       // { [eventId]: { running, startedAt, completed, total } }
const TOTAL_PLATFORMS = 8;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function parseTicketmasterUrl(url) {
  const u = new URL(url);
  const slug = u.pathname.split('/').filter(Boolean)[0] || '';

  const dateMatch = slug.match(/(\d{2})-(\d{2})-(\d{4})$/);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let date = 'Date TBD';
  let nameSlug = slug;

  if (dateMatch) {
    const [, mm, dd, yyyy] = dateMatch;
    date = `${months[parseInt(mm, 10) - 1]} ${parseInt(dd, 10)}, ${yyyy}`;
    nameSlug = slug.replace(/-\d{2}-\d{2}-\d{4}$/, '');
  }

  const parts = nameSlug.split('-');
  const locationKeywords = new Set(['toronto','ontario','bc','alberta','quebec','vancouver','montreal','calgary','edmonton','ottawa','winnipeg']);
  let splitAt = parts.length;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (locationKeywords.has(parts[i].toLowerCase())) { splitAt = i; break; }
  }

  const nameParts = parts.slice(0, splitAt);
  const venueParts = parts.slice(splitAt);

  const capitalize = w => w.charAt(0).toUpperCase() + w.slice(1);
  const name = nameParts.map(capitalize).join(' ') || 'Unknown Event';
  const venue = venueParts.length
    ? venueParts.map(capitalize).join(', ')
    : 'Toronto, Ontario';

  return { name, date, venue };
}

// ─── Clear stale scrapingInProgress flags on restart ────────────────────────
function clearStaleScrapingFlags() {
  for (const ev of db.getEvents()) {
    const pd = db.getPrices(ev.id);
    if (pd && pd.scrapingInProgress) {
      db.setPrices(ev.id, { ...pd, scrapingInProgress: false });
      console.log('[startup] cleared stale scrapingInProgress for', ev.name);
    }
  }
}

// ─── Scraping ────────────────────────────────────────────────────────────────
let scrapeRunning = false;
let queueRunning = false;
const scrapeQueue = [];
const queuedEventIds = new Set();
const activeScrapeIds = new Set();

function enqueueScrape(eventId) {
  if (!db.getEvent(eventId)) return false;
  if (queuedEventIds.has(eventId) || activeScrapeIds.has(eventId)) return false;
  queuedEventIds.add(eventId);
  scrapeQueue.push(eventId);
  runScrapeQueue().catch(err => console.error('[queue]', err.message));
  return true;
}

async function runScrapeQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (scrapeQueue.length) {
      const eventId = scrapeQueue.shift();
      queuedEventIds.delete(eventId);
      await scrapeAndStore(eventId);
    }
  } finally {
    queueRunning = false;
  }
}

async function scrapeAndStore(eventId) {
  const event = db.getEvent(eventId);
  if (!event) return;
  if (activeScrapeIds.has(eventId)) return;
  activeScrapeIds.add(eventId);

  console.log(`[scrape] ${event.name}`);

  // Set in-memory status so GET /api/prices/:id responds immediately
  scrapeStatus[eventId] = { running: true, startedAt: new Date().toISOString(), completed: 0, total: TOTAL_PLATFORMS };

  // Write "scraping started" to db so frontend sees it on first poll even before
  // any platform finishes
  const existing = db.getPrices(eventId);
  db.setPrices(eventId, {
    lastUpdated: new Date().toISOString(),
    prices: existing ? existing.prices : [],
    scrapingInProgress: true,
    completedPlatforms: 0,
    totalPlatforms: TOTAL_PLATFORMS,
  });

  try {
    // Called immediately as each of the 8 platforms resolves (parallel)
    const onPlatformComplete = (result) => {
      const st = scrapeStatus[eventId];
      if (!st) return;
      st.completed++;
      const completed = st.completed;

      // Merge this platform's result into the partial db record
      const current = db.getPrices(eventId) || { prices: [] };
      const currentPrices = [...(current.prices || [])];
      const idx = currentPrices.findIndex(p => p.platform === result.platform);
      if (idx >= 0) currentPrices[idx] = result;
      else currentPrices.push(result);

      db.setPrices(eventId, {
        lastUpdated: new Date().toISOString(),
        prices: currentPrices,
        scrapingInProgress: completed < TOTAL_PLATFORMS,
        completedPlatforms: completed,
        totalPlatforms: TOTAL_PLATFORMS,
      });
      console.log(`[scrape] ${event.name} — ${completed}/${TOTAL_PLATFORMS} done`);
    };

    await scrapeEvent(event, onPlatformComplete);
    console.log(`[scrape] done: ${event.name}`);
  } catch (err) {
    console.error(`[scrape] failed (${event.name}):`, err.message);
  } finally {
    // Always mark as finished
    scrapeStatus[eventId] = { running: false, completed: TOTAL_PLATFORMS, total: TOTAL_PLATFORMS };
    const final = db.getPrices(eventId);
    if (final) {
      db.setPrices(eventId, { ...final, scrapingInProgress: false, completedPlatforms: TOTAL_PLATFORMS });
    }
    activeScrapeIds.delete(eventId);
  }
}

function queueMissingInitialScrapes() {
  for (const ev of db.getEvents()) {
    const pd = db.getPrices(ev.id);
    if (!pd || !pd.lastUpdated) {
      console.log('[startup] queued first scrape for', ev.name);
      enqueueScrape(ev.id);
    }
  }
}

// ─── Default Event Seed ──────────────────────────────────────────────────────
async function seedDefaultEvent() {
  const DEFAULT_ID = 'diljit-dosanjh-aura-2026';
  const events = db.getEvents();
  if (events.find(e => e.id === DEFAULT_ID)) return;

  const defaultEvent = {
    id: DEFAULT_ID,
    name: 'Diljit Dosanjh – Aura World Tour 2026',
    date: 'May 31, 2026',
    venue: 'Rogers Centre, Toronto, Ontario',
    ticketmasterUrl: 'https://www.ticketmaster.ca/diljit-dosanjh-aura-world-tour-2026-toronto-ontario-05-31-2026/event/100064422A4A5083',
    vividSeatsUrl: 'https://www.vividseats.com/diljit-dosanjh-tickets-toronto-rogers-centre-5-31-2026/production/6612515',
    addedAt: new Date().toISOString(),
  };
  db.addEvent(defaultEvent);
  console.log('[seed] Default event added:', defaultEvent.name);
  enqueueScrape(DEFAULT_ID);
}

// ─── Routes ──────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/events', (_req, res) => {
  res.json(db.getEvents());
});

app.post('/api/events', async (req, res) => {
  const { ticketmasterUrl, vividSeatsUrl } = req.body || {};
  if (!ticketmasterUrl || !ticketmasterUrl.includes('ticketmaster')) {
    return res.status(400).json({ error: 'A valid Ticketmaster URL is required' });
  }
  try {
    const parsed = parseTicketmasterUrl(ticketmasterUrl);
    const event = {
      id: uuidv4(),
      ...parsed,
      ticketmasterUrl,
      vividSeatsUrl: vividSeatsUrl || null,
      addedAt: new Date().toISOString(),
    };
    db.addEvent(event);
    setTimeout(() => scrapeAndStore(event.id), 1000);
    res.status(201).json(event);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/events/:id', (req, res) => {
  if (!db.getEvent(req.params.id)) {
    return res.status(404).json({ error: 'Event not found' });
  }
  db.removeEvent(req.params.id);
  delete scrapeStatus[req.params.id];
  res.json({ success: true });
});

// Returns all prices — scrapingInProgress baked into each entry via db writes
app.get('/api/prices', (_req, res) => {
  const allPrices = db.getPrices();
  // Overlay in-memory status (more current than db during an active scrape)
  for (const [eventId, st] of Object.entries(scrapeStatus)) {
    if (allPrices[eventId]) {
      allPrices[eventId].scrapingInProgress = st.running;
      allPrices[eventId].completedPlatforms = st.completed;
      allPrices[eventId].totalPlatforms = st.total;
    }
  }
  res.json(allPrices);
});

// Per-event — frontend polls this every 3 s while scrapingInProgress is true
app.get('/api/prices/:eventId', (req, res) => {
  const priceData = db.getPrices(req.params.eventId);
  const st = scrapeStatus[req.params.eventId] || {};

  if (!priceData && !st.running) {
    return res.status(404).json({ error: 'No price data yet — scrape in progress' });
  }

  const response = priceData
    ? { ...priceData }
    : { prices: [], lastUpdated: null, scrapingInProgress: true, completedPlatforms: 0, totalPlatforms: TOTAL_PLATFORMS };

  // In-memory status is always fresher than db during an active scrape
  if (st.running !== undefined) {
    response.scrapingInProgress = st.running;
    response.completedPlatforms = st.completed ?? response.completedPlatforms ?? 0;
    response.totalPlatforms = st.total ?? TOTAL_PLATFORMS;
  }

  res.json(response);
});

app.post('/api/scrape/:eventId', async (req, res) => {
  if (!db.getEvent(req.params.eventId)) {
    return res.status(404).json({ error: 'Event not found' });
  }
  const queued = enqueueScrape(req.params.eventId);
  res.json({ message: queued ? 'Scrape queued' : 'Scrape already queued or running' });
});

// ─── Cron: scrape all events every 5 minutes ──────────────────────────────
cron.schedule('*/5 * * * *', async () => {
  if (scrapeRunning) {
    console.log('[cron] Previous scrape still running — skipping');
    return;
  }
  scrapeRunning = true;
  try {
    for (const event of db.getEvents()) {
      enqueueScrape(event.id);
    }
    await runScrapeQueue();
  } finally {
    scrapeRunning = false;
  }
});

// ─── Cron: self-ping every 10 minutes to keep Render free tier awake ─────
cron.schedule('*/10 * * * *', () => {
  const target = process.env.RENDER_URL;
  if (!target) return;
  const client = target.startsWith('https') ? https : http;
  client.get(`${target}/api/health`, res => {
    console.log(`[ping] self-ping ${res.statusCode}`);
  }).on('error', err => {
    console.error('[ping] self-ping failed:', err.message);
  });
});

// ─── FIFA World Cup 2026 Toronto Seed ────────────────────────────────────────
async function seedFifaEvents() {
  const FIFA_MATCHES = [
    {
      id: 'fifa-wc2026-toronto-match1-canada-bosnia',
      name: 'FIFA World Cup 2026 – Canada vs Bosnia-Herzegovina',
      date: 'Jun 12, 2026',
      venue: 'BMO Field (Toronto Stadium), Toronto, Ontario',
      ticketmasterUrl: 'https://www.ticketmaster.ca/2026-world-cup-tickets/artist/4067734',
      vividSeatsUrl: 'https://www.vividseats.com/world-cup-soccer-tickets-bmo-field-6-12-2026--sports-soccer/production/5080436',
    },
    {
      id: 'fifa-wc2026-toronto-match2-ghana-panama',
      name: 'FIFA World Cup 2026 – Ghana vs Panama',
      date: 'Jun 17, 2026',
      venue: 'BMO Field (Toronto Stadium), Toronto, Ontario',
      ticketmasterUrl: 'https://www.ticketmaster.ca/2026-world-cup-tickets/artist/4067734',
      vividSeatsUrl: null,
    },
    {
      id: 'fifa-wc2026-toronto-match3-germany-ivory-coast',
      name: 'FIFA World Cup 2026 – Germany vs Ivory Coast',
      date: 'Jun 20, 2026',
      venue: 'BMO Field (Toronto Stadium), Toronto, Ontario',
      ticketmasterUrl: 'https://www.ticketmaster.ca/2026-world-cup-tickets/artist/4067734',
      vividSeatsUrl: null,
    },
    {
      id: 'fifa-wc2026-toronto-match4-panama-croatia',
      name: 'FIFA World Cup 2026 – Panama vs Croatia',
      date: 'Jun 23, 2026',
      venue: 'BMO Field (Toronto Stadium), Toronto, Ontario',
      ticketmasterUrl: 'https://www.ticketmaster.ca/2026-world-cup-tickets/artist/4067734',
      vividSeatsUrl: null,
    },
    {
      id: 'fifa-wc2026-toronto-match5-senegal-iraq',
      name: 'FIFA World Cup 2026 – Senegal vs Iraq',
      date: 'Jun 26, 2026',
      venue: 'BMO Field (Toronto Stadium), Toronto, Ontario',
      ticketmasterUrl: 'https://www.ticketmaster.ca/2026-world-cup-tickets/artist/4067734',
      vividSeatsUrl: null,
    },
    {
      id: 'fifa-wc2026-toronto-match6-r32',
      name: 'FIFA World Cup 2026 – Round of 32 (Group K 2nd vs Group L 2nd)',
      date: 'Jul 2, 2026',
      venue: 'BMO Field (Toronto Stadium), Toronto, Ontario',
      ticketmasterUrl: 'https://www.ticketmaster.ca/2026-world-cup-tickets/artist/4067734',
      vividSeatsUrl: null,
    },
  ];

  const existing = db.getEvents();
  for (const match of FIFA_MATCHES) {
    if (existing.find(e => e.id === match.id)) continue;
    db.addEvent({ ...match, addedAt: new Date().toISOString() });
    console.log('[seed] FIFA match added:', match.name);
    enqueueScrape(match.id);
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Toronto Ticket Tracker backend on port ${PORT}`);
  clearStaleScrapingFlags();
  await seedDefaultEvent();
  await seedFifaEvents();
  queueMissingInitialScrapes();
});
