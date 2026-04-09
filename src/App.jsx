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
    maxLevel: 9,
  },
  {
    id: 'gravityLevel',
    title: 'Gravity Drive',
    description: 'Increase board gravity and game pace.',
    baseCost: 35,
    growth: 1.65,
    maxLevel: 8,
  },
  {
    id: 'pegLevel',
    title: 'Peg Engine',
    description: 'Peg hits that pay out give dramatically more coins.',
    baseCost: 40,
    growth: 1.75,
    maxLevel: 12,
  },
  {
    id: 'rainbowLevel',
    title: 'Prism Core',
    description: 'Each level: +8% peg coin chance and unlocks rainbow coin text.',
    baseCost: 44,
    growth: 1.75,
    maxLevel: 8,
  },
  {
    id: 'slotGlobalLevel',
    title: 'Slot Forge',
    description: 'Multiply every slot payout.',
    baseCost: 55,
    growth: 1.8,
    maxLevel: 10,
  },
  {
    id: 'frenzyLevel',
    title: 'Neon Frenzy',
    description: 'Unlock auto-drops and huge payout surges.',
    baseCost: 110,
    growth: 2.2,
    maxLevel: 5,
  },
]

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
    peg: () => tone({ frequency: 410 + Math.random() * 80, type: 'triangle', duration: 0.07, gain: 0.48 }),
    slot: (slotIndex) => {
      const root = 220 + slotIndex * 15
      tone({ frequency: root, type: 'sine', duration: 0.18, gain: 0.08 })
      tone({ frequency: root * 1.5, type: 'triangle', duration: 0.2, gain: 0.06 })
    },
    buy: () => {
      tone({ frequency: 420, type: 'square', duration: 0.08, gain: 0.07 })
      tone({ frequency: 610, type: 'triangle', duration: 0.12, gain: 0.08 })
    },
    fail: () => tone({ frequency: 140, type: 'sawtooth', duration: 0.1, gain: 0.06 }),
    frenzy: () => {
      tone({ frequency: 260, type: 'square', duration: 0.12, gain: 0.08 })
      tone({ frequency: 390, type: 'square', duration: 0.12, gain: 0.08 })
      tone({ frequency: 520, type: 'triangle', duration: 0.2, gain: 0.08 })
    },
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

  const [coins, setCoins] = useState(40)
  const [totalCoins, setTotalCoins] = useState(0)
  const [totalBalls, setTotalBalls] = useState(3)
  const [activeBalls, setActiveBalls] = useState(0)
  const [flashCoins, setFlashCoins] = useState(false)
  const [boardShake, setBoardShake] = useState(false)
  const [frenzyUntil, setFrenzyUntil] = useState(0)
  const [floaters, setFloaters] = useState([])
  const [showSettings, setShowSettings] = useState(false)
  const [soundOn, setSoundOn] = useState(true)
  const [volume, setVolume] = useState(0.18)

  const [upgrades, setUpgrades] = useState({
    ballsPerDrop: 1,
    gravityLevel: 1,
    pegLevel: 1,
    rainbowLevel: 0,
    slotGlobalLevel: 1,
    frenzyLevel: 0,
  })

  const [slotLevels, setSlotLevels] = useState(() => Array.from({ length: SLOT_COUNT }, () => 1))
  const [slotFill, setSlotFill] = useState(() => Array.from({ length: SLOT_COUNT }, () => 0))

  const stateRef = useRef({ upgrades, slotLevels, slotFill, totalBalls, activeBalls: 0 })

  useEffect(() => {
    stateRef.current = { ...stateRef.current, upgrades, slotLevels, slotFill, totalBalls }
  }, [upgrades, slotLevels, slotFill, totalBalls])

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

  const frenzyActive = frenzyUntil > Date.now()

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
    if (stateRef.current.activeBalls >= stateRef.current.totalBalls) {
      return
    }

    const width = engine.render?.options?.width ?? 760
    const xCenter = width / 2
    const hue = 175 + Math.floor(Math.random() * 90)
    const ball = Matter.Bodies.polygon(xCenter + (Math.random() - 0.5) * 24, 32, 8, 8.8, {
      restitution: 0.6,
      friction: 0.004,
      frictionAir: 0.0015,
      density: 0.0018,
      label: 'ball',
      render: {
        fillStyle: frenzyActive ? '#ffe66e' : `hsl(${hue} 92% 66%)`,
        strokeStyle: '#132318',
        lineWidth: 2,
      },
      plugin: {
        intensity,
      },
    })

    Matter.World.add(engine.world, ball)
    stateRef.current.activeBalls = (stateRef.current.activeBalls ?? 0) + 1
    setActiveBalls((value) => value + 1)
  }, [frenzyActive])

  const dropBallWave = useCallback(() => {
    const count = stateRef.current.upgrades.ballsPerDrop + (frenzyActive ? 1 : 0)
    let spawned = 0
    for (let i = 0; i < count; i += 1) {
      if (activeBalls + spawned >= totalBalls) break
      const delay = spawned * 70
      spawned += 1
      window.setTimeout(() => spawnBall(1 + i * 0.1), delay)
    }
  }, [frenzyActive, spawnBall, activeBalls, totalBalls])

  useEffect(() => {
    if (!boardWrapRef.current || !canvasRef.current) {
      return undefined
    }

    audioRef.current = createAudioEngine()
    audioRef.current?.setVolume(soundOn ? volume : 0)

    const width = Math.min(800, Math.max(500, boardWrapRef.current.clientWidth))
    const height = 700

    const engine = Matter.Engine.create()
    engine.gravity.y = 0.86
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
    const pegs = []

    for (let row = 0; row < pegRows; row += 1) {
      const count = row % 2 === 0 ? SLOT_COUNT : SLOT_COUNT - 1
      const offset = row % 2 === 0 ? 0 : pegSpacingX / 2
      for (let col = 0; col < count; col += 1) {
        const peg = Matter.Bodies.polygon(pegSpacingX + col * pegSpacingX + offset, 120 + row * pegSpacingY, 6, 7, {
          isStatic: true,
          label: 'peg',
          render: {
            fillStyle: '#0e2c32',
            strokeStyle: '#84f5d9',
            lineWidth: 1.2,
          },
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

    const slotAreaTop = height - 168
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

    Matter.Events.on(engine, 'collisionStart', (event) => {
      for (const pair of event.pairs) {
        const labels = [pair.bodyA.label, pair.bodyB.label]
        const ballBody = labels[0] === 'ball' ? pair.bodyA : labels[1] === 'ball' ? pair.bodyB : null
        if (!ballBody) {
          continue
        }

        const slotLabel = labels.find((label) => label.startsWith('slot-'))
        const pegHit = labels.includes('peg')

        if (pegHit) {
          audioRef.current?.peg()
          const { pegLevel, rainbowLevel, frenzyLevel } = stateRef.current.upgrades
          const pegChance = Math.min(0.9, 1 / 3 + rainbowLevel * 0.08)
          if (Math.random() < pegChance) {
            const crit = Math.random() < 0.1
            const frenzyBoost = frenzyActive ? 1 + frenzyLevel * 0.55 : 1
            const amount = Math.max(1, Math.round((0.8 + pegLevel * 0.7) * (crit ? 5 : 1) * frenzyBoost))
            registerCoins(amount)
            const x = (ballBody.position.x / width) * 100
            const y = (ballBody.position.y / height) * 100
            const rainbow = rainbowLevel > 0
            addFloater(x, y, `+${amount}`, rainbow ? (crit ? 'pegCrit' : 'peg') : 'pegBase')
          }
        }

        if (slotLabel) {
          const slotIndex = Number(slotLabel.replace('slot-', ''))
          const reward = Math.round(
            SLOT_BASE_REWARDS[slotIndex] * stateRef.current.slotLevels[slotIndex] * (0.8 + stateRef.current.upgrades.slotGlobalLevel * 0.25),
          )
          const frenzyReward = frenzyActive ? Math.round(reward * (1 + stateRef.current.upgrades.frenzyLevel * 0.35)) : reward
          registerCoins(frenzyReward)
          audioRef.current?.slot(slotIndex)
          addFloater((ballBody.position.x / width) * 100, (ballBody.position.y / height) * 100, `+${frenzyReward}`, 'slot')

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
          stateRef.current.activeBalls = Math.max(0, (stateRef.current.activeBalls ?? 1) - 1)
          setActiveBalls((value) => Math.max(0, value - 1))
          setBoardShake(true)
          window.setTimeout(() => setBoardShake(false), 160)
        }
      }
    })

    const runner = Matter.Runner.create()
    runnerRef.current = runner

    Matter.Runner.run(runner, engine)
    Matter.Render.run(render)

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
      window.removeEventListener('resize', resize)
      Matter.Render.stop(render)
      Matter.Runner.stop(runner)
      Matter.World.clear(engine.world, false)
      Matter.Engine.clear(engine)
    }
  }, [addFloater, frenzyActive, registerCoins])

  useEffect(() => {
    if (!engineRef.current) {
      return
    }
    engineRef.current.gravity.y = 0.78 + upgrades.gravityLevel * 0.18
  }, [upgrades.gravityLevel])

  useEffect(() => {
    if (!frenzyActive || upgrades.frenzyLevel < 1) {
      if (spawnIntervalRef.current) {
        window.clearInterval(spawnIntervalRef.current)
      }
      return
    }

    spawnIntervalRef.current = window.setInterval(() => {
      spawnBall(1.8)
    }, Math.max(240, 520 - upgrades.frenzyLevel * 50))

    return () => {
      if (spawnIntervalRef.current) {
        window.clearInterval(spawnIntervalRef.current)
      }
    }
  }, [frenzyActive, spawnBall, upgrades.frenzyLevel])

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

  const buyUpgrade = useCallback(
    (upgradeId) => {
      const data = upgradeCatalog.find((entry) => entry.id === upgradeId)
      if (!data) {
        return
      }

      const currentLevel = upgrades[upgradeId]
      if (currentLevel >= data.maxLevel) {
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

      if (upgradeId === 'frenzyLevel') {
        const durationMs = 7000 + currentLevel * 2000
        setFrenzyUntil(Date.now() + durationMs)
        audioRef.current?.frenzy()
      }
    },
    [coins, getUpgradeCost, upgrades],
  )

  useEffect(() => {
    if (!audioRef.current) return
    audioRef.current.setVolume(soundOn ? volume : 0)
  }, [soundOn, volume])

  const averageSlotLevel = Math.round(slotLevels.reduce((sum, level) => sum + level, 0) / slotLevels.length)

  return (
    <main className="layout">
      <section className="main-panel">
        <header className="topbar">
          <div>
            <h1>Peg</h1>
            <p className="subtitle">Roguelike Plinko: hit pegs, evolve slots, chain upgrades.</p>
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

        <div className="actions-row">
          <button className="drop-button" onClick={dropBallWave} disabled={activeBalls >= totalBalls}>
            Drop {Math.min(upgrades.ballsPerDrop + (frenzyActive ? 1 : 0), totalBalls - activeBalls)} Ball{Math.min(upgrades.ballsPerDrop + (frenzyActive ? 1 : 0), totalBalls - activeBalls) !== 1 ? 's' : ''}
          </button>
          <div className="stats-chip">Balls: {activeBalls} / {totalBalls}</div>
          <div className="stats-chip">Total Minted: {Math.floor(totalCoins).toLocaleString()}</div>
          <div className="stats-chip">Slot Avg Lv: {averageSlotLevel}</div>
          {frenzyActive ? <div className="stats-chip frenzy">Neon Frenzy Active</div> : null}
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
      </section>

      <aside className="sidebar">
        <h2>Upgrades</h2>
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
          {upgradeCatalog.map((upgrade) => {
            const level = upgrades[upgrade.id]
            const cost = getUpgradeCost(upgrade.id, level + 1)
            const isMaxed = level >= upgrade.maxLevel
            return (
              <article key={upgrade.id} className={`upgrade-card ${upgrade.id === 'frenzyLevel' ? 'rare' : ''}`}>
                <div>
                  <h3>{upgrade.title}</h3>
                  <p>{upgrade.description}</p>
                </div>
                <div className="upgrade-meta">
                  <span>Lv {level}/{upgrade.maxLevel}</span>
                  <button disabled={isMaxed || coins < cost} onClick={() => buyUpgrade(upgrade.id)}>
                    {isMaxed ? 'MAX' : `Buy • ${cost}`}
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      </aside>
    </main>
  )
}

export default App
