import cors from 'cors'
import crypto from 'node:crypto'
import express from 'express'
import fs from 'node:fs/promises'
import mongoose from 'mongoose'
import path from 'node:path'
import rateLimit from 'express-rate-limit'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.join(__dirname, 'data')
const LEADERBOARD_FILE = path.join(DATA_DIR, 'leaderboard.json')
const PORT = Number(process.env.PORT) || 3001
const MONGODB_URI = process.env.MONGODB_URI?.trim()
const READ_ONLY_MODE = /^(1|true|yes)$/i.test(process.env.READ_ONLY_MODE ?? '')
const EMERGENCY_SHUTDOWN = /^(1|true|yes)$/i.test(process.env.EMERGENCY_SHUTDOWN ?? '')
const SUBMIT_RATE_LIMIT_MAX = Math.max(1, Number(process.env.SUBMIT_RATE_LIMIT_MAX) || 30)
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

const USERNAME_PATTERN = /^[a-zA-Z0-9 _-]{3,20}$/
const OWNER_TOKEN_PATTERN = /^[a-f0-9]{64}$/i
const MAX_RESOURCE_VALUE = Number.MAX_SAFE_INTEGER
const MAX_TOTAL_BALLS = 9999
const MAX_SLOT_LEVEL = 9999
const VALID_SKIN_IDS = new Set(['default', 'ember', 'frostbyte', 'verdant', 'voidsteel', 'prisma'])
const UPGRADE_LIMITS = {
  ballsPerDrop: { min: 1, max: 20, fallback: 1 },
  gravityLevel: { min: 1, max: 20, fallback: 1 },
  pegLevel: { min: 1, max: 20, fallback: 1 },
  rainbowLevel: { min: 0, max: 20, fallback: 0 },
  slotGlobalLevel: { min: 1, max: 20, fallback: 1 },
  gatekeeperLevel: { min: 0, max: 15, fallback: 0 },
}

function clampNumber(value, fallback = 0, min = 0, max = MAX_RESOURCE_VALUE) {
  let parsed = Number(value)
  if (!Number.isFinite(parsed) && value && typeof value === 'object') {
    if (value._bsontype === 'Long' && typeof value.toString === 'function') {
      parsed = Number(value.toString())
    } else if (value._bsontype === 'Decimal128' && typeof value.toString === 'function') {
      parsed = Number(value.toString())
    }
  }
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.round(parsed)))
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

function sanitizeOwnerToken(raw) {
  if (typeof raw !== 'string') {
    return null
  }
  const trimmed = raw.trim().toLowerCase()
  if (!OWNER_TOKEN_PATTERN.test(trimmed)) {
    return null
  }
  return trimmed
}

function hashOwnerToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function normalizeOwnerTokenHash(raw) {
  if (typeof raw !== 'string') {
    return null
  }
  const trimmed = raw.trim().toLowerCase()
  if (!OWNER_TOKEN_PATTERN.test(trimmed)) {
    return null
  }
  return trimmed
}

function toPublicEntry(entry) {
  const { ownerTokenHash: _ownerTokenHash, ...publicEntry } = entry
  return publicEntry
}

function createRankedResponse(entries, username) {
  const sorted = sortByCoins(entries)
  const rank = sorted.findIndex((item) => item.username.toLowerCase() === username.toLowerCase()) + 1
  const player = sorted.find((item) => item.username.toLowerCase() === username.toLowerCase())

  return {
    rank,
    player: player ? toPublicEntry(player) : null,
  }
}

function normalizeUpgrades(raw) {
  if (!raw || typeof raw !== 'object') {
    return Object.fromEntries(
      Object.entries(UPGRADE_LIMITS).map(([key, limits]) => [key, limits.fallback]),
    )
  }

  const next = {}
  for (const [key, limits] of Object.entries(UPGRADE_LIMITS)) {
    next[key] = clampNumber(raw[key], limits.fallback, limits.min, limits.max)
  }
  return next
}

function normalizeSlotLevels(raw) {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.slice(0, 20).map((entry) => clampNumber(entry, 1, 1, MAX_SLOT_LEVEL))
}

function normalizeOwnedSkins(raw) {
  if (!Array.isArray(raw)) {
    return ['default']
  }
  const skins = [...new Set(raw.filter((entry) => typeof entry === 'string' && VALID_SKIN_IDS.has(entry)).slice(0, 80))]
  if (!skins.includes('default')) {
    skins.unshift('default')
  }
  return skins
}

function normalizeEntry(raw) {
  const username = sanitizeUsername(raw?.username)
  if (!username) {
    return null
  }

  const now = new Date().toISOString()
  const totalBalls = clampNumber(raw?.totalBalls, 1, 1, MAX_TOTAL_BALLS)
  const ownedSkins = normalizeOwnedSkins(raw?.ownedSkins)
  const selectedSkin =
    typeof raw?.selectedSkin === 'string' && VALID_SKIN_IDS.has(raw.selectedSkin) && ownedSkins.includes(raw.selectedSkin)
      ? raw.selectedSkin
      : 'default'

  return {
    username,
    coins: clampNumber(raw?.coins, 0, 0, MAX_RESOURCE_VALUE),
    totalCoins: clampNumber(raw?.totalCoins, 0, 0, MAX_RESOURCE_VALUE),
    totalBalls,
    upgrades: normalizeUpgrades(raw?.upgrades),
    slotLevels: normalizeSlotLevels(raw?.slotLevels),
    ownedSkins,
    selectedSkin,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : now,
    goldenBalls: clampNumber(raw?.goldenBalls, 0, 0, totalBalls),
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
    return parsed
      .map((raw) => {
        const entry = normalizeEntry(raw)
        if (!entry) {
          return null
        }
        return {
          ...entry,
          ownerTokenHash: normalizeOwnerTokenHash(raw?.ownerTokenHash),
        }
      })
      .filter(Boolean)
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
  let writeQueue = Promise.resolve()

  function runExclusive(task) {
    const next = writeQueue.then(task, task)
    writeQueue = next.catch(() => undefined)
    return next
  }

  return {
    mode: 'file',
    async list(limit) {
      return sortByCoins(await readEntries()).slice(0, limit).map(toPublicEntry)
    },
    async getByUsername(username) {
      const entries = sortByCoins(await readEntries())
      const index = entries.findIndex((entry) => entry.username.toLowerCase() === username.toLowerCase())
      if (index === -1) {
        return null
      }
      return {
        rank: index + 1,
        player: toPublicEntry(entries[index]),
      }
    },
    async upsert(entry, ownerTokenHash) {
      return runExclusive(async () => {
        const entries = await readEntries()
        const existingIndex = entries.findIndex((item) => item.username.toLowerCase() === entry.username.toLowerCase())

        if (existingIndex >= 0) {
          const existingOwnerTokenHash = normalizeOwnerTokenHash(entries[existingIndex].ownerTokenHash)
          if (!existingOwnerTokenHash) {
            return {
              error: 'legacy_entry_locked',
            }
          }
          if (existingOwnerTokenHash !== ownerTokenHash) {
            return {
              error: 'ownership_required',
            }
          }

          entries[existingIndex] = {
            ...entry,
            ownerTokenHash: existingOwnerTokenHash,
          }
        } else {
          entries.push({
            ...entry,
            ownerTokenHash,
          })
        }

        await writeEntries(sortByCoins(entries))
        return createRankedResponse(entries, entry.username)
      })
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
      goldenBalls: { type: Number, required: true, default: 0 },
      upgrades: { type: mongoose.Schema.Types.Mixed, default: {} },
      slotLevels: { type: [Number], default: [] },
      ownedSkins: { type: [String], default: [] },
      selectedSkin: { type: String, default: 'default' },
      ownerTokenHash: { type: String, default: null },
      updatedAt: { type: String, required: true },
    },
    {
      versionKey: false,
    },
  )

  return mongoose.models.LeaderboardEntry || mongoose.model('LeaderboardEntry', schema, 'leaderboard_entries')
}

function mapMongoDocToStoredEntry(doc) {
  const entry = normalizeEntry(doc) ?? normalizeEntry({ username: doc.username })
  if (!entry) {
    return null
  }
  return {
    ...entry,
    ownerTokenHash: normalizeOwnerTokenHash(doc?.ownerTokenHash),
  }
}

async function createMongoStorage(uri) {
  await mongoose.connect(uri)
  const Entry = createMongoEntryModel()

  return {
    mode: 'mongo',
    async list(limit) {
      const docs = await Entry.find({}).sort({ coins: -1, username: 1 }).limit(limit).lean()
      return docs.map(mapMongoDocToStoredEntry).filter(Boolean).map(toPublicEntry)
    },
    async getByUsername(username) {
      const usernameKey = username.toLowerCase()
      const doc = await Entry.findOne({ usernameKey }).lean()
      if (!doc) {
        return null
      }

      const storedEntry = mapMongoDocToStoredEntry(doc)
      if (!storedEntry) {
        return null
      }
      const player = toPublicEntry(storedEntry)
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
    async upsert(entry, ownerTokenHash) {
      const usernameKey = entry.username.toLowerCase()
      const existingDoc = await Entry.findOne({ usernameKey }).lean()
      if (existingDoc) {
        const existingOwnerTokenHash = normalizeOwnerTokenHash(existingDoc.ownerTokenHash)
        if (!existingOwnerTokenHash) {
          return {
            error: 'legacy_entry_locked',
          }
        }
        if (existingOwnerTokenHash !== ownerTokenHash) {
          return {
            error: 'ownership_required',
          }
        }
      }

      // Use collection.updateOne to bypass Mongoose's Int32 coercion so that
      // coins and totalCoins are always stored as BSON Double regardless of
      // magnitude, allowing values well beyond the Int32 limit (2,147,483,647).
      const { Double } = mongoose.mongo
      await Entry.collection.updateOne(
        { usernameKey },
        {
          $set: {
            ...entry,
            usernameKey,
            coins: new Double(entry.coins),
            totalCoins: new Double(entry.totalCoins),
            goldenBalls: entry.goldenBalls,
            ownerTokenHash,
          },
        },
        { upsert: true },
      )

      const savedDoc = await Entry.findOne({ usernameKey }).lean()
      const storedEntry = savedDoc ? mapMongoDocToStoredEntry(savedDoc) : { ...entry, ownerTokenHash }
      const player = storedEntry ? toPublicEntry(storedEntry) : toPublicEntry({ ...entry, ownerTokenHash })

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
  }
}

const app = express()
let storage

const allowedOrigins = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://peg-1.netlify.app',
  ...CORS_ORIGINS,
])

const corsOptions = {
  origin(origin, callback) {
    // Allow same-origin/non-browser requests with no Origin header.
    if (!origin) {
      callback(null, true)
      return
    }
    if (allowedOrigins.has(origin)) {
      callback(null, true)
      return
    }
    callback(new Error(`CORS blocked for origin: ${origin}`))
  },
  methods: ['GET', 'POST', 'OPTIONS'],
}

app.use(cors(corsOptions))
app.options('*', cors(corsOptions))
app.use(express.json({ limit: '500kb' }))

app.use((req, res, next) => {
  if (!EMERGENCY_SHUTDOWN) {
    next()
    return
  }

  res.status(503).json({
    error: 'Service temporarily unavailable.',
    maintenance: true,
  })
})

app.get('/', (_req, res) => {
  res.json({ name: 'Plinko Leaderboard API', status: 'ok', endpoints: ['/api/health', '/api/leaderboard'] })
})

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    storage: storage?.mode ?? 'unknown',
    readOnlyMode: READ_ONLY_MODE,
    emergencyShutdown: EMERGENCY_SHUTDOWN,
  })
})

app.get('/api/leaderboard', async (req, res) => {
  try {
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
  } catch (error) {
    console.error('Failed to load leaderboard:', error)
    res.status(500).json({ error: 'Failed to load leaderboard.' })
  }
})

app.get('/api/leaderboard/:username', async (req, res) => {
  const username = sanitizeUsername(req.params.username)
  if (!username) {
    res.status(400).json({ error: 'Invalid username.' })
    return
  }

  try {
    const result = await storage.getByUsername(username)
    if (!result) {
      res.status(404).json({ error: 'Player not found.' })
      return
    }

    res.json({
      rank: result.rank,
      player: result.player,
    })
  } catch (error) {
    console.error('Failed to load player profile:', error)
    res.status(500).json({ error: 'Failed to load player profile.' })
  }
})

const submitLimiter = rateLimit({
  windowMs: 60_000,
  max: SUBMIT_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please slow down.' },
})

app.post('/api/leaderboard/submit', submitLimiter, async (req, res) => {
  if (READ_ONLY_MODE) {
    res.status(503).json({
      error: 'Leaderboard submissions are temporarily disabled.',
      readOnlyMode: true,
    })
    return
  }

  const ownerToken = sanitizeOwnerToken(req.get('x-player-token'))
  if (!ownerToken) {
    res.status(401).json({ error: 'A valid player ownership token is required for submissions.' })
    return
  }
  const ownerTokenHash = hashOwnerToken(ownerToken)

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

  try {
    const result = await storage.upsert(nextEntry, ownerTokenHash)

    if (result?.error === 'ownership_required') {
      res.status(403).json({ error: 'Submission blocked. This username is owned by another player token.' })
      return
    }

    if (result?.error === 'legacy_entry_locked') {
      res.status(409).json({ error: 'This legacy username is locked and cannot be updated without migration.' })
      return
    }

    res.json({
      ok: true,
      rank: result.rank,
      player: result.player,
    })
  } catch (error) {
    console.error('Failed to submit leaderboard score:', error)
    res.status(500).json({ error: 'Could not submit score.' })
  }
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
    console.log(`Leaderboard read-only mode: ${READ_ONLY_MODE}`)
    console.log(`Leaderboard emergency shutdown: ${EMERGENCY_SHUTDOWN}`)
  })
}

startServer().catch((error) => {
  console.error('Failed to start leaderboard server:', error)
  process.exit(1)
})
