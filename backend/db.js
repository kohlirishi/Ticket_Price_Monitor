const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readDb() {
  ensureDataDir();
  if (!fs.existsSync(DB_FILE)) {
    const initial = { events: [], prices: {} };
    writeDb(initial);
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { events: [], prices: {} };
  }
}

function writeDb(data) {
  ensureDataDir();
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function getEvents() {
  return readDb().events;
}

function getEvent(id) {
  return readDb().events.find(e => e.id === id) || null;
}

function addEvent(event) {
  const db = readDb();
  db.events.push(event);
  writeDb(db);
  return event;
}

function updateEvent(id, patch) {
  const db = readDb();
  const idx = db.events.findIndex(e => e.id === id);
  if (idx === -1) return null;
  db.events[idx] = { ...db.events[idx], ...patch };
  writeDb(db);
  return db.events[idx];
}

function removeEvent(id) {
  const db = readDb();
  db.events = db.events.filter(e => e.id !== id);
  delete db.prices[id];
  writeDb(db);
}

function getPrices(eventId) {
  const db = readDb();
  if (eventId) return db.prices[eventId] || null;
  return db.prices;
}

function setPrices(eventId, prices) {
  const db = readDb();
  db.prices[eventId] = prices;
  writeDb(db);
}

module.exports = { getEvents, getEvent, addEvent, updateEvent, removeEvent, getPrices, setPrices };
