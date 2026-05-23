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
// After deploying to GitHub Pages, replace '*' with your actual Pages URL, e.g.:
//   'https://your-username.github.io'    ← UPDATE THIS
const ALLOWED_ORIGIN = process.env.FRONTEND_URL || '*';

app.use(cors({
  origin: ALLOWED_ORIGIN,
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json());

// ─── Helpers ─────────────────────────────────────────────────────────────────
function parseTicketmasterUrl(url) {
  const u = new URL(url);
  const slug = u.pathname.split('/').filter(Boolean)[0] || '';

  // Extract date segment: MM-DD-YYYY at end of slug
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

// ─── Scraping ────────────────────────────────────────────────────────────────
let scrapeRunning = false;

async function scrapeAndStore(eventId) {
  const event = db.getEvent(eventId);
  if (!event) return;
  console.log(`[scrape] ${event.name}`);
  try {
    const prices = await scrapeEvent(event);
    db.setPrices(eventId, { lastUpdated: new Date().toISOString(), prices });
    console.log(`[scrape] done: ${event.name}`);
  } catch (err) {
    console.error(`[scrape] failed (${event.name}):`, err.message);
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
  // Kick off initial scrape after a short delay
  setTimeout(() => scrapeAndStore(DEFAULT_ID), 4000);
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
  res.json({ success: true });
});

app.get('/api/prices', (_req, res) => {
  res.json(db.getPrices());
});

app.get('/api/prices/:eventId', (req, res) => {
  const prices = db.getPrices(req.params.eventId);
  if (!prices) return res.status(404).json({ error: 'No price data yet — scrape in progress' });
  res.json(prices);
});

app.post('/api/scrape/:eventId', async (req, res) => {
  if (!db.getEvent(req.params.eventId)) {
    return res.status(404).json({ error: 'Event not found' });
  }
  res.json({ message: 'Scrape initiated' });
  scrapeAndStore(req.params.eventId).catch(console.error);
});

// ─── Cron: scrape all events every 60 seconds ─────────────────────────────
cron.schedule('* * * * *', async () => {
  if (scrapeRunning) {
    console.log('[cron] Previous scrape still running — skipping');
    return;
  }
  scrapeRunning = true;
  try {
    for (const event of db.getEvents()) {
      await scrapeAndStore(event.id);
    }
  } finally {
    scrapeRunning = false;
  }
});

// ─── Cron: self-ping every 10 minutes to keep Render free tier awake ─────
cron.schedule('*/10 * * * *', () => {
  // Set RENDER_URL env var in Render.com dashboard to your service URL   ← UPDATE THIS
  const target = process.env.RENDER_URL;
  if (!target) return;
  const client = target.startsWith('https') ? https : http;
  client.get(`${target}/api/health`, res => {
    console.log(`[ping] self-ping ${res.statusCode}`);
  }).on('error', err => {
    console.error('[ping] self-ping failed:', err.message);
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Toronto Ticket Tracker backend on port ${PORT}`);
  await seedDefaultEvent();
});
