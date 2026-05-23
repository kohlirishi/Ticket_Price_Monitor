# Toronto Ticket Tracker

Live ticket price comparison across Ticketmaster, StubHub, VividSeats, Viagogo, and SeatGeek — refreshed every 60 seconds.

---

## Project Layout

```
Ticket_Price_Monitor/
├── frontend/
│   └── index.html          ← GitHub Pages site
├── backend/
│   ├── server.js           ← Express API + cron jobs
│   ├── scraper.js          ← Puppeteer scrapers (5 platforms)
│   ├── db.js               ← JSON file persistence
│   ├── package.json
│   ├── render.yaml         ← Render.com config
│   └── data/               ← Auto-created; stores db.json
├── .gitignore
└── README.md
```

---

## Step 1 — Deploy the Backend to Render.com

1. Push this repo to GitHub.
2. Go to [render.com](https://render.com) → **New** → **Web Service**.
3. Connect your GitHub repo.
4. Set these values:
   - **Root Directory**: `backend`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Health Check Path**: `/api/health`
   - **Plan**: Free
5. Under **Environment Variables**, add:
   | Key | Value |
   |-----|-------|
   | `NODE_ENV` | `production` |
   | `RENDER_URL` | *(your Render URL — fill in after first deploy)* |
   | `FRONTEND_URL` | *(your GitHub Pages URL — fill in after step 2)* |
6. Click **Deploy**. First deploy takes 3–5 minutes (installs Chromium).
7. Copy your service URL — it looks like `https://toronto-ticket-tracker-xxxx.onrender.com`.

---

## Step 2 — Enable GitHub Pages for the Frontend

1. In your GitHub repo, go to **Settings → Pages**.
2. Under **Source**, select **Deploy from a branch**.
3. Set **Branch** = `main` (or your default branch) and **Folder** = `/frontend`.
4. Click **Save**. GitHub will give you a URL like `https://your-username.github.io/Ticket_Price_Monitor`.

---

## Step 3 — Wire Up the Frontend → Backend URL

Open `frontend/index.html` and find this line near the bottom of the `<script>` block:

```js
const API_BASE = 'https://YOUR-APP.onrender.com'; // ← UPDATE THIS
```

Replace it with your actual Render URL from Step 1:

```js
const API_BASE = 'https://toronto-ticket-tracker-xxxx.onrender.com';
```

Commit and push. GitHub Pages will redeploy automatically.

---

## Step 4 — Lock Down CORS (Recommended)

Once you know your GitHub Pages URL, update the CORS setting in Render's environment variables:

| Key | Value |
|-----|-------|
| `FRONTEND_URL` | `https://your-username.github.io` |

Render automatically restarts the service when env vars change.

You can also update `render.yaml` → `FRONTEND_URL` value and redeploy.

---

## Step 5 — Set RENDER_URL for Self-Pinging

Add your Render service URL as the `RENDER_URL` env var on Render (or update `render.yaml`). This lets the backend ping itself every 10 minutes so Render's free tier doesn't spin down.

---

## Local Development

```bash
cd backend
npm install

# Requires Google Chrome installed locally
node server.js
```

The API runs at `http://localhost:3000`. Open `frontend/index.html` directly in your browser and temporarily change `API_BASE` to `http://localhost:3000` for local testing.

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/events` | List all tracked events |
| `POST` | `/api/events` | Add event `{ ticketmasterUrl, vividSeatsUrl? }` |
| `DELETE` | `/api/events/:id` | Remove event |
| `GET` | `/api/prices` | Latest prices for all events |
| `GET` | `/api/prices/:eventId` | Latest prices for one event |
| `POST` | `/api/scrape/:eventId` | Force re-scrape for one event |

---

## Notes

- **StubHub & Viagogo** use heavy Cloudflare bot protection and will typically return "Check Manually" links rather than live prices. This is expected.
- **VividSeats** prices are shown in USD with an estimated CAD conversion at 1 USD = 1.36 CAD.
- Prices update every 60 seconds via cron. Each scrape cycle takes ~35–45 seconds (5 sites × 5-second delay between each).
- Data persists in `backend/data/db.json` across Render restarts.
- Render free tier spins down after 15 minutes of inactivity — the self-ping cron prevents this.
