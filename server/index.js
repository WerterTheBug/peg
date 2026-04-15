import cors from 'cors'
import crypto from 'node:crypto'
import express from 'express'
import fs from 'node:fs/promises'
import http from 'node:http'
import mongoose from 'mongoose'
import multer from 'multer'
import path from 'node:path'
import rateLimit from 'express-rate-limit'
import { Server as SocketIOServer } from 'socket.io'
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
const CLAN_NAME_PATTERN = /^[a-zA-Z0-9 _-]{3,24}$/
const MAX_CLAN_DESCRIPTION_LENGTH = 200
const MAX_RESOURCE_VALUE = Number.MAX_SAFE_INTEGER
const MAX_TOTAL_BALLS = 9999
const MAX_SLOT_LEVEL = 9999
const MAX_CLAN_ICON_BYTES = 1024 * 1024
const CHAT_MESSAGE_MAX = 280
const VALID_SKIN_IDS = new Set(['default', 'ember', 'frostbyte', 'verdant', 'voidsteel', 'prisma'])

const WAR_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000
const WAR_DURATION_MS = 3 * 24 * 60 * 60 * 1000
const WAR_EPOCH_MS = Date.UTC(2026, 0, 5, 0, 0, 0, 0)

const UPGRADE_LIMITS = {
  ballsPerDrop: { min: 1, max: 20, fallback: 1 },
  gravityLevel: { min: 1, max: 20, fallback: 1 },
  pegLevel: { min: 1, max: 20, fallback: 1 },
  rainbowLevel: { min: 0, max: 20, fallback: 0 },
  slotGlobalLevel: { min: 1, max: 20, fallback: 1 },
  gatekeeperLevel: { min: 0, max: 15, fallback: 0 },
}

let storage
let leaderboardEntryModel = null
let clanModel = null
let clanMessageModel = null
let io = null

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
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!USERNAME_PATTERN.test(trimmed)) return null
  return trimmed
}

function sanitizeOwnerToken(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().toLowerCase()
  if (!OWNER_TOKEN_PATTERN.test(trimmed)) return null
  return trimmed
}

function hashOwnerToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function normalizeOwnerTokenHash(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().toLowerCase()
  if (!OWNER_TOKEN_PATTERN.test(trimmed)) return null
  return trimmed
}

function sanitizeClanName(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!CLAN_NAME_PATTERN.test(trimmed)) return null
  return trimmed
}

function sanitizeDescription(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > MAX_CLAN_DESCRIPTION_LENGTH) return null
  return trimmed
}

function sanitizeJoinPermission(raw) {
  if (typeof raw !== 'string') return null
  const normalized = raw.trim().toLowerCase()
  if (normalized !== 'public' && normalized !== 'private') return null
  return normalized
}

function sanitizeChatMessage(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > CHAT_MESSAGE_MAX) return null
  return trimmed
}

function toClanKey(name) {
  return name.trim().toLowerCase().replace(/\s+/g, '-')
}

function nowIso() {
  return new Date().toISOString()
}

function toPublicEntry(entry) {
  const { ownerTokenHash: _ownerTokenHash, ...publicEntry } = entry
  return publicEntry
}

function normalizeUpgrades(raw) {
  if (!raw || typeof raw !== 'object') {
    return Object.fromEntries(Object.entries(UPGRADE_LIMITS).map(([key, limits]) => [key, limits.fallback]))
  }

  const next = {}
  for (const [key, limits] of Object.entries(UPGRADE_LIMITS)) {
    next[key] = clampNumber(raw[key], limits.fallback, limits.min, limits.max)
  }
  return next
}

function normalizeSlotLevels(raw) {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 20).map((entry) => clampNumber(entry, 1, 1, MAX_SLOT_LEVEL))
}

function normalizeOwnedSkins(raw) {
  if (!Array.isArray(raw)) return ['default']
  const skins = [...new Set(raw.filter((entry) => typeof entry === 'string' && VALID_SKIN_IDS.has(entry)).slice(0, 80))]
  if (!skins.includes('default')) skins.unshift('default')
  return skins
}

function normalizeEntry(raw) {
  const username = sanitizeUsername(raw?.username)
  if (!username) return null

  const now = nowIso()
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
    if (!Array.isArray(parsed)) return []

    return parsed
      .map((raw) => {
        const entry = normalizeEntry(raw)
        if (!entry) return null
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
  await fs.writeFile(LEADERBOARD_FILE, JSON.stringify(entries, null, 2), 'utf-8')
}

function sortByCoins(entries) {
  return [...entries].sort((a, b) => {
    if (b.coins !== a.coins) return b.coins - a.coins
    return a.username.localeCompare(b.username)
  })
}

function createRankedResponse(entries, username) {
  const sorted = sortByCoins(entries)
  const rank = sorted.findIndex((item) => item.username.toLowerCase() === username.toLowerCase()) + 1
  const player = sorted.find((item) => item.username.toLowerCase() === username.toLowerCase())
  return { rank, player: player ? toPublicEntry(player) : null }
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
      if (index === -1) return null
      return { rank: index + 1, player: toPublicEntry(entries[index]) }
    },
    async upsert(entry, ownerTokenHash) {
      return runExclusive(async () => {
        const entries = await readEntries()
        const existingIndex = entries.findIndex((item) => item.username.toLowerCase() === entry.username.toLowerCase())

        if (existingIndex >= 0) {
          const existingOwnerTokenHash = normalizeOwnerTokenHash(entries[existingIndex].ownerTokenHash)
          if (!existingOwnerTokenHash) return { error: 'legacy_entry_locked' }
          if (existingOwnerTokenHash !== ownerTokenHash) return { error: 'ownership_required' }

          entries[existingIndex] = { ...entry, ownerTokenHash: existingOwnerTokenHash }
        } else {
          entries.push({ ...entry, ownerTokenHash })
        }

        await writeEntries(sortByCoins(entries))
        return createRankedResponse(entries, entry.username)
      })
    },
  }
}

function createLeaderboardEntryModel() {
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
    { versionKey: false },
  )

  return mongoose.models.LeaderboardEntry || mongoose.model('LeaderboardEntry', schema, 'leaderboard_entries')
}

function createClanModel() {
  const memberSchema = new mongoose.Schema(
    {
      username: { type: String, required: true },
      usernameKey: { type: String, required: true, index: true },
      joinedAt: { type: String, required: true },
    },
    { _id: false },
  )

  const inviteSchema = new mongoose.Schema(
    {
      username: { type: String, required: true },
      usernameKey: { type: String, required: true, index: true },
      invitedAt: { type: String, required: true },
      invitedBy: { type: String, required: true },
    },
    { _id: false },
  )

  const schema = new mongoose.Schema(
    {
      name: { type: String, required: true },
      key: { type: String, required: true, unique: true, index: true },
      description: { type: String, required: true, maxlength: MAX_CLAN_DESCRIPTION_LENGTH },
      joinPermission: { type: String, required: true, enum: ['public', 'private'] },
      iconDataUrl: { type: String, required: true },
      ownerUsername: { type: String, required: true },
      ownerUsernameKey: { type: String, required: true },
      members: { type: [memberSchema], default: [] },
      pendingInvites: { type: [inviteSchema], default: [] },
      totalWarWins: { type: Number, default: 0 },
      lifetimeScore: { type: Number, default: 0 },
      warProgress: {
        cycleId: { type: String, default: '' },
        baselines: { type: Map, of: Number, default: {} },
        latest: { type: Map, of: Number, default: {} },
      },
      lastSettledCycle: { type: Number, default: -1 },
      warNoticeAcks: { type: Map, of: String, default: {} },
      createdAt: { type: String, required: true },
      updatedAt: { type: String, required: true },
    },
    { versionKey: false },
  )

  return mongoose.models.Clan || mongoose.model('Clan', schema, 'clans')
}

function createClanMessageModel() {
  const schema = new mongoose.Schema(
    {
      clanKey: { type: String, required: true, index: true },
      username: { type: String, required: true },
      usernameKey: { type: String, required: true },
      message: { type: String, required: true, maxlength: CHAT_MESSAGE_MAX },
      createdAt: { type: String, required: true, index: true },
    },
    { versionKey: false },
  )

  return mongoose.models.ClanMessage || mongoose.model('ClanMessage', schema, 'clan_messages')
}

function mapMongoDocToStoredEntry(doc) {
  const entry = normalizeEntry(doc) ?? normalizeEntry({ username: doc.username })
  if (!entry) return null
  return {
    ...entry,
    ownerTokenHash: normalizeOwnerTokenHash(doc?.ownerTokenHash),
  }
}

async function createMongoStorage(uri) {
  await mongoose.connect(uri)
  leaderboardEntryModel = createLeaderboardEntryModel()
  clanModel = createClanModel()
  clanMessageModel = createClanMessageModel()

  return {
    mode: 'mongo',
    async list(limit) {
      const docs = await leaderboardEntryModel.find({}).sort({ coins: -1, username: 1 }).limit(limit).lean()
      return docs.map(mapMongoDocToStoredEntry).filter(Boolean).map(toPublicEntry)
    },
    async getByUsername(username) {
      const usernameKey = username.toLowerCase()
      const doc = await leaderboardEntryModel.findOne({ usernameKey }).lean()
      if (!doc) return null

      const storedEntry = mapMongoDocToStoredEntry(doc)
      if (!storedEntry) return null

      const player = toPublicEntry(storedEntry)
      const rankAbove = await leaderboardEntryModel.countDocuments({
        $or: [
          { coins: { $gt: player.coins } },
          { coins: player.coins, username: { $lt: player.username } },
        ],
      })

      return { rank: rankAbove + 1, player }
    },
    async upsert(entry, ownerTokenHash) {
      const usernameKey = entry.username.toLowerCase()
      const existingDoc = await leaderboardEntryModel.findOne({ usernameKey }).lean()

      if (existingDoc) {
        const existingOwnerTokenHash = normalizeOwnerTokenHash(existingDoc.ownerTokenHash)
        if (!existingOwnerTokenHash) return { error: 'legacy_entry_locked' }
        if (existingOwnerTokenHash !== ownerTokenHash) return { error: 'ownership_required' }
      }

      const { Double } = mongoose.mongo
      await leaderboardEntryModel.collection.updateOne(
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

      const savedDoc = await leaderboardEntryModel.findOne({ usernameKey }).lean()
      const storedEntry = savedDoc ? mapMongoDocToStoredEntry(savedDoc) : { ...entry, ownerTokenHash }
      const player = storedEntry ? toPublicEntry(storedEntry) : toPublicEntry({ ...entry, ownerTokenHash })

      const rankAbove = await leaderboardEntryModel.countDocuments({
        $or: [
          { coins: { $gt: player.coins } },
          { coins: player.coins, username: { $lt: player.username } },
        ],
      })

      return { rank: rankAbove + 1, player }
    },
  }
}

function buildWarState(nowMs = Date.now()) {
  const elapsed = Math.max(0, nowMs - WAR_EPOCH_MS)
  const cycleIndex = Math.floor(elapsed / WAR_INTERVAL_MS)
  const cycleStart = WAR_EPOCH_MS + cycleIndex * WAR_INTERVAL_MS
  const warStart = cycleStart
  const warEnd = warStart + WAR_DURATION_MS
  const isActive = nowMs >= warStart && nowMs < warEnd
  const nextWarAt = isActive ? warStart + WAR_INTERVAL_MS : warStart

  return {
    cycleIndex,
    cycleId: String(cycleIndex),
    isActive,
    warStartAt: new Date(warStart).toISOString(),
    warEndAt: new Date(warEnd).toISOString(),
    nextWarAt: new Date(nextWarAt).toISOString(),
    timeRemainingMs: Math.max(0, (isActive ? warEnd : warStart) - nowMs),
  }
}

function rotateArray(items, shift) {
  if (items.length === 0) return []
  const offset = ((shift % items.length) + items.length) % items.length
  return [...items.slice(offset), ...items.slice(0, offset)]
}

function buildPairMap(clans, cycleIndex) {
  const sorted = [...clans].sort((a, b) => a.key.localeCompare(b.key))
  if (sorted.length <= 1) {
    return new Map(sorted.map((clan) => [clan.key, null]))
  }

  const rotated = rotateArray(sorted, cycleIndex)
  const map = new Map()
  for (let i = 0; i < rotated.length; i += 2) {
    const a = rotated[i]
    const b = rotated[i + 1] ?? null
    map.set(a.key, b ? b.key : null)
    if (b) map.set(b.key, a.key)
  }
  return map
}

function calculateWarGain(clan) {
  const baselines = clan?.warProgress?.baselines ?? {}
  const latest = clan?.warProgress?.latest ?? {}
  const keys = new Set([...Object.keys(baselines), ...Object.keys(latest)])
  let sum = 0
  for (const key of keys) {
    const baseline = Number(baselines[key] ?? 0)
    const current = Number(latest[key] ?? baseline)
    if (Number.isFinite(current) && Number.isFinite(baseline)) {
      sum += Math.max(0, current - baseline)
    }
  }
  return Math.round(sum)
}

async function ensureMongoClansEnabled(res) {
  if (!clanModel || !clanMessageModel || !leaderboardEntryModel) {
    res.status(503).json({
      error: 'Clans require MongoDB mode. Set MONGODB_URI on Render and restart the service.',
      feature: 'clans',
    })
    return false
  }
  return true
}

async function findPlayerByAuth(username, ownerToken) {
  if (!leaderboardEntryModel) {
    const entries = await readEntries()
    const user = entries.find((entry) => entry.username.toLowerCase() === username.toLowerCase())
    if (!user) return { error: 'player_not_found' }
    const hash = hashOwnerToken(ownerToken)
    if (!normalizeOwnerTokenHash(user.ownerTokenHash) || normalizeOwnerTokenHash(user.ownerTokenHash) !== hash) {
      return { error: 'ownership_required' }
    }
    return { player: user }
  }

  const usernameKey = username.toLowerCase()
  const player = await leaderboardEntryModel.findOne({ usernameKey }).lean()
  if (!player) return { error: 'player_not_found' }

  const ownerTokenHash = normalizeOwnerTokenHash(player.ownerTokenHash)
  if (!ownerTokenHash || ownerTokenHash !== hashOwnerToken(ownerToken)) {
    return { error: 'ownership_required' }
  }

  return { player }
}

async function requirePlayer(req, res) {
  const username = sanitizeUsername(req.body?.username ?? req.query?.username)
  const token = sanitizeOwnerToken(req.get('x-player-token'))

  if (!username) {
    res.status(400).json({ error: 'Valid username is required.' })
    return null
  }
  if (!token) {
    res.status(401).json({ error: 'A valid x-player-token header is required.' })
    return null
  }

  const auth = await findPlayerByAuth(username, token)
  if (auth.error === 'player_not_found') {
    res.status(404).json({ error: 'Player not found. Submit to leaderboard first.' })
    return null
  }
  if (auth.error === 'ownership_required') {
    res.status(403).json({ error: 'Player token does not match this username.' })
    return null
  }

  return {
    username,
    usernameKey: username.toLowerCase(),
    token,
  }
}

async function requireOwnerClan(req, res, player, clanKey) {
  const clan = await clanModel.findOne({ key: clanKey })
  if (!clan) {
    res.status(404).json({ error: 'Clan not found.' })
    return null
  }

  if (clan.ownerUsernameKey !== player.usernameKey) {
    res.status(403).json({ error: 'Only clan owner can perform this action.' })
    return null
  }

  return clan
}

async function getClanScoreMap(clans) {
  const keys = [...new Set(clans.flatMap((clan) => clan.members.map((member) => member.usernameKey)))]
  const scoreMap = new Map()

  if (keys.length === 0) return scoreMap

  if (leaderboardEntryModel) {
    const players = await leaderboardEntryModel
      .find({ usernameKey: { $in: keys } }, { usernameKey: 1, coins: 1, totalCoins: 1 })
      .lean()
    for (const player of players) {
      scoreMap.set(player.usernameKey, clampNumber(player.coins, 0, 0, MAX_RESOURCE_VALUE))
    }
    return scoreMap
  }

  const entries = await readEntries()
  for (const entry of entries) {
    scoreMap.set(entry.username.toLowerCase(), clampNumber(entry.coins, 0, 0, MAX_RESOURCE_VALUE))
  }
  return scoreMap
}

function toClanCard(clan, score, rank) {
  return {
    id: String(clan._id),
    key: clan.key,
    name: clan.name,
    description: clan.description,
    joinPermission: clan.joinPermission,
    iconUrl: clan.iconDataUrl,
    ownerUsername: clan.ownerUsername,
    memberCount: Array.isArray(clan.members) ? clan.members.length : 0,
    score,
    totalWarWins: clampNumber(clan.totalWarWins, 0, 0, MAX_RESOURCE_VALUE),
    rank,
  }
}

async function settleCompletedWarCycleIfNeeded() {
  if (!clanModel) return

  const warState = buildWarState()
  const settleCycleIndex = warState.isActive ? warState.cycleIndex - 1 : warState.cycleIndex - 1
  if (settleCycleIndex < 0) return

  const clans = await clanModel.find({}).lean()
  if (clans.length < 2) return

  const pairMap = buildPairMap(clans, settleCycleIndex)
  const clanByKey = new Map(clans.map((clan) => [clan.key, clan]))

  for (const clan of clans) {
    if (clampNumber(clan.lastSettledCycle, -1, -1, 10_000_000) >= settleCycleIndex) {
      continue
    }

    const opponentKey = pairMap.get(clan.key)
    if (!opponentKey) {
      await clanModel.updateOne({ _id: clan._id }, { $set: { lastSettledCycle: settleCycleIndex } })
      continue
    }

    const opponent = clanByKey.get(opponentKey)
    if (!opponent) {
      await clanModel.updateOne({ _id: clan._id }, { $set: { lastSettledCycle: settleCycleIndex } })
      continue
    }

    const clanAlreadySettled = clampNumber(clan.lastSettledCycle, -1, -1, 10_000_000) >= settleCycleIndex
    const oppAlreadySettled = clampNumber(opponent.lastSettledCycle, -1, -1, 10_000_000) >= settleCycleIndex
    if (clanAlreadySettled && oppAlreadySettled) continue

    const thisCycleId = String(settleCycleIndex)
    const clanGain = clan.warProgress?.cycleId === thisCycleId ? calculateWarGain(clan) : 0
    const oppGain = opponent.warProgress?.cycleId === thisCycleId ? calculateWarGain(opponent) : 0

    const updates = []

    if (clanGain > oppGain) {
      updates.push(
        clanModel.updateOne({ _id: clan._id }, { $inc: { totalWarWins: 1 }, $set: { lastSettledCycle: settleCycleIndex } }),
        clanModel.updateOne({ _id: opponent._id }, { $set: { lastSettledCycle: settleCycleIndex } }),
      )
    } else if (oppGain > clanGain) {
      updates.push(
        clanModel.updateOne({ _id: opponent._id }, { $inc: { totalWarWins: 1 }, $set: { lastSettledCycle: settleCycleIndex } }),
        clanModel.updateOne({ _id: clan._id }, { $set: { lastSettledCycle: settleCycleIndex } }),
      )
    } else {
      updates.push(
        clanModel.updateOne({ _id: clan._id }, { $set: { lastSettledCycle: settleCycleIndex } }),
        clanModel.updateOne({ _id: opponent._id }, { $set: { lastSettledCycle: settleCycleIndex } }),
      )
    }

    await Promise.all(updates)
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CLAN_ICON_BYTES },
  fileFilter(_req, file, callback) {
    if (file?.mimetype?.startsWith('image/')) {
      callback(null, true)
      return
    }
    callback(new Error('Clan icon must be an image file.'))
  },
})

const app = express()
const allowedOrigins = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://peg-1.netlify.app',
  ...CORS_ORIGINS,
])

const corsOptions = {
  origin(origin, callback) {
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
app.use(express.json({ limit: '1mb' }))

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
  res.json({
    name: 'Plinko Leaderboard + Clans API',
    status: 'ok',
    endpoints: ['/api/health', '/api/leaderboard', '/api/clans'],
  })
})

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    storage: storage?.mode ?? 'unknown',
    readOnlyMode: READ_ONLY_MODE,
    emergencyShutdown: EMERGENCY_SHUTDOWN,
    clansEnabled: storage?.mode === 'mongo',
  })
})

app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
    const entries = await storage.list(limit)
    res.json({
      entries: entries.map((entry, index) => ({ rank: index + 1, ...entry })),
      updatedAt: nowIso(),
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
    res.json({ rank: result.rank, player: result.player })
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

  const nextEntry = normalizeEntry({ ...req.body, username, updatedAt: nowIso() })
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

    res.json({ ok: true, rank: result.rank, player: result.player })
  } catch (error) {
    console.error('Failed to submit leaderboard score:', error)
    res.status(500).json({ error: 'Could not submit score.' })
  }
})

app.get('/api/clans', async (req, res) => {
  if (!(await ensureMongoClansEnabled(res))) return

  try {
    await settleCompletedWarCycleIfNeeded()
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50))
    const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : ''

    const query = search
      ? {
          $or: [
            { name: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
            { key: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
          ],
        }
      : {}

    const clans = await clanModel.find(query).limit(limit).lean()
    const scoreMap = await getClanScoreMap(clans)

    const ranked = clans
      .map((clan) => {
        const score = clan.members.reduce((sum, member) => sum + (scoreMap.get(member.usernameKey) ?? 0), 0)
        return { clan, score }
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        if ((b.clan.totalWarWins ?? 0) !== (a.clan.totalWarWins ?? 0)) return (b.clan.totalWarWins ?? 0) - (a.clan.totalWarWins ?? 0)
        return a.clan.name.localeCompare(b.clan.name)
      })

    const cards = ranked.map((item, index) => toClanCard(item.clan, item.score, index + 1))
    res.json({ entries: cards, updatedAt: nowIso() })
  } catch (error) {
    console.error('Failed to list clans:', error)
    res.status(500).json({ error: 'Failed to load clans.' })
  }
})

app.get('/api/clans/war-leaderboard', async (_req, res) => {
  if (!(await ensureMongoClansEnabled(res))) return

  try {
    await settleCompletedWarCycleIfNeeded()
    const clans = await clanModel.find({}).lean()
    const scoreMap = await getClanScoreMap(clans)

    const entries = clans
      .map((clan) => {
        const score = clan.members.reduce((sum, member) => sum + (scoreMap.get(member.usernameKey) ?? 0), 0)
        return {
          key: clan.key,
          name: clan.name,
          iconUrl: clan.iconDataUrl,
          totalWarWins: clampNumber(clan.totalWarWins, 0, 0, MAX_RESOURCE_VALUE),
          score,
          memberCount: clan.members.length,
        }
      })
      .sort((a, b) => {
        if (b.totalWarWins !== a.totalWarWins) return b.totalWarWins - a.totalWarWins
        if (b.score !== a.score) return b.score - a.score
        return a.name.localeCompare(b.name)
      })
      .map((entry, index) => ({ rank: index + 1, ...entry }))

    res.json({ entries, updatedAt: nowIso() })
  } catch (error) {
    console.error('Failed to load war leaderboard:', error)
    res.status(500).json({ error: 'Failed to load war leaderboard.' })
  }
})

app.get('/api/clans/me', async (req, res) => {
  if (!(await ensureMongoClansEnabled(res))) return

  const player = await requirePlayer(req, res)
  if (!player) return

  try {
    await settleCompletedWarCycleIfNeeded()
    const clan = await clanModel.findOne({ 'members.usernameKey': player.usernameKey }).lean()
    if (!clan) {
      res.json({ hasClan: false })
      return
    }

    const war = buildWarState()
    const lastAck = clan.warNoticeAcks?.[player.usernameKey] ?? ''
    const shouldNotify = war.isActive && lastAck !== war.cycleId

    res.json({
      hasClan: true,
      clan: toClanCard(clan, 0, 0),
      invites: Array.isArray(clan.pendingInvites)
        ? clan.pendingInvites
          .filter((invite) => invite.usernameKey === player.usernameKey)
          .map((invite) => ({ clanKey: clan.key, clanName: clan.name, invitedAt: invite.invitedAt }))
        : [],
      warNotification: shouldNotify
        ? {
            cycleId: war.cycleId,
            message: `Clan war is live now and ends in ${Math.ceil(war.timeRemainingMs / (60 * 60 * 1000))}h.`,
          }
        : null,
    })
  } catch (error) {
    console.error('Failed to load my clan:', error)
    res.status(500).json({ error: 'Failed to load clan state.' })
  }
})

app.get('/api/clans/invites', async (req, res) => {
  if (!(await ensureMongoClansEnabled(res))) return

  const player = await requirePlayer(req, res)
  if (!player) return

  try {
    const clans = await clanModel.find({ 'pendingInvites.usernameKey': player.usernameKey }).lean()
    const invites = clans.map((clan) => {
      const invite = clan.pendingInvites.find((entry) => entry.usernameKey === player.usernameKey)
      return {
        clanKey: clan.key,
        clanName: clan.name,
        invitedAt: invite?.invitedAt ?? nowIso(),
        invitedBy: invite?.invitedBy ?? clan.ownerUsername,
      }
    })

    res.json({ entries: invites })
  } catch (error) {
    console.error('Failed to load clan invites:', error)
    res.status(500).json({ error: 'Could not load clan invites.' })
  }
})

app.post('/api/clans/war/ack', async (req, res) => {
  if (!(await ensureMongoClansEnabled(res))) return

  const player = await requirePlayer(req, res)
  if (!player) return

  const cycleId = typeof req.body?.cycleId === 'string' ? req.body.cycleId : ''
  if (!cycleId) {
    res.status(400).json({ error: 'cycleId is required.' })
    return
  }

  try {
    await clanModel.updateOne(
      { 'members.usernameKey': player.usernameKey },
      {
        $set: {
          [`warNoticeAcks.${player.usernameKey}`]: cycleId,
          updatedAt: nowIso(),
        },
      },
    )

    res.json({ ok: true })
  } catch (error) {
    console.error('Failed to acknowledge war notification:', error)
    res.status(500).json({ error: 'Could not acknowledge war notification.' })
  }
})

app.post('/api/clans', submitLimiter, upload.single('icon'), async (req, res) => {
  if (!(await ensureMongoClansEnabled(res))) return

  if (READ_ONLY_MODE) {
    res.status(503).json({ error: 'Clan creation is disabled while read-only mode is active.' })
    return
  }

  const player = await requirePlayer(req, res)
  if (!player) return

  const clanName = sanitizeClanName(req.body?.name)
  const description = sanitizeDescription(req.body?.description)
  const joinPermission = sanitizeJoinPermission(req.body?.joinPermission)

  if (!clanName || !description || !joinPermission) {
    res.status(400).json({
      error: 'name, description, and joinPermission are required. Description max is 200 chars.',
    })
    return
  }

  if (!req.file?.buffer || !req.file?.mimetype) {
    res.status(400).json({ error: 'Clan icon image is required.' })
    return
  }

  const clanKey = toClanKey(clanName)
  const iconDataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`

  try {
    const existingMembership = await clanModel.findOne({ 'members.usernameKey': player.usernameKey }, { _id: 1 }).lean()
    if (existingMembership) {
      res.status(409).json({ error: 'You are already in a clan. Each user can only create one clan.' })
      return
    }

    const duplicate = await clanModel.findOne({ key: clanKey }, { _id: 1 }).lean()
    if (duplicate) {
      res.status(409).json({ error: 'Clan name already exists. Pick another name.' })
      return
    }

    const createdAt = nowIso()
    const clan = await clanModel.create({
      name: clanName,
      key: clanKey,
      description,
      joinPermission,
      iconDataUrl,
      ownerUsername: player.username,
      ownerUsernameKey: player.usernameKey,
      members: [
        {
          username: player.username,
          usernameKey: player.usernameKey,
          joinedAt: createdAt,
        },
      ],
      totalWarWins: 0,
      lifetimeScore: 0,
      createdAt,
      updatedAt: createdAt,
    })

    res.json({ ok: true, clan: toClanCard(clan.toObject(), 0, 0) })
  } catch (error) {
    console.error('Failed to create clan:', error)
    res.status(500).json({ error: 'Could not create clan.' })
  }
})

app.post('/api/clans/:clanKey/join', submitLimiter, async (req, res) => {
  if (!(await ensureMongoClansEnabled(res))) return

  if (READ_ONLY_MODE) {
    res.status(503).json({ error: 'Clan joins are disabled while read-only mode is active.' })
    return
  }

  const player = await requirePlayer(req, res)
  if (!player) return

  const clanKey = typeof req.params.clanKey === 'string' ? req.params.clanKey.trim().toLowerCase() : ''
  if (!clanKey) {
    res.status(400).json({ error: 'Invalid clan key.' })
    return
  }

  try {
    const currentClan = await clanModel.findOne({ 'members.usernameKey': player.usernameKey }, { key: 1 }).lean()
    if (currentClan) {
      res.status(409).json({ error: 'You are already in a clan.' })
      return
    }

    const clan = await clanModel.findOne({ key: clanKey })
    if (!clan) {
      res.status(404).json({ error: 'Clan not found.' })
      return
    }

    const hasInvite = clan.pendingInvites.some((invite) => invite.usernameKey === player.usernameKey)
    if (clan.joinPermission !== 'public' && !hasInvite) {
      res.status(403).json({ error: 'This clan is private. You need an invite to join.' })
      return
    }

    clan.members.push({
      username: player.username,
      usernameKey: player.usernameKey,
      joinedAt: nowIso(),
    })
    clan.pendingInvites = clan.pendingInvites.filter((invite) => invite.usernameKey !== player.usernameKey)
    clan.updatedAt = nowIso()
    await clan.save()

    res.json({ ok: true, clan: toClanCard(clan.toObject(), 0, 0) })
  } catch (error) {
    console.error('Failed to join clan:', error)
    res.status(500).json({ error: 'Could not join clan.' })
  }
})

app.post('/api/clans/:clanKey/settings', submitLimiter, upload.single('icon'), async (req, res) => {
  if (!(await ensureMongoClansEnabled(res))) return

  if (READ_ONLY_MODE) {
    res.status(503).json({ error: 'Clan updates are disabled while read-only mode is active.' })
    return
  }

  const player = await requirePlayer(req, res)
  if (!player) return

  const clanKey = typeof req.params.clanKey === 'string' ? req.params.clanKey.trim().toLowerCase() : ''
  if (!clanKey) {
    res.status(400).json({ error: 'Invalid clan key.' })
    return
  }

  try {
    const clan = await requireOwnerClan(req, res, player, clanKey)
    if (!clan) return

    const nextName = typeof req.body?.name === 'string' ? sanitizeClanName(req.body.name) : clan.name
    const nextDescription = typeof req.body?.description === 'string' ? sanitizeDescription(req.body.description) : clan.description
    const nextJoinPermission =
      typeof req.body?.joinPermission === 'string' ? sanitizeJoinPermission(req.body.joinPermission) : clan.joinPermission

    if (!nextName || !nextDescription || !nextJoinPermission) {
      res.status(400).json({ error: 'Invalid clan settings payload.' })
      return
    }

    const nextKey = toClanKey(nextName)
    if (nextKey !== clan.key) {
      const duplicate = await clanModel.findOne({ key: nextKey }, { _id: 1 }).lean()
      if (duplicate) {
        res.status(409).json({ error: 'Another clan already uses that name.' })
        return
      }
    }

    const update = {
      name: nextName,
      key: nextKey,
      description: nextDescription,
      joinPermission: nextJoinPermission,
      updatedAt: nowIso(),
    }

    if (req.file?.buffer && req.file?.mimetype) {
      update.iconDataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`
    }

    if (nextJoinPermission === 'public') {
      update.pendingInvites = []
    }

    const previousKey = clan.key
    Object.assign(clan, update)
    await clan.save()

    if (previousKey !== nextKey) {
      await clanMessageModel.updateMany({ clanKey: previousKey }, { $set: { clanKey: nextKey } })
    }

    res.json({ ok: true, clan: toClanCard(clan.toObject(), 0, 0), newClanKey: nextKey })
  } catch (error) {
    console.error('Failed to update clan settings:', error)
    res.status(500).json({ error: 'Could not update clan settings.' })
  }
})

app.post('/api/clans/:clanKey/invites', submitLimiter, async (req, res) => {
  if (!(await ensureMongoClansEnabled(res))) return

  if (READ_ONLY_MODE) {
    res.status(503).json({ error: 'Invites are disabled while read-only mode is active.' })
    return
  }

  const player = await requirePlayer(req, res)
  if (!player) return

  const clanKey = typeof req.params.clanKey === 'string' ? req.params.clanKey.trim().toLowerCase() : ''
  const targetUsername = sanitizeUsername(req.body?.targetUsername)
  if (!clanKey || !targetUsername) {
    res.status(400).json({ error: 'clan key and targetUsername are required.' })
    return
  }

  try {
    const clan = await requireOwnerClan(req, res, player, clanKey)
    if (!clan) return

    if (clan.joinPermission !== 'private') {
      res.status(400).json({ error: 'Invites are only needed for private clans.' })
      return
    }

    const targetUsernameKey = targetUsername.toLowerCase()
    const targetPlayer = await leaderboardEntryModel.findOne({ usernameKey: targetUsernameKey }).lean()
    if (!targetPlayer) {
      res.status(404).json({ error: 'Target player not found on leaderboard.' })
      return
    }

    const targetClan = await clanModel.findOne({ 'members.usernameKey': targetUsernameKey }, { key: 1 }).lean()
    if (targetClan) {
      res.status(409).json({ error: 'Target player is already in a clan.' })
      return
    }

    const alreadyInvited = clan.pendingInvites.some((invite) => invite.usernameKey === targetUsernameKey)
    if (!alreadyInvited) {
      clan.pendingInvites.push({
        username: targetUsername,
        usernameKey: targetUsernameKey,
        invitedAt: nowIso(),
        invitedBy: player.username,
      })
      clan.updatedAt = nowIso()
      await clan.save()
    }

    res.json({ ok: true })
  } catch (error) {
    console.error('Failed to invite player to clan:', error)
    res.status(500).json({ error: 'Could not send invite.' })
  }
})

app.post('/api/clans/:clanKey/kick', submitLimiter, async (req, res) => {
  if (!(await ensureMongoClansEnabled(res))) return

  if (READ_ONLY_MODE) {
    res.status(503).json({ error: 'Clan moderation is disabled while read-only mode is active.' })
    return
  }

  const player = await requirePlayer(req, res)
  if (!player) return

  const clanKey = typeof req.params.clanKey === 'string' ? req.params.clanKey.trim().toLowerCase() : ''
  const targetUsername = sanitizeUsername(req.body?.targetUsername)
  if (!clanKey || !targetUsername) {
    res.status(400).json({ error: 'clan key and targetUsername are required.' })
    return
  }

  try {
    const clan = await requireOwnerClan(req, res, player, clanKey)
    if (!clan) return

    const targetUsernameKey = targetUsername.toLowerCase()
    if (targetUsernameKey === clan.ownerUsernameKey) {
      res.status(400).json({ error: 'Owner cannot be kicked.' })
      return
    }

    const beforeCount = clan.members.length
    clan.members = clan.members.filter((member) => member.usernameKey !== targetUsernameKey)
    if (clan.members.length === beforeCount) {
      res.status(404).json({ error: 'Member not found in clan.' })
      return
    }

    clan.updatedAt = nowIso()
    await clan.save()

    res.json({ ok: true })
  } catch (error) {
    console.error('Failed to kick clan member:', error)
    res.status(500).json({ error: 'Could not kick member.' })
  }
})

app.post('/api/clans/:clanKey/leave', submitLimiter, async (req, res) => {
  if (!(await ensureMongoClansEnabled(res))) return

  if (READ_ONLY_MODE) {
    res.status(503).json({ error: 'Clan leave is disabled while read-only mode is active.' })
    return
  }

  const player = await requirePlayer(req, res)
  if (!player) return

  const clanKey = typeof req.params.clanKey === 'string' ? req.params.clanKey.trim().toLowerCase() : ''
  if (!clanKey) {
    res.status(400).json({ error: 'Invalid clan key.' })
    return
  }

  try {
    const clan = await clanModel.findOne({ key: clanKey })
    if (!clan) {
      res.status(404).json({ error: 'Clan not found.' })
      return
    }

    const isMember = clan.members.some((member) => member.usernameKey === player.usernameKey)
    if (!isMember) {
      res.status(403).json({ error: 'You are not a member of this clan.' })
      return
    }

    clan.members = clan.members.filter((member) => member.usernameKey !== player.usernameKey)
    clan.pendingInvites = clan.pendingInvites.filter((invite) => invite.usernameKey !== player.usernameKey)

    if (clan.members.length === 0) {
      await clanMessageModel.deleteMany({ clanKey: clan.key })
      await clan.deleteOne()
      res.json({ ok: true, disbanded: true })
      return
    }

    if (clan.ownerUsernameKey === player.usernameKey) {
      const nextOwner = clan.members[0]
      clan.ownerUsername = nextOwner.username
      clan.ownerUsernameKey = nextOwner.usernameKey
    }

    clan.updatedAt = nowIso()
    await clan.save()

    res.json({ ok: true, disbanded: false })
  } catch (error) {
    console.error('Failed to leave clan:', error)
    res.status(500).json({ error: 'Could not leave clan.' })
  }
})

app.get('/api/clans/:clanKey/home', async (req, res) => {
  if (!(await ensureMongoClansEnabled(res))) return

  const player = await requirePlayer(req, res)
  if (!player) return

  const clanKey = typeof req.params.clanKey === 'string' ? req.params.clanKey.trim().toLowerCase() : ''
  if (!clanKey) {
    res.status(400).json({ error: 'Invalid clan key.' })
    return
  }

  try {
    await settleCompletedWarCycleIfNeeded()

    const clan = await clanModel.findOne({ key: clanKey }).lean()
    if (!clan) {
      res.status(404).json({ error: 'Clan not found.' })
      return
    }

    const isMember = clan.members.some((member) => member.usernameKey === player.usernameKey)
    if (!isMember) {
      res.status(403).json({ error: 'Only clan members can view clan home.' })
      return
    }

    const allClans = await clanModel.find({}).lean()
    const pairMap = buildPairMap(allClans, buildWarState().cycleIndex)
    const opponentKey = pairMap.get(clan.key)
    const opponent = opponentKey ? allClans.find((item) => item.key === opponentKey) ?? null : null

    const warState = buildWarState()
    const myGain = warState.isActive && clan.warProgress?.cycleId === warState.cycleId ? calculateWarGain(clan) : 0
    const oppGain = warState.isActive && opponent?.warProgress?.cycleId === warState.cycleId ? calculateWarGain(opponent) : 0

    const warLeaderboard = allClans
      .map((item) => ({
        key: item.key,
        name: item.name,
        totalWarWins: clampNumber(item.totalWarWins, 0, 0, MAX_RESOURCE_VALUE),
      }))
      .sort((a, b) => {
        if (b.totalWarWins !== a.totalWarWins) return b.totalWarWins - a.totalWarWins
        return a.name.localeCompare(b.name)
      })
      .map((item, index) => ({ rank: index + 1, ...item }))

    res.json({
      clan: {
        key: clan.key,
        name: clan.name,
        description: clan.description,
        iconUrl: clan.iconDataUrl,
        joinPermission: clan.joinPermission,
        ownerUsername: clan.ownerUsername,
        members: clan.members,
        totalWarWins: clan.totalWarWins,
      },
      war: {
        ...warState,
        opponent: opponent
          ? {
              key: opponent.key,
              name: opponent.name,
              iconUrl: opponent.iconDataUrl,
              totalWarWins: opponent.totalWarWins,
            }
          : null,
        myClanGain: myGain,
        opponentGain: oppGain,
      },
      warLeaderboard,
    })
  } catch (error) {
    console.error('Failed to load clan home:', error)
    res.status(500).json({ error: 'Could not load clan home.' })
  }
})

app.post('/api/clans/war/progress', submitLimiter, async (req, res) => {
  if (!(await ensureMongoClansEnabled(res))) return

  const player = await requirePlayer(req, res)
  if (!player) return

  const totalCoins = clampNumber(req.body?.totalCoins, -1, 0, MAX_RESOURCE_VALUE)
  if (totalCoins < 0) {
    res.status(400).json({ error: 'totalCoins must be a non-negative number.' })
    return
  }

  try {
    const war = buildWarState()
    if (!war.isActive) {
      res.json({ ok: true, activeWar: false })
      return
    }

    const clan = await clanModel.findOne({ 'members.usernameKey': player.usernameKey })
    if (!clan) {
      res.status(404).json({ error: 'Player is not in a clan.' })
      return
    }

    if (clan.warProgress?.cycleId !== war.cycleId) {
      clan.warProgress = {
        cycleId: war.cycleId,
        baselines: {},
        latest: {},
      }
    }

    const baseline = Number(clan.warProgress.baselines.get(player.usernameKey) ?? totalCoins)
    const previousLatest = Number(clan.warProgress.latest.get(player.usernameKey) ?? baseline)
    clan.warProgress.baselines.set(player.usernameKey, baseline)
    clan.warProgress.latest.set(player.usernameKey, Math.max(previousLatest, totalCoins))
    clan.updatedAt = nowIso()
    await clan.save()

    const myGain = calculateWarGain(clan.toObject())

    res.json({
      ok: true,
      activeWar: true,
      cycleId: war.cycleId,
      myClanGain: myGain,
    })
  } catch (error) {
    console.error('Failed to update war progress:', error)
    res.status(500).json({ error: 'Could not update war progress.' })
  }
})

app.get('/api/clans/:clanKey/chat', async (req, res) => {
  if (!(await ensureMongoClansEnabled(res))) return

  const player = await requirePlayer(req, res)
  if (!player) return

  const clanKey = typeof req.params.clanKey === 'string' ? req.params.clanKey.trim().toLowerCase() : ''
  if (!clanKey) {
    res.status(400).json({ error: 'Invalid clan key.' })
    return
  }

  try {
    const clan = await clanModel.findOne({ key: clanKey }).lean()
    if (!clan) {
      res.status(404).json({ error: 'Clan not found.' })
      return
    }

    const isMember = clan.members.some((member) => member.usernameKey === player.usernameKey)
    if (!isMember) {
      res.status(403).json({ error: 'Only clan members can read chat.' })
      return
    }

    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 80))
    const messages = await clanMessageModel.find({ clanKey }).sort({ createdAt: -1 }).limit(limit).lean()

    res.json({
      entries: messages
        .reverse()
        .map((message) => ({
          id: String(message._id),
          username: message.username,
          message: message.message,
          createdAt: message.createdAt,
        })),
    })
  } catch (error) {
    console.error('Failed to load clan chat:', error)
    res.status(500).json({ error: 'Could not load clan chat.' })
  }
})

app.post('/api/clans/:clanKey/chat', submitLimiter, async (req, res) => {
  if (!(await ensureMongoClansEnabled(res))) return

  const player = await requirePlayer(req, res)
  if (!player) return

  const clanKey = typeof req.params.clanKey === 'string' ? req.params.clanKey.trim().toLowerCase() : ''
  const message = sanitizeChatMessage(req.body?.message)

  if (!clanKey || !message) {
    res.status(400).json({ error: 'Valid clan key and message are required.' })
    return
  }

  try {
    const clan = await clanModel.findOne({ key: clanKey }).lean()
    if (!clan) {
      res.status(404).json({ error: 'Clan not found.' })
      return
    }

    const isMember = clan.members.some((member) => member.usernameKey === player.usernameKey)
    if (!isMember) {
      res.status(403).json({ error: 'Only clan members can send messages.' })
      return
    }

    const createdAt = nowIso()
    const doc = await clanMessageModel.create({
      clanKey,
      username: player.username,
      usernameKey: player.usernameKey,
      message,
      createdAt,
    })

    const payload = {
      id: String(doc._id),
      clanKey,
      username: player.username,
      message,
      createdAt,
    }

    io?.to(`clan:${clanKey}`).emit('clan:message', payload)

    res.json({ ok: true, message: payload })
  } catch (error) {
    console.error('Failed to post clan message:', error)
    res.status(500).json({ error: 'Could not send message.' })
  }
})

app.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({ error: `Clan icon is too large. Max size is ${MAX_CLAN_ICON_BYTES / 1024 / 1024}MB.` })
      return
    }
    res.status(400).json({ error: err.message || 'Upload error.' })
    return
  }

  if (err) {
    res.status(400).json({ error: err.message || 'Request failed.' })
    return
  }

  next()
})

function createSocketServer(server) {
  io = new SocketIOServer(server, {
    cors: {
      origin(origin, callback) {
        if (!origin || allowedOrigins.has(origin)) {
          callback(null, true)
          return
        }
        callback(new Error(`Socket CORS blocked for origin: ${origin}`))
      },
      methods: ['GET', 'POST'],
    },
  })

  io.on('connection', (socket) => {
    socket.on('clan:join', async (payload = {}) => {
      try {
        if (!clanModel) {
          socket.emit('clan:error', { error: 'Clans are unavailable until MongoDB is enabled.' })
          return
        }

        const clanKey = typeof payload.clanKey === 'string' ? payload.clanKey.trim().toLowerCase() : ''
        const username = sanitizeUsername(payload.username)
        const token = sanitizeOwnerToken(payload.token)

        if (!clanKey || !username || !token) {
          socket.emit('clan:error', { error: 'Invalid clan join payload.' })
          return
        }

        const auth = await findPlayerByAuth(username, token)
        if (!auth.player) {
          socket.emit('clan:error', { error: 'Player authentication failed.' })
          return
        }

        const clan = await clanModel.findOne({ key: clanKey }).lean()
        if (!clan) {
          socket.emit('clan:error', { error: 'Clan not found.' })
          return
        }

        const isMember = clan.members.some((member) => member.usernameKey === username.toLowerCase())
        if (!isMember) {
          socket.emit('clan:error', { error: 'Only clan members can join chat room.' })
          return
        }

        socket.join(`clan:${clanKey}`)
        socket.emit('clan:joined', { ok: true, clanKey })
      } catch (error) {
        socket.emit('clan:error', { error: 'Failed to join clan room.' })
        console.error('Socket clan:join failed:', error)
      }
    })
  })
}

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

  const server = http.createServer(app)
  createSocketServer(server)

  server.listen(PORT, () => {
    console.log(`Leaderboard server running at http://localhost:${PORT}`)
    console.log(`Leaderboard storage mode: ${storage.mode}`)
    console.log(`Leaderboard read-only mode: ${READ_ONLY_MODE}`)
    console.log(`Leaderboard emergency shutdown: ${EMERGENCY_SHUTDOWN}`)
    console.log(`Clans API enabled: ${storage.mode === 'mongo'}`)
  })
}

startServer().catch((error) => {
  console.error('Failed to start leaderboard server:', error)
  process.exit(1)
})
