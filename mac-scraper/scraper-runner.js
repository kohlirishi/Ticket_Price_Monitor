#!/usr/bin/env node
'use strict';

// Load .env from mac-scraper/ folder before anything else
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const fs   = require('fs');
const path = require('path');

// Reuse the existing backend scraper — no need to duplicate the 8 platform scrapers.
// Node resolves requires from backend/scraper.js using backend/node_modules/ automatically.
const { scrapeEvent } = require('../backend/scraper');
const { gitPush }     = require('./git-push');

const EVENTS_FILE  = path.join(__dirname, 'events.json');
const OUTPUT_FILE  = path.join(__dirname, '..', 'docs', 'prices.json');
const INTERVAL_MS  = 5 * 60 * 1000; // 5 minutes

let isRunning = false;

// ── Load events config ────────────────────────────────────────────────────────
function loadEvents() {
  return JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
}

// ── Write prices.json ─────────────────────────────────────────────────────────
function writePrices(eventResults, globalLastUpdated) {
  const output = {
    lastUpdated: globalLastUpdated || new Date().toISOString(),
    events: eventResults,
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
}

// ── Load existing prices.json so partial writes keep old event data ───────────
function loadExistingResultMap() {
  try {
    if (fs.existsSync(OUTPUT_FILE)) {
      const data = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
      const map = new Map();
      for (const e of (data.events || [])) map.set(e.id, e);
      return map;
    }
  } catch { /* start fresh if file is corrupt */ }
  return new Map();
}

// ── Main scrape cycle ─────────────────────────────────────────────────────────
async function scrapeAll() {
  if (isRunning) {
    console.log('[runner] Previous cycle still running — skipping');
    return;
  }
  isRunning = true;

  let events;
  try {
    events = loadEvents();
  } catch (err) {
    console.error('[runner] Cannot read events.json:', err.message);
    isRunning = false;
    return;
  }

  const cycleStart = new Date().toISOString();
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[runner] Cycle started: ${cycleStart}`);
  console.log(`[runner] Events to scrape: ${events.length}`);
  console.log(`${'─'.repeat(60)}`);

  // Start with whatever was last written so we can do partial writes
  const resultMap = loadExistingResultMap();

  for (const event of events) {
    const t0 = Date.now();
    console.log(`\n[runner] → ${event.name}`);

    try {
      const platformResults = await scrapeEvent(event);
      const found = (platformResults || []).filter(p => p.price != null).length;
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[runner] ✓ Done — ${found}/${(platformResults||[]).length} prices found (${elapsed}s)`);

      resultMap.set(event.id, {
        id:              event.id,
        name:            event.name,
        date:            event.date,
        venue:           event.venue,
        ticketmasterUrl: event.ticketmasterUrl,
        vividSeatsUrl:   event.vividSeatsUrl || null,
        lastUpdated:     new Date().toISOString(),
        prices:          platformResults || [],
      });
    } catch (err) {
      // Keep previous data for this event rather than wiping it on transient failure
      console.error(`[runner] ✗ Failed: ${err.message}`);
    }

    // Write partial results immediately after each event finishes — the file
    // is always as fresh as possible without waiting for the full cycle
    const allResults = events.map(e => resultMap.get(e.id)).filter(Boolean);
    writePrices(allResults, cycleStart);
  }

  console.log(`\n[runner] Cycle complete. Pushing to GitHub...`);
  await gitPush(cycleStart);

  isRunning = false;
  const nextIn = Math.round(INTERVAL_MS / 60000);
  console.log(`[runner] Next cycle in ${nextIn} minutes.\n`);
}

// ── Entry point ───────────────────────────────────────────────────────────────
const events = loadEvents();
console.log('');
console.log('╔════════════════════════════════════════╗');
console.log('║   Toronto Ticket Tracker — Mac Scraper ║');
console.log('╚════════════════════════════════════════╝');
console.log(`Tracking ${events.length} events  |  Interval: 5 min  |  Ctrl+C to stop`);
console.log('');

// Run once immediately, then every 5 minutes
scrapeAll();
setInterval(scrapeAll, INTERVAL_MS);
