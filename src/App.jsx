import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Matter from 'matter-js'
import './App.css'

const SLOT_COUNT = 9
const SLOT_BASE_REWARDS = [20, 12, 8, 5, 3, 5, 8, 12, 20]

const upgradeCatalog = [
  {
    id: 'ballsPerDrop',
    title: 'Ball Rack',
    description: 'Drop one extra ball per launch.',
    baseCost: 28,
    growth: 1.55,
    maxLevel: 20,
  },
  {
    id: 'gravityLevel',
    title: 'Centrifuge',
    description: 'Increase board gravity so balls drop faster.',
    baseCost: 35,
    growth: 1.65,
    maxLevel: 20,
  },
  {
    id: 'pegLevel',
    title: 'Golden Pegs',
    description: 'Each level increases peg payout by 50%.',
    baseCost: 40,
    growth: 1.75,
    maxLevel: 20,
  },
  {
    id: 'rainbowLevel',
    title: 'Prism Core',
    description: 'Each level: +10% peg coin chance and unlocks neon gold coin text.',
    baseCost: 44,
    growth: 1.75,
    maxLevel: 20,
  },
  {
    id: 'slotGlobalLevel',
    title: 'Slot Machine (ifykyk)',
    description: 'Multiply every slot payout.',
    baseCost: 55,
    growth: 1.8,
    maxLevel: 20,
  },
  {
    id: 'gatekeeperLevel',
    title: 'Gatekeeper',
    description: 'Adds a neon blue deflector just above the slots that bounces balls back into play. Each level adds another gatekeeper.',
    baseCost: 25000,
    growth: 1.9,
    maxLevel: 15,
  },
]

const skinCatalog = [
  {
    id: 'default',
    name: 'Default Core',
    description: 'Classic cyan shell tuned for clean visibility.',
    price: 0,
  },
  {
    id: 'ember',
    name: 'Ember Coil',
    description: 'Molten orange alloy with a hot neon edge.',
    price: 1500,
  },
  {
    id: 'frostbyte',
    name: 'Frostbyte',
    description: 'Cold electric blue with icy contrast.',
    price: 6000,
  },
  {
    id: 'verdant',
    name: 'Verdant Flux',
    description: 'Bio-neon green shell with deep shadow core.',
    price: 18000,
  },
  {
    id: 'voidsteel',
    name: 'Voidsteel',
    description: 'Dark alloy orb with sharpened silver trim.',
    price: 42000,
  },
  {
    id: 'prisma',
    name: 'Prisma',
    description: 'Neon rainbow prototype that cycles color energy.',
    price: 100000,
  },
]

const upgradeTitleById = Object.fromEntries(upgradeCatalog.map((upgrade) => [upgrade.id, upgrade.title]))

const SKIN_IDS = new Set(skinCatalog.map((skin) => skin.id))
const DEFAULT_SKIN_ID = 'default'

const UPGRADE_DEFAULTS = {
  ballsPerDrop: 1,
  gravityLevel: 1,
  pegLevel: 1,
  rainbowLevel: 0,
  slotGlobalLevel: 1,
  gatekeeperLevel: 0,
}

const UPGRADE_MIN_LEVELS = {
  ballsPerDrop: 1,
  gravityLevel: 1,
  pegLevel: 1,
  rainbowLevel: 0,
  slotGlobalLevel: 1,
  gatekeeperLevel: 0,
}

const UPGRADE_MAX_LEVELS = Object.fromEntries(
  upgradeCatalog.map((upgrade) => [upgrade.id, upgrade.id === 'gatekeeperLevel' ? upgrade.maxLevel : Number.POSITIVE_INFINITY]),
)
const SAVE_STORAGE_KEY = 'peg-progress-v1'
const UPDATE_SEEN_STORAGE_KEY = 'seenUpdate'
const LEADERBOARD_USERNAME_KEY = 'peg-leaderboard-username-v1'
const LEADERBOARD_COMMITTED_USERNAME_KEY = 'peg-leaderboard-committed-username-v1'
const LEADERBOARD_LIMIT = 50
const LEADERBOARD_REFRESH_MS = 10000
const PROGRESS_SYNC_MS = 5000
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').trim().replace(/\/$/, '')
const ADMIN_USERNAME = 'REAL buy btf'

function apiUrl(path) {
  return `${API_BASE_URL}${path}`
}

function lerpColor(from, to, amount) {
  const t = Math.min(1, Math.max(0, amount))
  const fromValue = Number.parseInt(from.slice(1), 16)
  const toValue = Number.parseInt(to.slice(1), 16)

  const fr = (fromValue >> 16) & 255
  const fg = (fromValue >> 8) & 255
  const fb = fromValue & 255

  const tr = (toValue >> 16) & 255
  const tg = (toValue >> 8) & 255
  const tb = toValue & 255

  const r = Math.round(fr + (tr - fr) * t)
  const g = Math.round(fg + (tg - fg) * t)
  const b = Math.round(fb + (tb - fb) * t)

  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

function getPegRenderStyle(pegLevel) {
  const blend = Math.min(1, Math.max(0, (pegLevel - 1) / 8))
  return {
    fillStyle: lerpColor('#0e2c32', '#7f5b10', blend),
    strokeStyle: lerpColor('#84f5d9', '#ffd86e', blend),
    lineWidth: 1.2 + blend * 0.7,
  }
}

function getBallRenderStyle(skinId, fallbackHue) {

  switch (skinId) {
    case 'ember':
      return {
        fillStyle: '#ff8a3b',
        strokeStyle: '#ffd2a8',
        lineWidth: 2,
      }
    case 'frostbyte':
      return {
        fillStyle: '#58c9ff',
        strokeStyle: '#d8f3ff',
        lineWidth: 2,
      }
    case 'verdant':
      return {
        fillStyle: '#5db45f',
        strokeStyle: '#d9ffd8',
        lineWidth: 2,
      }
    case 'voidsteel':
      return {
        fillStyle: '#4f5966',
        strokeStyle: '#ffffff',
        lineWidth: 2.4,
      }
    case 'prisma': {
      return {
        fillStyle: '#d95aff',
        strokeStyle: '#ffffff',
        lineWidth: 2.2,
      }
    }
    default:
      return {
        fillStyle: `hsl(${fallbackHue} 92% 66%)`,
        strokeStyle: '#132318',
        lineWidth: 2,
      }
  }
}

function getGoldenBallCost(goldenBallCount) {
  return Math.floor(140 * 1.85 ** Math.max(0, goldenBallCount))
}

function drawBallPolygonPath(ctx, body) {
  const vertices = body.vertices
  if (!vertices || vertices.length === 0) {
    return
  }
  ctx.beginPath()
  ctx.moveTo(vertices[0].x, vertices[0].y)
  for (let i = 1; i < vertices.length; i += 1) {
    ctx.lineTo(vertices[i].x, vertices[i].y)
  }
  ctx.closePath()
}

function ctxRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

function createGatekeeperBodies(count, width, slotAreaTop) {
  if (count === 0) return []
  const h = 14
  const w = Math.max(40, Math.min(80, width / count - 8))
  const bodies = []
  for (let i = 0; i < count; i += 1) {
    const phase = (i / Math.max(1, count)) * Math.PI * 2
    const body = Matter.Bodies.rectangle(
      ((i + 0.5) / count) * width,
      slotAreaTop - 28,
      w,
      h,
      {
        isStatic: true,
        restitution: 1.05,
        friction: 0,
        frictionAir: 0,
        label: 'gatekeeper',
        render: { visible: false },
        plugin: { index: i, total: count, phase, baseW: w },
      },
    )
    bodies.push(body)
  }
  return bodies
}

function countLiveBalls(world) {
  return world.bodies.reduce((count, body) => count + (body.label === 'ball' ? 1 : 0), 0)
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return fallback
  }
  return Math.min(max, Math.max(min, numeric))
}

function normalizeArray(raw, length, min, max, fallback) {
  if (!Array.isArray(raw)) {
    return Array.from({ length }, () => fallback)
  }
  return Array.from({ length }, (_, index) => {
    const value = raw[index]
    return clampNumber(value, min, max, fallback)
  })
}

function normalizeUpgrades(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const next = { ...UPGRADE_DEFAULTS }
  for (const key of Object.keys(UPGRADE_DEFAULTS)) {
    next[key] = clampNumber(
      source[key],
      UPGRADE_MIN_LEVELS[key],
      UPGRADE_MAX_LEVELS[key] ?? UPGRADE_DEFAULTS[key],
      UPGRADE_DEFAULTS[key],
    )
  }
  return next
}

function normalizeOwnedSkins(raw) {
  const values = Array.isArray(raw) ? raw.filter((entry) => typeof entry === 'string' && SKIN_IDS.has(entry)) : []
  const unique = [...new Set(values)]
  if (!unique.includes(DEFAULT_SKIN_ID)) {
    unique.unshift(DEFAULT_SKIN_ID)
  }
  return unique
}

function normalizeSelectedSkin(raw, ownedSkins) {
  if (typeof raw === 'string' && SKIN_IDS.has(raw) && ownedSkins.includes(raw)) {
    return raw
  }
  return DEFAULT_SKIN_ID
}

function defaultProgress() {
  return {
    coins: 40,
    totalCoins: 0,
    totalBalls: 3,
    goldenBalls: 0,
    upgrades: { ...UPGRADE_DEFAULTS },
    slotLevels: Array.from({ length: SLOT_COUNT }, () => 1),
    slotFill: Array.from({ length: SLOT_COUNT }, () => 0),
    ownedSkins: [DEFAULT_SKIN_ID],
    selectedSkin: DEFAULT_SKIN_ID,
    soundOn: true,
    volume: 0.18,
  }
}

function loadProgress() {
  const fallback = defaultProgress()
  if (typeof window === 'undefined') {
    return fallback
  }

  try {
    const stored = window.localStorage.getItem(SAVE_STORAGE_KEY)
    if (!stored) {
      return fallback
    }
    const parsed = JSON.parse(stored)
    const ownedSkins = normalizeOwnedSkins(parsed?.ownedSkins)
    const totalBalls = clampNumber(parsed?.totalBalls, 1, 9999, fallback.totalBalls)
    const goldenBalls = clampNumber(parsed?.goldenBalls, 0, totalBalls, fallback.goldenBalls)
    return {
      coins: clampNumber(parsed?.coins, 0, Number.MAX_SAFE_INTEGER, fallback.coins),
      totalCoins: clampNumber(parsed?.totalCoins, 0, Number.MAX_SAFE_INTEGER, fallback.totalCoins),
      totalBalls,
      goldenBalls,
      upgrades: normalizeUpgrades(parsed?.upgrades),
      slotLevels: normalizeArray(parsed?.slotLevels, SLOT_COUNT, 1, 9999, 1),
      slotFill: normalizeArray(parsed?.slotFill, SLOT_COUNT, 0, 999999, 0),
      ownedSkins,
      selectedSkin: normalizeSelectedSkin(parsed?.selectedSkin, ownedSkins),
      soundOn: typeof parsed?.soundOn === 'boolean' ? parsed.soundOn : fallback.soundOn,
      volume: clampNumber(parsed?.volume, 0, 1, fallback.volume),
    }
  } catch {
    return fallback
  }
}

function createAudioEngine() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext
  if (!AudioCtx) {
    return null
  }

  const ctx = new AudioCtx()
  const master = ctx.createGain()
  master.gain.value = 0.18
  master.connect(ctx.destination)

  function tone({ frequency, type = 'sine', duration = 0.09, gain = 0.09 }) {
    if (ctx.state === 'suspended') {
      ctx.resume()
    }
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gainNode = ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(frequency, now)
    gainNode.gain.setValueAtTime(gain, now)
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + duration)
    osc.connect(gainNode)
    gainNode.connect(master)
    osc.start(now)
    osc.stop(now + duration)
  }

  return {
    peg: () => {
      const base = 470 + Math.random() * 70
      tone({ frequency: base, type: 'triangle', duration: 0.06, gain: 0.34 })
      window.setTimeout(() => tone({ frequency: base * 0.78, type: 'sine', duration: 0.12, gain: 0.12 }), 55)
      window.setTimeout(() => tone({ frequency: base * 0.62, type: 'sine', duration: 0.17, gain: 0.07 }), 115)
    },
    slot: (slotIndex) => {
      const root = 220 + slotIndex * 15
      tone({ frequency: root, type: 'sine', duration: 0.18, gain: 0.08 })
      tone({ frequency: root * 1.5, type: 'triangle', duration: 0.2, gain: 0.06 })
    },
    buy: () => {
      // Cash-register inspired ka-ching: quick drawer thunk + bright stacked chimes.
      tone({ frequency: 180, type: 'square', duration: 0.06, gain: 0.12 })
      window.setTimeout(() => tone({ frequency: 900, type: 'triangle', duration: 0.1, gain: 0.11 }), 16)
      window.setTimeout(() => tone({ frequency: 1280, type: 'triangle', duration: 0.14, gain: 0.1 }), 32)
      window.setTimeout(() => tone({ frequency: 1700, type: 'sine', duration: 0.16, gain: 0.08 }), 52)
    },
    fail: () => tone({ frequency: 140, type: 'sawtooth', duration: 0.1, gain: 0.06 }),
    setVolume: (v) => {
      const next = Math.max(0, Math.min(1, Number(v) || 0))
      master.gain.cancelScheduledValues(ctx.currentTime)
      master.gain.setTargetAtTime(next, ctx.currentTime, 0.01)
    },
  }
}

function App() {
  const boardWrapRef = useRef(null)
  const canvasRef = useRef(null)
  const engineRef = useRef(null)
  const renderRef = useRef(null)
  const runnerRef = useRef(null)
  const audioRef = useRef(null)
  const spawnIntervalRef = useRef(null)
  const holdDropIntervalRef = useRef(null)
  const gatekeeperBodiesRef = useRef([])

  const initialProgress = useMemo(() => loadProgress(), [])

  const [coins, setCoins] = useState(initialProgress.coins)
  const [totalCoins, setTotalCoins] = useState(initialProgress.totalCoins)
  const [totalBalls, setTotalBalls] = useState(initialProgress.totalBalls)
  const [goldenBalls, setGoldenBalls] = useState(initialProgress.goldenBalls)
  const [activeBalls, setActiveBalls] = useState(0)
  const [flashCoins, setFlashCoins] = useState(false)
  const [boardShake, setBoardShake] = useState(false)
  const [floaters, setFloaters] = useState([])
  const [showSettings, setShowSettings] = useState(false)
  const [showUpdateAlert, setShowUpdateAlert] = useState(false)
  const [mainTab, setMainTab] = useState('game')
  const [shopTab, setShopTab] = useState('upgrades')
  const [leaderboardEntries, setLeaderboardEntries] = useState([])
  const [leaderboardLoading, setLeaderboardLoading] = useState(false)
  const [leaderboardError, setLeaderboardError] = useState('')
  const [leaderboardSubmitStatus, setLeaderboardSubmitStatus] = useState('')
  const [leaderboardSubmitting, setLeaderboardSubmitting] = useState(false)
  const [leaderboardCountdown, setLeaderboardCountdown] = useState(Math.ceil(LEADERBOARD_REFRESH_MS / 1000))
  const [leaderboardLastSyncAt, setLeaderboardLastSyncAt] = useState(null)
  const [leaderboardLastSyncOk, setLeaderboardLastSyncOk] = useState(null)
  const [selectedLeaderboardPlayer, setSelectedLeaderboardPlayer] = useState(null)
  const [leaderboardUsername, setLeaderboardUsername] = useState(() => {
    if (typeof window === 'undefined') {
      return ''
    }
    try {
      return window.localStorage.getItem(LEADERBOARD_USERNAME_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [committedUsername, setCommittedUsername] = useState(() => {
    if (typeof window === 'undefined') {
      return ''
    }
    try {
      return window.localStorage.getItem(LEADERBOARD_COMMITTED_USERNAME_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [soundOn, setSoundOn] = useState(initialProgress.soundOn)
  const [volume, setVolume] = useState(initialProgress.volume)
  const [ownedSkins, setOwnedSkins] = useState(initialProgress.ownedSkins)
  const [selectedSkin, setSelectedSkin] = useState(initialProgress.selectedSkin)

  const [upgrades, setUpgrades] = useState(initialProgress.upgrades)

  const [slotLevels, setSlotLevels] = useState(initialProgress.slotLevels)
  const [slotFill, setSlotFill] = useState(initialProgress.slotFill)

  const stateRef = useRef({ upgrades, slotLevels, slotFill, totalBalls, goldenBalls, activeBalls: 0 })
  const nextLeaderboardRefreshAtRef = useRef(Date.now() + LEADERBOARD_REFRESH_MS)
  const submitInFlightRef = useRef(false)
  const latestProgressRef = useRef(null)
  const latestProgressHashRef = useRef('')
  const lastRemoteSavedHashRef = useRef('')
  const hasUnsyncedRemoteProgressRef = useRef(false)

  useEffect(() => {
    stateRef.current = { ...stateRef.current, upgrades, slotLevels, slotFill, totalBalls, goldenBalls }
  }, [upgrades, slotLevels, slotFill, totalBalls, goldenBalls])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    try {
      const hasSeenUpdate = window.localStorage.getItem(UPDATE_SEEN_STORAGE_KEY) === 'true'
      if (!hasSeenUpdate) {
        setShowUpdateAlert(true)
        window.localStorage.setItem(UPDATE_SEEN_STORAGE_KEY, 'true')
      }
    } catch {
      // If storage is unavailable, still show the update alert for the current session.
      setShowUpdateAlert(true)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const payload = {
      coins,
      totalCoins,
      totalBalls,
      goldenBalls,
      upgrades,
      slotLevels,
      slotFill,
      ownedSkins,
      selectedSkin,
      soundOn,
      volume,
    }
    try {
      window.localStorage.setItem(SAVE_STORAGE_KEY, JSON.stringify(payload))
      latestProgressRef.current = payload
      latestProgressHashRef.current = JSON.stringify(payload)

      if (committedUsername) {
        hasUnsyncedRemoteProgressRef.current = latestProgressHashRef.current !== lastRemoteSavedHashRef.current
      } else {
        hasUnsyncedRemoteProgressRef.current = false
      }
    } catch {
      // Ignore storage write errors and continue gameplay.
      console.error('[progress] local save failed, remote sync fallback still available if configured')
    }
  }, [coins, committedUsername, totalCoins, totalBalls, goldenBalls, upgrades, slotLevels, slotFill, ownedSkins, selectedSkin, soundOn, volume])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    try {
      window.localStorage.setItem(LEADERBOARD_USERNAME_KEY, leaderboardUsername)
    } catch {
      // Ignore username storage failures.
    }
  }, [leaderboardUsername])

  const refreshLeaderboard = useCallback(async (reason = 'interval') => {
    const startedAt = Date.now()
    console.log(`[leaderboard] refresh start (${reason})`, {
      url: apiUrl(`/api/leaderboard?limit=${LEADERBOARD_LIMIT}`),
      startedAt,
    })

    setLeaderboardLoading(true)
    setLeaderboardError('')
    try {
      const response = await fetch(apiUrl(`/api/leaderboard?limit=${LEADERBOARD_LIMIT}&t=${Date.now()}`), {
        cache: 'no-store',
      })
      if (!response.ok) {
        throw new Error('Could not load leaderboard.')
      }
      const data = await response.json()
      const entries = Array.isArray(data?.entries) ? data.entries : []
      setLeaderboardEntries(entries)
      setLeaderboardLastSyncAt(Date.now())
      setLeaderboardLastSyncOk(true)
      setSelectedLeaderboardPlayer((previous) => {
        if (!previous) {
          return entries[0] ?? null
        }
        return entries.find((entry) => entry.username === previous.username) ?? entries[0] ?? null
      })
      console.log('[leaderboard] refresh success', {
        reason,
        status: response.status,
        durationMs: Date.now() - startedAt,
        entries: entries.length,
        topPlayer: entries[0]?.username ?? null,
        topCoins: entries[0]?.coins ?? null,
      })
    } catch {
      setLeaderboardError('Leaderboard unavailable. Set VITE_API_BASE_URL to your deployed backend URL.')
      setLeaderboardLastSyncAt(Date.now())
      setLeaderboardLastSyncOk(false)
      console.error('[leaderboard] refresh failed', {
        reason,
        durationMs: Date.now() - startedAt,
      })
    } finally {
      setLeaderboardLoading(false)
    }
  }, [])

  const scheduleNextLeaderboardRefresh = useCallback(() => {
    const nextAt = Date.now() + LEADERBOARD_REFRESH_MS
    nextLeaderboardRefreshAtRef.current = nextAt
    setLeaderboardCountdown(Math.max(0, Math.ceil((nextAt - Date.now()) / 1000)))
  }, [])

  useEffect(() => {
    scheduleNextLeaderboardRefresh()
    refreshLeaderboard('initial')
    const intervalId = window.setInterval(() => {
      scheduleNextLeaderboardRefresh()
      refreshLeaderboard('interval')
    }, LEADERBOARD_REFRESH_MS)
    return () => {
      window.clearInterval(intervalId)
    }
  }, [refreshLeaderboard, scheduleNextLeaderboardRefresh])

  useEffect(() => {
    const tickerId = window.setInterval(() => {
      const remainingMs = Math.max(0, nextLeaderboardRefreshAtRef.current - Date.now())
      setLeaderboardCountdown(Math.ceil(remainingMs / 1000))
    }, 250)

    return () => {
      window.clearInterval(tickerId)
    }
  }, [])

  const submitLeaderboardScore = useCallback(async (options = {}) => {
    const { usernameOverride, showStatus = true, reason = 'manual' } = options
    const username = (usernameOverride ?? leaderboardUsername).trim()
    if (!/^[a-zA-Z0-9 _-]{3,20}$/.test(username)) {
      if (showStatus) {
        setLeaderboardSubmitStatus('Username must be 3-20 chars: letters, numbers, spaces, _ or -.')
      }
      return
    }

    if (submitInFlightRef.current) {
      console.log('[progress] remote sync skipped, submit already in-flight', { reason, username })
      return
    }
    submitInFlightRef.current = true

    if (showStatus) {
      setLeaderboardSubmitting(true)
      setLeaderboardSubmitStatus('')
    }

    const payload = {
      username,
      coins: Math.floor(coins),
      totalCoins: Math.floor(totalCoins),
      totalBalls,
      goldenBalls,
      upgrades,
      slotLevels,
      ownedSkins,
      selectedSkin,
    }

    const payloadHash = JSON.stringify({
      coins: payload.coins,
      totalCoins: payload.totalCoins,
      totalBalls: payload.totalBalls,
      goldenBalls: payload.goldenBalls,
      upgrades: payload.upgrades,
      slotLevels: payload.slotLevels,
      ownedSkins: payload.ownedSkins,
      selectedSkin: payload.selectedSkin,
    })

    console.log('[leaderboard] submit start', { reason, username, payloadHash })

    try {
      const response = await fetch(apiUrl('/api/leaderboard/submit'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })

      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        if (showStatus) {
          setLeaderboardSubmitStatus(typeof data?.error === 'string' ? data.error : 'Could not submit score.')
        }
        console.error('[leaderboard] submit failed', {
          reason,
          username,
          status: response.status,
          error: typeof data?.error === 'string' ? data.error : null,
        })
        return
      }

      setCommittedUsername(username)
      try {
        window.localStorage.setItem(LEADERBOARD_COMMITTED_USERNAME_KEY, username)
      } catch {
        // Ignore storage failures.
      }
      if (data.player) {
        setSelectedLeaderboardPlayer({ ...data.player, rank: data.rank })
      }
      if (showStatus) {
        setLeaderboardSubmitStatus(`Submitted! Current rank: #${data.rank}`)
      }
      console.log('[leaderboard] submit success', {
        reason,
        username,
        rank: data.rank,
        coins: data?.player?.coins ?? null,
      })
      lastRemoteSavedHashRef.current = payloadHash
      hasUnsyncedRemoteProgressRef.current = payloadHash !== '' && payloadHash === latestProgressHashRef.current
      console.log('[progress] remote sync success', {
        reason,
        username,
        hasUnsyncedRemoteProgress: hasUnsyncedRemoteProgressRef.current,
      })
      scheduleNextLeaderboardRefresh()
      await refreshLeaderboard(reason === 'auto' ? 'autosubmit' : 'submit')
    } catch {
      if (showStatus) {
        setLeaderboardSubmitStatus('Submission failed. Check backend URL and CORS settings.')
      }
      console.error('[leaderboard] submit request error', {
        reason,
        username,
      })
      console.error('[progress] remote sync failed; local progress remains in browser storage', {
        reason,
        username,
      })
    } finally {
      submitInFlightRef.current = false
      if (showStatus) {
        setLeaderboardSubmitting(false)
      }
    }
  }, [coins, goldenBalls, leaderboardUsername, ownedSkins, refreshLeaderboard, scheduleNextLeaderboardRefresh, selectedSkin, slotLevels, totalBalls, totalCoins, upgrades])

  useEffect(() => {
    if (!committedUsername) {
      return undefined
    }

    console.log('[progress] remote autosync started', { intervalMs: PROGRESS_SYNC_MS, username: committedUsername })

    const intervalId = window.setInterval(() => {
      const hasPendingChanges = hasUnsyncedRemoteProgressRef.current
      console.log('[progress] autosync tick', {
        hasPendingChanges,
        action: 'push-to-backend',
      })
      submitLeaderboardScore({
        usernameOverride: committedUsername,
        showStatus: false,
        reason: hasPendingChanges ? 'auto' : 'auto-heartbeat',
      })
    }, PROGRESS_SYNC_MS)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [committedUsername, submitLeaderboardScore])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined
    }

    const onBeforeUnload = (event) => {
      if (!committedUsername) {
        return
      }
      const hasPendingSave = hasUnsyncedRemoteProgressRef.current || submitInFlightRef.current
      if (!hasPendingSave) {
        return
      }

      console.warn('[progress] tab close blocked: unsynced progress detected')
      event.preventDefault()
      event.returnValue = 'Your latest progress is still saving. Are you sure you want to leave?'
    }

    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [committedUsername])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined
    }

    const flushProgressOnExit = () => {
      if (!committedUsername || !hasUnsyncedRemoteProgressRef.current) {
        return
      }

      const payload = latestProgressRef.current
      if (!payload) {
        return
      }

      const requestBody = JSON.stringify({
        username: committedUsername,
        coins: Math.floor(payload.coins),
        totalCoins: Math.floor(payload.totalCoins),
        totalBalls: payload.totalBalls,
        goldenBalls: payload.goldenBalls,
        upgrades: payload.upgrades,
        slotLevels: payload.slotLevels,
        ownedSkins: payload.ownedSkins,
        selectedSkin: payload.selectedSkin,
      })

      if (navigator.sendBeacon) {
        const blob = new Blob([requestBody], { type: 'application/json' })
        const queued = navigator.sendBeacon(apiUrl('/api/leaderboard/submit'), blob)
        console.log('[progress] pagehide sync attempt via sendBeacon', { queued })
        return
      }

      fetch(apiUrl('/api/leaderboard/submit'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: requestBody,
        keepalive: true,
      }).catch(() => {
        console.error('[progress] keepalive sync failed during pagehide')
      })
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushProgressOnExit()
      }
    }

    window.addEventListener('pagehide', flushProgressOnExit)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('pagehide', flushProgressOnExit)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [committedUsername])

  const addFloater = useCallback((x, y, text, kind = 'coin') => {
    const id = window.crypto.randomUUID()
    setFloaters((previous) => [...previous, { id, x, y, text, kind }])
    window.setTimeout(() => {
      setFloaters((previous) => previous.filter((item) => item.id !== id))
    }, 850)
  }, [])

  const normalizedSlotRewards = useMemo(
    () => SLOT_BASE_REWARDS.map((base, i) => Math.round(base * slotLevels[i] * (0.8 + upgrades.slotGlobalLevel * 0.25))),
    [slotLevels, upgrades.slotGlobalLevel],
  )

  const registerCoins = useCallback(
    (amount) => {
      setCoins((value) => value + amount)
      setTotalCoins((value) => value + amount)
      setFlashCoins(true)
      window.setTimeout(() => setFlashCoins(false), 150)
    },
    [],
  )

  const spawnBall = useCallback((intensity = 1) => {
    const engine = engineRef.current
    if (!engine) {
      return
    }

    const liveCount = countLiveBalls(engine.world)
    if (liveCount >= stateRef.current.totalBalls) {
      if (stateRef.current.activeBalls !== liveCount) {
        stateRef.current.activeBalls = liveCount
        setActiveBalls((previous) => (previous === liveCount ? previous : liveCount))
      }
      return
    }

    const width = engine.render?.options?.width ?? 760
    const xCenter = width / 2
    const hue = 175 + Math.floor(Math.random() * 90)
    const goldenRatio = stateRef.current.totalBalls > 0 ? stateRef.current.goldenBalls / stateRef.current.totalBalls : 0
    const isGolden = Math.random() < goldenRatio
    const ballRenderStyle = getBallRenderStyle(selectedSkin, hue)
    const renderStyle = isGolden
      ? {
        ...ballRenderStyle,
        strokeStyle: '#ffd84a',
        lineWidth: Math.max(2.8, ballRenderStyle.lineWidth ?? 2),
      }
      : ballRenderStyle
    const ball = Matter.Bodies.polygon(xCenter + (Math.random() - 0.5) * 24, 32, 8, 8.8, {
      restitution: 0.6,
      friction: 0.004,
      frictionAir: 0.0015,
      density: 0.0018,
      label: 'ball',
      render: renderStyle,
      plugin: {
        intensity,
        createdAt: Date.now(),
        skinId: selectedSkin,
        isGolden,
        gradientSeed: Math.random(),
      },
    })

    Matter.World.add(engine.world, ball)
    const nextCount = countLiveBalls(engine.world)
    stateRef.current.activeBalls = nextCount
    setActiveBalls((previous) => (previous === nextCount ? previous : nextCount))
  }, [selectedSkin])

  const dropBallWave = useCallback(() => {
    const count = stateRef.current.upgrades.ballsPerDrop
    let spawned = 0
    for (let i = 0; i < count; i += 1) {
      if (activeBalls + spawned >= totalBalls) break
      const delay = spawned * 70
      spawned += 1
      window.setTimeout(() => spawnBall(1 + i * 0.1), delay)
    }
  }, [spawnBall, activeBalls, totalBalls])

  const stopHoldDrop = useCallback(() => {
    if (holdDropIntervalRef.current) {
      window.clearInterval(holdDropIntervalRef.current)
      holdDropIntervalRef.current = null
    }
  }, [])

  const startHoldDrop = useCallback(() => {
    if (stateRef.current.activeBalls >= stateRef.current.totalBalls) {
      return
    }
    dropBallWave()
    if (holdDropIntervalRef.current) {
      return
    }
    holdDropIntervalRef.current = window.setInterval(() => {
      if (stateRef.current.activeBalls >= stateRef.current.totalBalls) {
        return
      }
      dropBallWave()
    }, 150)
  }, [dropBallWave])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key.toLowerCase() !== 'q') {
        return
      }
      const target = event.target
      if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      event.preventDefault()
      dropBallWave()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [dropBallWave])

  useEffect(() => () => stopHoldDrop(), [stopHoldDrop])

  useEffect(() => {
    if (mainTab !== 'game') {
      return undefined
    }

    if (!boardWrapRef.current || !canvasRef.current) {
      return undefined
    }

    audioRef.current = createAudioEngine()
    audioRef.current?.setVolume(soundOn ? volume : 0)

    const width = Math.min(800, Math.max(500, boardWrapRef.current.clientWidth))
    const height = 700
    const slotAreaTop = height - 168

    const engine = Matter.Engine.create()
    engine.gravity.y = 0.24
    engineRef.current = engine

    const render = Matter.Render.create({
      element: boardWrapRef.current,
      canvas: canvasRef.current,
      engine,
      options: {
        width,
        height,
        wireframes: false,
        background: 'transparent',
      },
    })
    renderRef.current = render
    engine.render = render

    const pegRows = 10
    const pegSpacingX = width / (SLOT_COUNT + 1)
    const pegSpacingY = 52
    const pegRadius = 7
    const pegRenderStyle = getPegRenderStyle(stateRef.current.upgrades.pegLevel)
    const pegs = []

    for (let row = 0; row < pegRows; row += 1) {
      const count = row % 2 === 0 ? SLOT_COUNT : SLOT_COUNT - 1
      const offset = row % 2 === 0 ? 0 : pegSpacingX / 2
      for (let col = 0; col < count; col += 1) {
        const pegX = pegSpacingX + col * pegSpacingX + offset
        const pegY = 120 + row * pegSpacingY
        if (pegY + pegRadius >= slotAreaTop) {
          continue
        }
        const peg = Matter.Bodies.polygon(pegX, pegY, 6, pegRadius, {
          isStatic: true,
          label: 'peg',
          render: pegRenderStyle,
        })
        pegs.push(peg)
      }
    }

    const wallThickness = 44
    const sideWalls = [
      Matter.Bodies.rectangle(-18, height / 2, wallThickness, height + 40, { isStatic: true, render: { visible: false } }),
      Matter.Bodies.rectangle(width + 18, height / 2, wallThickness, height + 40, { isStatic: true, render: { visible: false } }),
      Matter.Bodies.rectangle(width / 2, height + 15, width + 30, 30, { isStatic: true, render: { visible: false } }),
      Matter.Bodies.rectangle(width / 2, -15, width + 30, 30, { isStatic: true, render: { visible: false } }),
    ]

    const slotHeight = 160
    const slotWidth = width / SLOT_COUNT
    const separators = []
    const sensors = []

    for (let i = 0; i <= SLOT_COUNT; i += 1) {
      separators.push(
        Matter.Bodies.rectangle(i * slotWidth, slotAreaTop + slotHeight / 2, 8, slotHeight, {
          isStatic: true,
          render: {
            fillStyle: '#1a2f3f',
          },
        }),
      )
    }

    for (let i = 0; i < SLOT_COUNT; i += 1) {
      const sensor = Matter.Bodies.rectangle(i * slotWidth + slotWidth / 2, height - 28, slotWidth - 8, 26, {
        isStatic: true,
        isSensor: true,
        label: `slot-${i}`,
        render: {
          visible: false,
        },
      })
      sensors.push(sensor)
    }

    Matter.World.add(engine.world, [...sideWalls, ...pegs, ...separators, ...sensors])

    const initialGatekeepers = createGatekeeperBodies(stateRef.current.upgrades.gatekeeperLevel, width, slotAreaTop)
    gatekeeperBodiesRef.current = initialGatekeepers
    if (initialGatekeepers.length > 0) {
      Matter.World.add(engine.world, initialGatekeepers)
    }

    Matter.Events.on(engine, 'collisionStart', (event) => {
      for (const pair of event.pairs) {
        const labels = [pair.bodyA.label, pair.bodyB.label]
        const ballBody = labels[0] === 'ball' ? pair.bodyA : labels[1] === 'ball' ? pair.bodyB : null
        if (!ballBody) {
          continue
        }

        const slotLabel = labels.find((label) => label.startsWith('slot-'))
        const pegHit = labels.includes('peg')
        const gatekeeperBody = labels[0] === 'gatekeeper' ? pair.bodyA : labels[1] === 'gatekeeper' ? pair.bodyB : null

        if (pegHit) {
          audioRef.current?.peg()
          const { pegLevel, rainbowLevel } = stateRef.current.upgrades
          const pegChance = Math.min(0.9, 1 / 3 + rainbowLevel * 0.1)
          if (Math.random() < pegChance) {
            const crit = Math.random() < 0.1
            const pegPayoutMultiplier = 1.5 ** Math.max(0, pegLevel - 1)
            const goldenPegMultiplier = ballBody.plugin?.isGolden ? 2 : 1
            const amount = Math.max(1, Math.ceil((crit ? 5 : 1) * pegPayoutMultiplier * goldenPegMultiplier))
            registerCoins(amount)
            const x = (ballBody.position.x / width) * 100
            const y = (ballBody.position.y / height) * 100
            const rainbow = rainbowLevel > 0
            const floaterKind = rainbow ? (crit ? 'pegCrit' : 'peg') : 'pegBase'
            addFloater(x, y, `+${amount}`, floaterKind)
          }
        }

        if (gatekeeperBody) {
          const gatekeeperVx = gatekeeperBody.velocity?.x ?? 0
          const incomingY = Math.max(0, ballBody.velocity.y)
          const launchSpeed = Math.max(14, Math.min(20, incomingY * 2.4 + 8))
          const lateral = ballBody.velocity.x * 0.45 + gatekeeperVx * 0.65
          ballBody.plugin = {
            ...(ballBody.plugin ?? {}),
            lastGatekeeperBounceAt: Date.now(),
          }
          Matter.Body.setPosition(ballBody, {
            x: ballBody.position.x,
            y: ballBody.position.y - 4,
          })
          Matter.Body.setVelocity(ballBody, {
            x: lateral,
            y: -launchSpeed,
          })
        }

        if (slotLabel) {
          const bouncedAt = ballBody.plugin?.lastGatekeeperBounceAt ?? 0
          if (Date.now() - bouncedAt < 120) {
            continue
          }
          const slotIndex = Number(slotLabel.replace('slot-', ''))
          const reward = Math.round(
            SLOT_BASE_REWARDS[slotIndex] * stateRef.current.slotLevels[slotIndex] * (0.8 + stateRef.current.upgrades.slotGlobalLevel * 0.25),
          )
          registerCoins(reward)
          audioRef.current?.slot(slotIndex)
          addFloater((ballBody.position.x / width) * 100, (ballBody.position.y / height) * 100, `+${reward}`, 'slot')

          setSlotFill((previous) => {
            const next = [...previous]
            next[slotIndex] += 1
            return next
          })

          setSlotLevels((previous) => {
            const next = [...previous]
            const threshold = 7 + previous[slotIndex] * 4
            const currentFill = stateRef.current.slotFill[slotIndex] + 1
            if (currentFill >= threshold) {
              next[slotIndex] += 1
              addFloater(((slotIndex + 0.5) * slotWidth * 100) / width, 87, `Slot ${slotIndex + 1} UP`, 'upgrade')
              setSlotFill((fills) => {
                const copy = [...fills]
                copy[slotIndex] = 0
                return copy
              })
            }
            return next
          })

          Matter.World.remove(engine.world, ballBody)
          const liveCount = countLiveBalls(engine.world)
          stateRef.current.activeBalls = liveCount
          setActiveBalls((previous) => (previous === liveCount ? previous : liveCount))
          setBoardShake(true)
          window.setTimeout(() => setBoardShake(false), 160)
        }
      }
    })

    const runner = Matter.Runner.create()
    runnerRef.current = runner
    const moveGatekeepers = () => {
      const now = performance.now()
      const bodies = gatekeeperBodiesRef.current
      if (!bodies.length) return
      const n = bodies.length
      for (const gkBody of bodies) {
        const { index, phase, baseW } = gkBody.plugin
        const sectionW = width / n
        const baseX = (index + 0.5) * sectionW
        const amp = Math.max(8, sectionW / 2 - baseW / 2 - 4)
        const newX = baseX + Math.cos(now * 0.001 + phase) * amp
        const prevX = gkBody.position.x
        Matter.Body.setVelocity(gkBody, { x: newX - prevX, y: 0 })
        Matter.Body.setPosition(gkBody, { x: newX, y: gkBody.position.y })
      }
    }
    Matter.Events.on(engine, 'beforeUpdate', moveGatekeepers)


    const drawSkinOverlays = () => {
      const ctx = render.context
      const now = performance.now()

      for (const body of engine.world.bodies) {
        if (body.label !== 'ball') {
          continue
        }

        const skinId = body.plugin?.skinId
        if (skinId !== 'prisma' && skinId !== 'verdant' && skinId !== 'voidsteel') {
          continue
        }

        const seed = body.plugin?.gradientSeed ?? 0

        if (skinId === 'prisma' || skinId === 'verdant') {
          const angle = (now * 0.0017 + seed * Math.PI * 2) % (Math.PI * 2)
          const x1 = body.position.x + Math.cos(angle) * 10
          const y1 = body.position.y + Math.sin(angle) * 10
          const x2 = body.position.x - Math.cos(angle) * 10
          const y2 = body.position.y - Math.sin(angle) * 10
          const gradient = ctx.createLinearGradient(x1, y1, x2, y2)

          if (skinId === 'prisma') {
            gradient.addColorStop(0, '#ff4bc8')
            gradient.addColorStop(0.25, '#ffbf47')
            gradient.addColorStop(0.5, '#84ff55')
            gradient.addColorStop(0.75, '#5ce5ff')
            gradient.addColorStop(1, '#b97cff')
          } else {
            gradient.addColorStop(0, '#dcffd8')
            gradient.addColorStop(0.45, '#59e86b')
            gradient.addColorStop(1, '#1f8f34')
          }

          ctx.save()
          drawBallPolygonPath(ctx, body)
          ctx.fillStyle = gradient
          ctx.fill()
          ctx.restore()
        }

        if (skinId === 'voidsteel') {
          ctx.save()
          drawBallPolygonPath(ctx, body)
          ctx.lineWidth = 3
          ctx.strokeStyle = '#ffffff'
          ctx.shadowBlur = 12
          ctx.shadowColor = '#ffffff'
          ctx.stroke()
          ctx.restore()
        }

        if (skinId === 'prisma') {
          ctx.save()
          drawBallPolygonPath(ctx, body)
          ctx.lineWidth = 2.6
          ctx.strokeStyle = '#ffffff'
          ctx.shadowBlur = 10
          ctx.shadowColor = '#fff2a6'
          ctx.stroke()
          ctx.restore()
        }

        if (skinId === 'verdant') {
          ctx.save()
          drawBallPolygonPath(ctx, body)
          ctx.lineWidth = 2.4
          ctx.strokeStyle = '#dcffd8'
          ctx.shadowBlur = 8
          ctx.shadowColor = '#89ff8a'
          ctx.stroke()
          ctx.restore()
        }

        if (body.plugin?.isGolden) {
          ctx.save()
          drawBallPolygonPath(ctx, body)
          ctx.lineWidth = 3.1
          ctx.strokeStyle = '#ffd84a'
          ctx.shadowBlur = 11
          ctx.shadowColor = '#ffe89a'
          ctx.stroke()
          ctx.restore()
        }
      }

      // Draw gatekeepers
      for (const gkBody of gatekeeperBodiesRef.current) {
        const { x, y } = gkBody.position
        const hw = gkBody.plugin.baseW / 2
        const hh = 7
        const r = 4
        ctx.save()
        ctx.shadowBlur = 22
        ctx.shadowColor = '#00d4ff'
        ctx.fillStyle = 'rgba(0, 170, 255, 0.28)'
        ctxRoundRect(ctx, x - hw, y - hh, hw * 2, hh * 2, r)
        ctx.fill()
        ctx.shadowBlur = 14
        ctx.strokeStyle = '#00e5ff'
        ctx.lineWidth = 2.4
        ctxRoundRect(ctx, x - hw, y - hh, hw * 2, hh * 2, r)
        ctx.stroke()
        ctx.shadowBlur = 6
        ctx.strokeStyle = '#a0f8ff'
        ctx.lineWidth = 1.1
        ctx.beginPath()
        ctx.moveTo(x - hw + 6, y)
        ctx.lineTo(x + hw - 6, y)
        ctx.stroke()
        ctx.restore()
      }
    }

    Matter.Events.on(render, 'afterRender', drawSkinOverlays)

    Matter.Runner.run(runner, engine)
    Matter.Render.run(render)

    const staleBallTtlMs = 30000
    const cleanupInterval = window.setInterval(() => {
      const now = Date.now()
      for (const body of [...engine.world.bodies]) {
        if (body.label !== 'ball') {
          continue
        }

        const age = now - (body.plugin?.createdAt ?? now)
        const outOfBounds =
          body.position.y > height + 120 ||
          body.position.x < -120 ||
          body.position.x > width + 120

        if (outOfBounds || age > staleBallTtlMs) {
          Matter.World.remove(engine.world, body)
        }
      }

      const liveCount = countLiveBalls(engine.world)
      if (stateRef.current.activeBalls !== liveCount) {
        stateRef.current.activeBalls = liveCount
        setActiveBalls((previous) => (previous === liveCount ? previous : liveCount))
      }
    }, 400)

    const resize = () => {
      const newWidth = Math.min(800, Math.max(500, boardWrapRef.current?.clientWidth ?? 700))
      render.canvas.width = newWidth
      render.options.width = newWidth
    }
    window.addEventListener('resize', resize)

    return () => {
      if (spawnIntervalRef.current) {
        window.clearInterval(spawnIntervalRef.current)
      }
      window.clearInterval(cleanupInterval)
      stopHoldDrop()
      window.removeEventListener('resize', resize)
      Matter.Events.off(render, 'afterRender', drawSkinOverlays)
        Matter.Events.off(engine, 'beforeUpdate', moveGatekeepers)
        gatekeeperBodiesRef.current = []
      Matter.Render.stop(render)
      Matter.Runner.stop(runner)
      Matter.World.clear(engine.world, false)
      Matter.Engine.clear(engine)
    }
  }, [addFloater, mainTab, registerCoins, stopHoldDrop])

  useEffect(() => {
    if (!engineRef.current) {
      return
    }
    engineRef.current.gravity.y = 0.195 + upgrades.gravityLevel * 0.045
  }, [upgrades.gravityLevel])

  useEffect(() => {
    const engine = engineRef.current
    if (!engine) {
      return
    }
    const nextStyle = getPegRenderStyle(upgrades.pegLevel)
    for (const body of engine.world.bodies) {
      if (body.label !== 'peg') {
        continue
      }
      body.render.fillStyle = nextStyle.fillStyle
      body.render.strokeStyle = nextStyle.strokeStyle
      body.render.lineWidth = nextStyle.lineWidth
    }
  }, [upgrades.pegLevel])

  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    const w = engine.render?.options?.width ?? 760
    const h = engine.render?.options?.height ?? 700
    const slotTop = h - 168
    for (const body of gatekeeperBodiesRef.current) {
      Matter.World.remove(engine.world, body)
    }
    const newBodies = createGatekeeperBodies(upgrades.gatekeeperLevel, w, slotTop)
    gatekeeperBodiesRef.current = newBodies
    if (newBodies.length > 0) {
      Matter.World.add(engine.world, newBodies)
    }
  }, [upgrades.gatekeeperLevel])

  const getUpgradeCost = useCallback((upgradeId, level) => {
    const details = upgradeCatalog.find((entry) => entry.id === upgradeId)
    if (!details) {
      return 0
    }
    return Math.floor(details.baseCost * details.growth ** Math.max(0, level - 1))
  }, [])

  const buyBall = useCallback(() => {
    const cost = Math.floor(18 * 1.6 ** (totalBalls - 3))
    if (coins < cost) {
      audioRef.current?.fail()
      return
    }
    setCoins((value) => value - cost)
    setTotalBalls((value) => value + 1)
    audioRef.current?.buy()
  }, [coins, totalBalls])

  const buyGoldenBall = useCallback(() => {
    const cost = getGoldenBallCost(goldenBalls)
    if (coins < cost) {
      audioRef.current?.fail()
      return
    }
    setCoins((value) => value - cost)
    setTotalBalls((value) => value + 1)
    setGoldenBalls((value) => value + 1)
    audioRef.current?.buy()
  }, [coins, goldenBalls])

  const buyUpgrade = useCallback(
    (upgradeId) => {
      const data = upgradeCatalog.find((entry) => entry.id === upgradeId)
      if (!data) {
        return
      }

      const currentLevel = upgrades[upgradeId]
      const maxLevel = UPGRADE_MAX_LEVELS[upgradeId] ?? Number.POSITIVE_INFINITY
      if (currentLevel >= maxLevel) {
        audioRef.current?.fail()
        return
      }

      const cost = getUpgradeCost(upgradeId, currentLevel + 1)
      if (coins < cost) {
        audioRef.current?.fail()
        return
      }

      setCoins((value) => value - cost)
      setUpgrades((previous) => ({
        ...previous,
        [upgradeId]: previous[upgradeId] + 1,
      }))
      audioRef.current?.buy()
    },
    [coins, getUpgradeCost, upgrades],
  )

  const buyOrEquipSkin = useCallback(
    (skinId) => {
      const skin = skinCatalog.find((entry) => entry.id === skinId)
      if (!skin) {
        return
      }

      if (ownedSkins.includes(skinId)) {
        setSelectedSkin(skinId)
        audioRef.current?.buy()
        return
      }

      if (coins < skin.price) {
        audioRef.current?.fail()
        return
      }

      setCoins((value) => value - skin.price)
      setOwnedSkins((previous) => [...previous, skinId])
      setSelectedSkin(skinId)
      audioRef.current?.buy()
    },
    [coins, ownedSkins],
  )

  useEffect(() => {
    if (!audioRef.current) return
    audioRef.current.setVolume(soundOn ? volume : 0)
  }, [soundOn, volume])

  const averageSlotLevel = Math.round(slotLevels.reduce((sum, level) => sum + level, 0) / slotLevels.length)
  const selectedPlayerUpgradeRows = selectedLeaderboardPlayer
    ? Object.entries(selectedLeaderboardPlayer.upgrades ?? {}).sort(([a], [b]) => a.localeCompare(b))
      .map(([upgradeId, level]) => [upgradeTitleById[upgradeId] ?? upgradeId, level])
    : []
  const currentLeaderboardUsername = (committedUsername || leaderboardUsername).trim().toLowerCase()

  return (
    <main className="layout">
      {showUpdateAlert && (
        <div className="update-alert-backdrop" role="dialog" aria-modal="true" aria-labelledby="update-alert-title">
          <article className="update-alert-card">
            <h2 id="update-alert-title">New Update!</h2>
            <p className="update-alert-subtitle">Golden balls? That sounds expensive!</p>
            <ul className="update-alert-list">
              <li>Golden balls that generate 2x more money from pegs</li>
              <li>Base gravity is now half of what it was before</li>
        
            </ul>
            <button className="update-alert-button" onClick={() => setShowUpdateAlert(false)}>
              Got it
            </button>
          </article>
        </div>
      )}
      <section className="main-panel">
        <header className="topbar">
          <div>
            <h1>Peg</h1>
            <p className="subtitle">Roguelike Plinko: hit pegs, evolve slots, chain upgrades.</p>
            <nav className="main-nav" aria-label="Main sections">
              <button
                className={`main-nav-tab ${mainTab === 'game' ? 'active' : ''}`}
                onClick={() => setMainTab('game')}
                aria-pressed={mainTab === 'game'}
              >
                Play
              </button>
              <button
                className={`main-nav-tab ${mainTab === 'leaderboard' ? 'active' : ''}`}
                onClick={() => setMainTab('leaderboard')}
                aria-pressed={mainTab === 'leaderboard'}
              >
                Leaderboard
              </button>
            </nav>
          </div>
          <div className="topbar-right">
            <div className={`coin-bar ${flashCoins ? 'flash' : ''}`}>
              <span>Coins</span>
              <strong>{Math.floor(coins).toLocaleString()}</strong>
            </div>
            <a
              className="github-btn"
              href="https://github.com/btfcookies/peg"
              target="_blank"
              rel="noreferrer"
              aria-label="Open GitHub repository"
              title="GitHub"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path
                  d="M12 2C6.48 2 2 6.58 2 12.22c0 4.51 2.87 8.34 6.84 9.69.5.1.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.49-1.11-1.49-.9-.63.07-.62.07-.62 1 .07 1.52 1.04 1.52 1.04.88 1.54 2.32 1.1 2.89.84.09-.66.34-1.1.62-1.35-2.22-.26-4.56-1.13-4.56-5.04 0-1.11.39-2.02 1.03-2.73-.1-.26-.45-1.31.1-2.74 0 0 .84-.27 2.75 1.04A9.36 9.36 0 0 1 12 7.07c.85 0 1.71.12 2.51.35 1.91-1.31 2.75-1.04 2.75-1.04.55 1.43.2 2.48.1 2.74.64.71 1.03 1.62 1.03 2.73 0 3.92-2.34 4.78-4.58 5.03.36.32.67.95.67 1.92 0 1.39-.01 2.51-.01 2.85 0 .27.18.6.69.49A10.22 10.22 0 0 0 22 12.22C22 6.58 17.52 2 12 2Z"
                />
              </svg>
            </a>
            <a
              className="github-btn"
              href="https://discord.gg/w4hCFVmV"
              target="_blank"
              rel="noreferrer"
              aria-label="Join Discord server"
              title="Discord"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path
                  d="M20.317 4.369A19.791 19.791 0 0 0 15.885 3c-.19.328-.403.772-.552 1.124a18.27 18.27 0 0 0-5.008 0A12.723 12.723 0 0 0 9.772 3a19.736 19.736 0 0 0-4.434 1.37C2.533 8.508 1.772 12.543 2.152 16.522a19.993 19.993 0 0 0 5.436 2.778 13.075 13.075 0 0 0 1.164-1.885 12.894 12.894 0 0 1-1.83-.89c.154-.113.305-.233.452-.357 3.532 1.646 7.361 1.646 10.851 0 .148.124.299.244.453.357a12.823 12.823 0 0 1-1.833.891c.34.671.73 1.297 1.166 1.885a19.934 19.934 0 0 0 5.438-2.779c.445-4.611-.76-8.607-3.694-12.153Zm-10.84 9.73c-1.059 0-1.932-.969-1.932-2.159 0-1.191.852-2.16 1.932-2.16 1.089 0 1.95.978 1.932 2.16 0 1.19-.853 2.159-1.932 2.159Zm5.046 0c-1.059 0-1.932-.969-1.932-2.159 0-1.191.852-2.16 1.932-2.16 1.09 0 1.95.978 1.932 2.16 0 1.19-.844 2.159-1.932 2.159Z"
                />
              </svg>
            </a>
            <button
              className="settings-btn"
              onClick={() => setShowSettings((v) => !v)}
              aria-label="Toggle settings"
            >
              {showSettings ? '[X]' : '⚙'}
            </button>
          </div>
        </header>

        {showSettings && (
          <div className="settings-panel">
            <div className="settings-row">
              <span>SOUND</span>
              <button
                className={`toggle-btn ${soundOn ? 'on' : 'off'}`}
                onClick={() => setSoundOn((v) => !v)}
              >
                {soundOn ? 'ON ' : 'OFF'}
              </button>
            </div>
            <div className="settings-row">
              <span>VOLUME</span>
              <input
                type="range"
                className="retro-slider"
                min="0"
                max="1"
                step="0.01"
                value={volume}
                disabled={!soundOn}
                onChange={(e) => setVolume(Number(e.target.value))}
                onInput={(e) => setVolume(Number(e.target.value))}
              />
              <span className="vol-pct">{Math.round(volume * 100)}%</span>
            </div>
          </div>
        )}

        {mainTab === 'game' ? (
          <>
            <div className="actions-row">
              <button
                className="drop-button"
                onPointerDown={startHoldDrop}
                onPointerUp={stopHoldDrop}
                onPointerLeave={stopHoldDrop}
                onPointerCancel={stopHoldDrop}
                disabled={activeBalls >= totalBalls}
              >
                Drop {Math.min(upgrades.ballsPerDrop, totalBalls - activeBalls)} Ball{Math.min(upgrades.ballsPerDrop, totalBalls - activeBalls) !== 1 ? 's' : '' } (Q)
              </button>
              <div className="stats-chip">Balls: {activeBalls} / {totalBalls}</div>
              <div className="stats-chip">Total Minted: {Math.floor(totalCoins).toLocaleString()}</div>
              <div className="stats-chip">Slot Avg Lv: {averageSlotLevel}</div>
            </div>

            <div className={`board-wrap ${boardShake ? 'shake' : ''}`} ref={boardWrapRef}>
              <canvas ref={canvasRef} aria-label="Peg plinko board" />
              <div className="slot-labels">
                {normalizedSlotRewards.map((amount, index) => {
                  const progressNeed = 7 + slotLevels[index] * 4
                  return (
                    <div key={`slot-${index}`} className="slot-card">
                      <span className="slot-name">S{index + 1}</span>
                      <strong>{amount}</strong>
                      <small>
                        Lv {slotLevels[index]} • {slotFill[index]}/{progressNeed}
                      </small>
                    </div>
                  )
                })}
              </div>

              <div className="floaters-layer">
                {floaters.map((item) => (
                  <div
                    key={item.id}
                    className={`floater ${item.kind}`}
                    style={{ left: `${item.x}%`, top: `${item.y}%` }}
                  >
                    {item.text}
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <section className="leaderboard-main" aria-label="Leaderboard panel">
            <div className="leaderboard-submit">
              <label htmlFor="leaderboard-username">Username</label>
              <div className="leaderboard-submit-row">
                <input
                  id="leaderboard-username"
                  type="text"
                  value={leaderboardUsername}
                  placeholder="Enter a username"
                  maxLength={20}
                  readOnly={!!committedUsername}
                  onChange={(event) => setLeaderboardUsername(event.target.value)}
                />
                <button onClick={submitLeaderboardScore} disabled={leaderboardSubmitting}>
                  {leaderboardSubmitting ? 'Sending...' : committedUsername ? 'Update' : 'Submit'}
                </button>
                {committedUsername && (
                  <button
                    className="leaderboard-change-btn"
                    onClick={() => {
                      setCommittedUsername('')
                      try {
                        window.localStorage.removeItem(LEADERBOARD_COMMITTED_USERNAME_KEY)
                      } catch {
                        // Ignore storage failures.
                      }
                    }}
                  >
                    Change
                  </button>
                )}
              </div>
              {leaderboardSubmitStatus && <p className="leaderboard-status">{leaderboardSubmitStatus}</p>}
              {leaderboardError && <p className="leaderboard-status error">{leaderboardError}</p>}
            </div>

            <div className="leaderboard-main-grid">
              <div className="leaderboard-list" role="list">
                {leaderboardLoading && leaderboardEntries.length === 0 ? (
                  <p className="sidebar-note">Loading rankings...</p>
                ) : (
                  leaderboardEntries.map((entry) => {
                    const isSelected = selectedLeaderboardPlayer?.username === entry.username
                    const isCurrentUser =
                      currentLeaderboardUsername.length > 0 && entry.username.toLowerCase() === currentLeaderboardUsername
                    const isAdmin = entry.username.toLowerCase() === ADMIN_USERNAME.toLowerCase()
                    const badge =
                      entry.rank === 1
                        ? '1ST'
                        : entry.rank === 2
                          ? '2ND'
                          : entry.rank === 3
                            ? '3RD'
                            : null

                    return (
                      <button
                        key={entry.username}
                        className={`leaderboard-row ${isSelected ? 'active' : ''} ${isCurrentUser ? 'self' : ''} ${badge ? `badge-${badge.toLowerCase()}` : ''}`}
                        onClick={() => setSelectedLeaderboardPlayer(entry)}
                        role="listitem"
                      >
                        <span className="leaderboard-rank">#{entry.rank}</span>
                        <span className="leaderboard-name leaderboard-name-wrap">
                          <span className={isAdmin ? 'leaderboard-admin-name' : ''}>{entry.username}</span>
                          {isAdmin && (
                            <span className="leaderboard-admin-crown" title="Admin" aria-label="Admin">
                              {'👑'}
                            </span>
                          )}
                        </span>
                        <span className="leaderboard-coins">{entry.coins.toLocaleString()}c</span>
                        {badge && <span className="leaderboard-badge">{badge}</span>}
                      </button>
                    )
                  })
                )}
              </div>

              {selectedLeaderboardPlayer && (
                <article className="leaderboard-player-card">
                  <h3>
                    {selectedLeaderboardPlayer.username} • Rank #{selectedLeaderboardPlayer.rank}
                  </h3>
                  <div className="leaderboard-player-grid">
                    <span>Coins</span>
                    <strong>{selectedLeaderboardPlayer.coins.toLocaleString()}</strong>
                    <span>Total Coins Ever</span>
                    <strong>{selectedLeaderboardPlayer.totalCoins.toLocaleString()}</strong>
                    <span>Balls</span>
                    <strong>{selectedLeaderboardPlayer.totalBalls}</strong>
                    <span>Golden Balls</span>
                    <strong>{selectedLeaderboardPlayer.goldenBalls ?? 0}</strong>
                    <span>Skin</span>
                    <strong>{selectedLeaderboardPlayer.selectedSkin ?? 'default'}</strong>
                    <span>Skins</span>
                    <strong>{(selectedLeaderboardPlayer.ownedSkins ?? []).length}</strong>
                  </div>

                  <h4>Upgrades</h4>
                  <div className="leaderboard-upgrades">
                    {selectedPlayerUpgradeRows.length === 0 ? (
                      <span>None</span>
                    ) : (
                      selectedPlayerUpgradeRows.map(([name, level]) => (
                        <div key={name} className="leaderboard-upgrade-row">
                          <span>{name}</span>
                          <strong>Lv {level}</strong>
                        </div>
                      ))
                    )}
                  </div>
                </article>
              )}
            </div>
            <p className="sidebar-note">
              Next refresh in {leaderboardCountdown}s
              {leaderboardLastSyncAt
                ? ` • Last sync ${leaderboardLastSyncOk ? 'ok' : 'failed'} at ${new Date(leaderboardLastSyncAt).toLocaleTimeString()}`
                : ''}
            </p>
          </section>
        )}
      </section>

      <aside className="sidebar">
        <h2>Shop</h2>
        <div className="shop-tabs" role="tablist" aria-label="Shop sections">
          <button
            className={`shop-tab ${shopTab === 'upgrades' ? 'active' : ''}`}
            onClick={() => setShopTab('upgrades')}
            role="tab"
            aria-selected={shopTab === 'upgrades'}
          >
            Upgrades
          </button>
          <button
            className={`shop-tab ${shopTab === 'skins' ? 'active' : ''}`}
            onClick={() => setShopTab('skins')}
            role="tab"
            aria-selected={shopTab === 'skins'}
          >
            Skins
          </button>
        </div>

        {shopTab === 'upgrades' ? (
          <>
            <p className="sidebar-note">Spend coins to bend physics and snowball payouts.</p>
            <div className="upgrade-list">
              <article className="upgrade-card">
                <div>
                  <h3>Buy Ball</h3>
                  <p>Add one more ball to your total — all {totalBalls + 1} can be in play at once.</p>
                </div>
                <div className="upgrade-meta">
                  <span>{totalBalls} owned</span>
                  <button disabled={coins < Math.floor(18 * 1.6 ** (totalBalls - 3))} onClick={buyBall}>
                    Buy • {Math.floor(18 * 1.6 ** (totalBalls - 3))}
                  </button>
                </div>
              </article>
              <article className="upgrade-card">
                <div>
                  <h3>Golden Ball</h3>
                  <p>Add one premium ball with a golden outline. Peg hits from golden balls earn 2x peg coins.</p>
                </div>
                <div className="upgrade-meta">
                  <span>{goldenBalls} golden</span>
                  <button disabled={coins < getGoldenBallCost(goldenBalls)} onClick={buyGoldenBall}>
                    Buy • {getGoldenBallCost(goldenBalls)}
                  </button>
                </div>
              </article>
              {upgradeCatalog.map((upgrade) => {
                const level = upgrades[upgrade.id]
                const cost = getUpgradeCost(upgrade.id, level + 1)
                const maxLevel = UPGRADE_MAX_LEVELS[upgrade.id] ?? Number.POSITIVE_INFINITY
                const hasMax = Number.isFinite(maxLevel)
                const isMaxed = hasMax && level >= maxLevel
                return (
                  <article key={upgrade.id} className={`upgrade-card ${isMaxed ? 'maxed' : ''}`}>
                    <div>
                      <h3>{upgrade.title}</h3>
                      <p>{upgrade.description}</p>
                    </div>
                    <div className="upgrade-meta">
                      <span>{hasMax ? `Lv ${level}/${maxLevel}` : `Lv ${level}`}</span>
                      <button disabled={isMaxed || coins < cost} onClick={() => buyUpgrade(upgrade.id)}>
                        {isMaxed ? 'MAX' : `Buy • ${cost}`}
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          </>
        ) : (
          <>
            <p className="sidebar-note">Unlock and equip ball skins. Prisma is the top-tier neon rainbow core.</p>
            <div className="upgrade-list skin-list">
              {skinCatalog.map((skin) => {
                const isOwned = ownedSkins.includes(skin.id)
                const isSelected = selectedSkin === skin.id
                return (
                  <article key={skin.id} className={`upgrade-card skin-card ${skin.id === 'prisma' ? 'prisma' : ''} ${isSelected ? 'selected' : ''}`}>
                    <div className="skin-header">
                      <span className={`skin-preview ${skin.id}`} aria-hidden="true" />
                      <h3>{skin.name}</h3>
                    </div>
                    <p>{skin.description}</p>
                    <div className="upgrade-meta">
                      <span>{skin.price === 0 ? 'Free' : `${skin.price.toLocaleString()} coins`}</span>
                      <button
                        disabled={!isOwned && coins < skin.price}
                        onClick={() => buyOrEquipSkin(skin.id)}
                      >
                        {isSelected ? 'EQUIPPED' : isOwned ? 'Equip' : `Buy • ${skin.price}`}
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          </>
        )}
      </aside>
    </main>
  )
}

export default App
