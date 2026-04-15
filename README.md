# Peg

Retro roguelike browser-based Plinko built with React, Vite, and Matter.js.

## Features

- Physics-driven peg board using Matter.js.
- Coin economy with upgrades and scaling costs.
- Slot progression and payout growth over time.
- Toggleable settings panel with sound on/off and volume slider.
- Main nav tabs for `Play` and `Leaderboard` views.
- New `Clans` tab with create/join flows, clan leaderboard, and clan home.
- Real-time clan chat (Socket.IO) scoped to clan membership.
- Clan war timeline with bi-weekly cycle and 3-day active war window.
- Persistent Node.js global leaderboard (file-backed) with top-3 badges and player profile inspection.
- Retro pixel-inspired UI and animated reward floaters.

## Tech Stack

- React 19
- Vite 8
- Matter.js
- Socket.IO
- Express + Mongoose (MongoDB for clans)

## Getting Started

### Prerequisites

- Node.js 18+ (or current LTS)
- npm

### Install

```bash
npm install
```

### Run Development Server

```bash
npm run dev
```

Optional env var for custom API target (frontend):

```env
VITE_API_BASE_URL=""
```

Leave it empty for local Vite proxy behavior.

### Run Leaderboard Server

```bash
npm run server
```

Run `npm run dev` and `npm run server` in separate terminals during development.

The frontend calls `/api/*` and is proxied to `http://localhost:3001` in development.

### Netlify / Static Hosting Notes

Netlify hosts this frontend as static files only. The leaderboard API must be deployed separately (for example Render, Railway, Fly.io, or your own server).

Set a Netlify environment variable so the frontend points to your deployed backend:

- `VITE_API_BASE_URL=https://your-backend-domain.com`

Then redeploy the site.

Also allow your Netlify site origin in backend CORS settings.

### Emergency Shutdown / Read-Only Mode

If you need to contain an incident quickly:

- Set `EMERGENCY_SHUTDOWN=true` on the backend to return `503` for every request.
- Set `READ_ONLY_MODE=true` on the backend to keep reads available but block `POST /api/leaderboard/submit`.

PowerShell example:

```powershell
$env:EMERGENCY_SHUTDOWN="true"
npm run server
```

Or keep the leaderboard visible while stopping new writes:

```powershell
$env:READ_ONLY_MODE="true"
npm run server
```

If the backend is deployed on Render, Railway, Fly.io, or similar, set the same environment variable in the host dashboard and redeploy/restart the service.

### Global Persistent Mode (MongoDB Atlas)

To make the leaderboard persistent globally (shared by all users and not tied to one local machine), run the server with a hosted MongoDB database.

Important for clans: Clan APIs require MongoDB mode (`MONGODB_URI` must be set). If MongoDB is not configured, leaderboard works in file mode but clans are disabled.

1. Create a MongoDB Atlas cluster and database user.
2. Add your app host/IP to Atlas network access.
3. Set environment variable `MONGODB_URI` before starting the server.

Recommended local setup:

1. Create a `.env` file in the project root.
2. Add your Atlas URI:

```env
MONGODB_URI="mongodb+srv://<username>:<password>@<cluster>/<database>?retryWrites=true&w=majority"
```

3. Load it in your terminal session before running the server (PowerShell):

```powershell
Get-Content .env | ForEach-Object {
	if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
	$name, $value = $_ -split '=', 2
	$env:$name = $value.Trim('"')
}
npm run server
```

`.env` is ignored by git in `.gitignore`.

PowerShell example:

```powershell
$env:MONGODB_URI="mongodb+srv://<user>:<password>@<cluster>/<db>?retryWrites=true&w=majority"
npm run server
```

If `MONGODB_URI` is not set, the server falls back to local file storage (`server/data/leaderboard.json`).

### Build for Production

```bash
npm run build
```

### Preview Production Build

```bash
npm run preview
```

## Project Structure

```text
src/
	App.jsx        # Main game logic, physics wiring, upgrades, UI
	App.css        # Retro styling and responsive layout
	index.css      # Global baseline styles
server/
	index.js       # Persistent leaderboard API
	data/
		leaderboard.json
public/
index.html
```

## Gameplay Notes

- Peg collisions can award bonus coins based on upgrade chance.
- Slots level up as they fill, improving payouts.
- Ball count is capped by owned balls.
- Submit your current profile to the global leaderboard from the `Leaderboard` tab.

## Leaderboard API

Base URL (dev): `http://localhost:3001`

- `GET /api/health` - health check
- `GET /api/leaderboard?limit=50` - ranked entries by coins
- `GET /api/leaderboard/:username` - single player profile and rank
- `POST /api/leaderboard/submit` - create/update a player entry

## Clans API

All clan mutation/read endpoints require:

- A valid leaderboard username (`username` query/body field)
- `x-player-token` header (same token used for leaderboard ownership)

Main endpoints:

- `GET /api/clans?limit=60&search=name` - clan leaderboard/search by score
- `GET /api/clans/war-leaderboard` - leaderboard ranked by clan war wins
- `GET /api/clans/me?username=...` - current player's clan + war notification state
- `POST /api/clans` - create clan (multipart form: `name`, `description`, `joinPermission`, `icon`, `username`)
- `POST /api/clans/:clanKey/join` - join public clan
- `GET /api/clans/:clanKey/home?username=...` - clan home, war state, and war leaderboard snapshot
- `GET /api/clans/:clanKey/chat?username=...&limit=120` - clan chat history
- `POST /api/clans/:clanKey/chat` - send chat message
- `POST /api/clans/war/progress` - submit member totalCoins during active war
- `POST /api/clans/war/ack` - acknowledge clan war notification

Socket.IO events:

- Client emits `clan:join` with `{ clanKey, username, token }`
- Server emits `clan:message` for real-time chat updates

## Render Deployment Notes For Clans

If you are deploying backend on Render and frontend separately (Netlify/Vercel/etc), set these manually:

1. `MONGODB_URI`: MongoDB Atlas connection string
2. `CORS_ORIGINS`: comma-separated frontend origins, e.g. `https://your-frontend.com,https://www.your-frontend.com`
3. Optional safety toggles: `READ_ONLY_MODE`, `EMERGENCY_SHUTDOWN`

Required backend dependencies were added:

- `socket.io`
- `multer`

Frontend dependency added:

- `socket.io-client`

Because clan icons are uploaded, icons are currently stored as base64 data URLs in MongoDB for portability on Render's ephemeral filesystem.

Submission ownership protection:

- `POST /api/leaderboard/submit` now requires a player ownership token.
- Send token via `x-player-token` header (or `ownerToken` in JSON body).
- New usernames are bound to the first valid token that creates them.
- Existing protected usernames can only be updated with the same token.
- Legacy usernames without a stored token are locked from updates until migrated.

Submission payload fields used by the app:

- `username` (3-20 chars, letters/numbers/spaces/`_`/`-`)
- `coins`
- `totalCoins`
- `totalBalls`
- `upgrades`
- `slotLevels`
- `ownedSkins`
- `selectedSkin`
- `ownerToken` (64-char hex token, or pass in `x-player-token` header)

Data persistence:

- Global mode: MongoDB Atlas (`MONGODB_URI`)
- Local fallback: `server/data/leaderboard.json`
- Entries are updated by username (case-insensitive)

Health endpoint output includes storage mode:

- `storage: "mongo"` for globally persistent mode
- `storage: "file"` for local fallback mode

## License
MIT License
