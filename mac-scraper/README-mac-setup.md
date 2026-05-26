# Mac Scraper Setup Guide

This is the **local Mac scraper** for Toronto Ticket Tracker. It runs on your home Mac (not a cloud server), which means ticketing websites can't block it — your home internet connection looks like a real user, not a data centre bot.

Every 5 minutes it visits all 8 ticket platforms, grabs the latest prices, saves them to `docs/prices.json`, and pushes that file to GitHub. The website at `kohlirishi.github.io/Ticket_Price_Monitor` then serves that file directly.

---

## Prerequisites

### 1. Node.js 20+
Download and install from [nodejs.org](https://nodejs.org) — choose the **LTS** version.

After installing, verify it worked:
```bash
node --version
# should show v20.x.x or higher
```

### 2. Google Chrome
Download from [google.com/chrome](https://www.google.com/chrome) and install it. The scraper controls Chrome to visit ticketing websites.

### 3. Git configured
Make sure git is set up on your Mac:
```bash
git --version
```
If it prompts you to install developer tools, click Install.

---

## One-Time Setup

### Step 1 — Clone or pull the repo

If you already have the folder:
```bash
cd /path/to/Ticket_Price_Monitor
git pull
```

If not:
```bash
git clone https://github.com/kohlirishi/Ticket_Price_Monitor.git
cd Ticket_Price_Monitor
```

### Step 2 — Create your GitHub Personal Access Token

This lets the scraper push `prices.json` to GitHub automatically.

1. Go to [github.com](https://github.com) → click your avatar (top-right) → **Settings**
2. Scroll to the bottom left → **Developer settings**
3. **Personal access tokens** → **Tokens (classic)**
4. **Generate new token (classic)**
5. Give it a name like `ticket-tracker`
6. Set expiration: **No expiration** (or 1 year)
7. Tick the **`repo`** checkbox (full control of private repositories)
8. Click **Generate token**
9. **Copy the token immediately** — you won't see it again

### Step 3 — Create your .env file

```bash
cp mac-scraper/.env.example mac-scraper/.env
```

Open `mac-scraper/.env` in any text editor and paste your token:

```
GITHUB_TOKEN=ghp_your_actual_token_here
```

Save and close.

> **Important:** Never share this file or commit it to git. It's already in `.gitignore`.

### Step 4 — (Optional) SeatGeek API Key

SeatGeek offers a free developer API that gives better price data than scraping.

1. Go to [seatgeek.com/account/develop](https://seatgeek.com/account/develop)
2. Create a free developer account
3. Copy your **Client ID**
4. Add it to `mac-scraper/.env`:
   ```
   SEATGEEK_CLIENT_ID=your_client_id_here
   ```

If you skip this, SeatGeek still gets scraped via Chrome (just less reliably).

---

## Running the Scraper

### Option A — Simple (keep Terminal open)

```bash
bash mac-scraper/start.sh
```

The scraper runs and prints logs. **Keep Terminal open** — closing it stops the scraper.

The `start.sh` script:
- Checks that Node.js and Chrome are installed
- Installs dependencies automatically
- Prevents your Mac from sleeping while it runs (`caffeinate`)
- Starts scraping immediately, then every 5 minutes

### Option B — Background with pm2 (runs even if Terminal is closed)

Install pm2 once:
```bash
npm install -g pm2
```

Start the scraper in the background:
```bash
cd mac-scraper && npm install && cd ../backend && npm install && cd ..
pm2 start mac-scraper/scraper-runner.js --name ticket-tracker
```

Useful pm2 commands:
```bash
pm2 logs ticket-tracker    # see live logs
pm2 status                 # check if running
pm2 stop ticket-tracker    # stop it
pm2 restart ticket-tracker # restart it
pm2 startup                # make it survive Mac reboots
```

---

## Adding or Removing Events

Events are managed in `mac-scraper/events.json` — just a text file you can edit.

**To add an event:** Add a new entry to the JSON array with the event's details and Ticketmaster URL.

**To remove an event:** Delete its entry from the array.

**To see changes:** Restart the scraper (`Ctrl+C` then `bash mac-scraper/start.sh` again, or `pm2 restart ticket-tracker`).

---

## What Happens Each Cycle

Every 5 minutes:
1. Scraper opens Chrome (invisibly — you won't see it)
2. Visits each of the 8 ticket platforms for each event
3. Reads the current lowest price from each site
4. Writes all prices to `docs/prices.json` (updates as each event finishes)
5. Runs `git push` to send the file to GitHub
6. GitHub Pages serves the updated file at `kohlirishi.github.io/Ticket_Price_Monitor`
7. The website auto-detects the new file and refreshes

First cycle takes ~3-4 minutes (7 events × ~25 seconds). Subsequent cycles are the same.

---

## If Something Goes Wrong

**"Chrome not found"** — Install Google Chrome from google.com/chrome

**"Node.js not found"** — Install Node.js 20 LTS from nodejs.org

**"GITHUB_TOKEN is still placeholder"** — Open `mac-scraper/.env` and add your real token

**"git push failed"** — Check your GITHUB_TOKEN is correct and has `repo` scope. Also check your internet connection.

**"Puppeteer error / browser crashed"** — This happens occasionally. The scraper auto-recovers on the next cycle.

**Prices still show "No prices found"** — Some platforms actively block scrapers. Ticketmaster, StubHub, and Viagogo often block even home IPs. Other platforms like SeatGeek and VividSeats usually work.

---

## Keeping Your Mac Awake

The `start.sh` script uses `caffeinate -i` which prevents your Mac from going to sleep while the scraper is running. If you use pm2 instead, you may want to enable "Prevent automatic sleeping" in System Settings → Battery (or Energy Saver).

---

## Stopping the Scraper

- If using Terminal: press **Ctrl+C**
- If using pm2: run `pm2 stop ticket-tracker`
