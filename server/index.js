import cors from 'cors'
import express from 'express'
import fs from 'node:fs/promises'
import mongoose from 'mongoose'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.join(__dirname, 'data')
const LEADERBOARD_FILE = path.join(DATA_DIR, 'leaderboard.json')
const PORT = Number(process.env.PORT) || 3001
const MONGODB_URI = process.env.MONGODB_URI?.trim()

const USERNAME_PATTERN = /^[a-zA-Z0-9 _-]{3,20}$/

function clampNumber(value, fallback = 0) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.max(0, Math.round(parsed))
}

function sanitizeUsername(raw) {
  if (typeof raw !== 'string') {
    return null
  }
  const trimmed = raw.trim()
  if (!USERNAME_PATTERN.test(trimmed)) {
    return null
  }
  return trimmed
}

function normalizeUpgrades(raw) {
  if (!raw || typeof raw !== 'object') {
    return {}
  }

  const next = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || key.length > 64) {
      continue
    }
    next[key] = clampNumber(value, 0)
  }
  return next
}

function normalizeSlotLevels(raw) {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.slice(0, 20).map((entry) => clampNumber(entry, 1))
}

function normalizeOwnedSkins(raw) {
  if (!Array.isArray(raw)) {
    return []
  }
  return [...new Set(raw.filter((entry) => typeof entry === 'string').slice(0, 80))]
}

function normalizeEntry(raw) {
  const username = sanitizeUsername(raw?.username)
  if (!username) {
    return null
  }

  const now = new Date().toISOString()
  return {
    username,
    coins: clampNumber(raw?.coins, 0),
    totalCoins: clampNumber(raw?.totalCoins, 0),
    totalBalls: clampNumber(raw?.totalBalls, 1),
    upgrades: normalizeUpgrades(raw?.upgrades),
    slotLevels: normalizeSlotLevels(raw?.slotLevels),
    ownedSkins: normalizeOwnedSkins(raw?.ownedSkins),
    selectedSkin: typeof raw?.selectedSkin === 'string' ? raw.selectedSkin : 'default',
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : now,
  }
}

async function ensureStorage() {
  await fs.mkdir(DATA_DIR, { recursive: true })
  try {
    await fs.access(LEADERBOARD_FILE)
  } catch {
    await fs.writeFile(LEADERBOARD_FILE, '[]', 'utf-8')
  }
}

async function readEntries() {
  await ensureStorage()
  try {
    const text = await fs.readFile(LEADERBOARD_FILE, 'utf-8')
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.map(normalizeEntry).filter(Boolean)
  } catch {
    return []
  }
}

async function writeEntries(entries) {
  await ensureStorage()
  const payload = JSON.stringify(entries, null, 2)
  await fs.writeFile(LEADERBOARD_FILE, payload, 'utf-8')
}

function sortByCoins(entries) {
  return [...entries].sort((a, b) => {
    if (b.coins !== a.coins) {
      return b.coins - a.coins
    }
    return a.username.localeCompare(b.username)
  })
}

async function createFileStorage() {
  return {
    mode: 'file',
    async list(limit) {
      return sortByCoins(await readEntries()).slice(0, limit)
    },
    async getByUsername(username) {
      const entries = sortByCoins(await readEntries())
      const index = entries.findIndex((entry) => entry.username.toLowerCase() === username.toLowerCase())
      if (index === -1) {
        return null
      }
      return {
        rank: index + 1,
        player: entries[index],
      }
    },
    async upsert(entry) {
      const entries = await readEntries()
      const existingIndex = entries.findIndex((item) => item.username.toLowerCase() === entry.username.toLowerCase())

      if (existingIndex >= 0) {
        entries[existingIndex] = entry
      } else {
        entries.push(entry)
      }

      const sorted = sortByCoins(entries)
      await writeEntries(sorted)
      const rank = sorted.findIndex((item) => item.username.toLowerCase() === entry.username.toLowerCase()) + 1

      return {
        rank,
        player: entry,
      }
    },
  }
}

function createMongoEntryModel() {
  const schema = new mongoose.Schema(
    {
      username: { type: String, required: true },
      usernameKey: { type: String, required: true, unique: true, index: true },
      coins: { type: Number, required: true, default: 0 },
      totalCoins: { type: Number, required: true, default: 0 },
      totalBalls: { type: Number, required: true, default: 1 },
      upgrades: { type: mongoose.Schema.Types.Mixed, default: {} },
      slotLevels: { type: [Number], default: [] },
      ownedSkins: { type: [String], default: [] },
      selectedSkin: { type: String, default: 'default' },
      updatedAt: { type: String, required: true },
    },
    {
      versionKey: false,
    },
  )

  return mongoose.models.LeaderboardEntry || mongoose.model('LeaderboardEntry', schema, 'leaderboard_entries')
}

function mapMongoDocToEntry(doc) {
  return normalizeEntry(doc) ?? normalizeEntry({ username: doc.username })
}

async function createMongoStorage(uri) {
  await mongoose.connect(uri)
  const Entry = createMongoEntryModel()

  return {
    mode: 'mongo',
    async list(limit) {
      const docs = await Entry.find({}).sort({ coins: -1, username: 1 }).limit(limit).lean()
      return docs.map(mapMongoDocToEntry).filter(Boolean)
    },
    async getByUsername(username) {
      const usernameKey = username.toLowerCase()
      const doc = await Entry.findOne({ usernameKey }).lean()
      if (!doc) {
        return null
      }

      const player = mapMongoDocToEntry(doc)
      const rankAbove = await Entry.countDocuments({
        $or: [
          { coins: { $gt: player.coins } },
          { coins: player.coins, username: { $lt: player.username } },
        ],
      })

      return {
        rank: rankAbove + 1,
        player,
      }
    },
    async upsert(entry) {
      const usernameKey = entry.username.toLowerCase()
      await Entry.findOneAndUpdate(
        { usernameKey },
        {
          $set: {
            ...entry,
            usernameKey,
          },
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        },
      )

      const rankAbove = await Entry.countDocuments({
        $or: [
          { coins: { $gt: entry.coins } },
          { coins: entry.coins, username: { $lt: entry.username } },
        ],
      })

      return {
        rank: rankAbove + 1,
        player: entry,
      }
    },
  }
}

const app = express()
let storage

app.use(cors())
app.use(express.json({ limit: '500kb' }))

app.get('/', (_req, res) => {
  res.json({ name: 'Plinko Leaderboard API', status: 'ok', endpoints: ['/api/health', '/api/leaderboard'] })
})

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    storage: storage?.mode ?? 'unknown',
  })
})

app.get('/api/leaderboard', async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
  const entries = await storage.list(limit)

  const withRank = entries.map((entry, index) => ({
    rank: index + 1,
    ...entry,
  }))

  res.json({
    entries: withRank,
    updatedAt: new Date().toISOString(),
  })
})

app.get('/api/leaderboard/:username', async (req, res) => {
  const username = sanitizeUsername(req.params.username)
  if (!username) {
    res.status(400).json({ error: 'Invalid username.' })
    return
  }

  const result = await storage.getByUsername(username)
  if (!result) {
    res.status(404).json({ error: 'Player not found.' })
    return
  }

  res.json({
    rank: result.rank,
    player: result.player,
  })
})

app.post('/api/leaderboard/submit', async (req, res) => {
  const username = sanitizeUsername(req.body?.username)
  if (!username) {
    res.status(400).json({ error: 'Username must be 3-20 characters using letters, numbers, spaces, _ or -.' })
    return
  }

  const nextEntry = normalizeEntry({
    ...req.body,
    username,
    updatedAt: new Date().toISOString(),
  })

  if (!nextEntry) {
    res.status(400).json({ error: 'Invalid payload.' })
    return
  }

  const result = await storage.upsert(nextEntry)

  res.json({
    ok: true,
    rank: result.rank,
    player: result.player,
  })
})

async function initStorage() {
  if (MONGODB_URI) {
    try {
      storage = await createMongoStorage(MONGODB_URI)
      return
    } catch (error) {
      console.error('MongoDB connection failed, falling back to file storage:', error.message)
    }
  }

  storage = await createFileStorage()
}

async function startServer() {
  await initStorage()

  app.listen(PORT, () => {
    console.log(`Leaderboard server running at http://localhost:${PORT}`)
    console.log(`Leaderboard storage mode: ${storage.mode}`)
  })
}

startServer().catch((error) => {
  console.error('Failed to start leaderboard server:', error)
  process.exit(1)
})
