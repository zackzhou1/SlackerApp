import { useEffect, useState, useMemo } from 'react'
import { ProgressEvent } from '../../main/extractor'

// ── Types ─────────────────────────────────────────────────────────────────────

type AuthStatus = 'loading' | 'idle' | 'connecting' | 'connected'
interface AuthState {
  status: AuthStatus
  workspaceName?: string
  error?: string
}

type ExtractionPhase = 'idle' | 'workspace' | 'users' | 'channels' | 'messages' | 'done' | 'error'
interface ExtractionState {
  phase: ExtractionPhase
  channelName?: string
  channelIndex?: number
  channelTotal?: number
  totalMessages?: number
  stats?: { users: number; channels: number; messages: number }
  dbPath?: string
  error?: string
}

interface SlackChannel {
  id: string
  name: string
  type: 'channel' | 'group' | 'im' | 'mpim'
}

// ── App ───────────────────────────────────────────────────────────────────────

function App(): JSX.Element {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' })
  const [extraction, setExtraction] = useState<ExtractionState>({ phase: 'idle' })

  useEffect(() => {
    window.api.invoke('auth:check').then((res) => {
      const r = res as { connected: boolean; workspaceName?: string }
      setAuth(r.connected ? { status: 'connected', workspaceName: r.workspaceName } : { status: 'idle' })
    }).catch(() => setAuth({ status: 'idle' }))
  }, [])

  useEffect(() => {
    window.api.on('extract:progress', (...args) => {
      const event = args[0] as ProgressEvent
      setExtraction((prev) => applyProgressEvent(prev, event))
    })
    return () => window.api.off('extract:progress')
  }, [])

  async function handleConnect(): Promise<void> {
    setAuth({ status: 'connecting' })
    try {
      const res = await window.api.invoke('auth:connect') as { success: boolean; reason?: string }
      if (res.success) {
        const check = await window.api.invoke('auth:check') as { connected: boolean; workspaceName?: string }
        setAuth({ status: 'connected', workspaceName: check.workspaceName })
      } else {
        setAuth({ status: 'idle', error: res.reason === 'cancelled' ? undefined : 'Could not extract token — try again.' })
      }
    } catch {
      setAuth({ status: 'idle', error: 'Something went wrong.' })
    }
  }

  async function handleDisconnect(): Promise<void> {
    await window.api.invoke('auth:disconnect')
    setAuth({ status: 'idle' })
    setExtraction({ phase: 'idle' })
  }

  async function handleStart(opts: { channels?: string[]; noDms?: boolean }): Promise<void> {
    setExtraction({ phase: 'workspace' })
    const res = await window.api.invoke('extract:start', opts) as { error?: string; dbPath?: string }
    if (res.error) setExtraction({ phase: 'error', error: res.error })
    else setExtraction((prev) => ({ ...prev, dbPath: res.dbPath }))
  }

  return (
    <div className="app">
      <div className="sidebar">
        <div className="logo">
          <span className="logo-icon">#</span>
          <span className="logo-text">Slacker</span>
        </div>
        <nav className="nav">
          <button className="nav-item active">Extract</button>
          <button className="nav-item" onClick={() => window.api.invoke('viewer:open')}>
            View Messages ↗
          </button>
        </nav>
        <div className="sidebar-footer">
          <div className={`status-dot ${auth.status === 'connected' ? 'connected' : 'idle'}`} />
          <span className="status-text">
            {auth.status === 'loading' && 'Loading…'}
            {auth.status === 'idle' && 'Not connected'}
            {auth.status === 'connecting' && 'Connecting…'}
            {auth.status === 'connected' && (auth.workspaceName || 'Connected')}
          </span>
        </div>
      </div>

      <div className="main">
        <ExtractScreen
          auth={auth}
          extraction={extraction}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
          onStart={handleStart}
          onStop={() => window.api.invoke('extract:stop')}
          onOpenViewer={() => window.api.invoke('viewer:open')}
        />
      </div>
    </div>
  )
}

// ── Progress reducer ──────────────────────────────────────────────────────────

function applyProgressEvent(prev: ExtractionState, event: ProgressEvent): ExtractionState {
  switch (event.type) {
    case 'workspace': return { ...prev, phase: 'workspace' }
    case 'users':     return { ...prev, phase: 'users' }
    case 'channels':  return { ...prev, phase: 'channels' }
    case 'channel-start':
      return { ...prev, phase: 'messages', channelName: event.name, channelIndex: event.index, channelTotal: event.total }
    case 'channel-progress':
      return { ...prev, channelMessages: event.messages }
    case 'channel-done':
      return { ...prev, totalMessages: (prev.totalMessages ?? 0) + event.messages }
    case 'done':
      return { phase: 'done', stats: event.stats }
    case 'stopped':
      return { phase: 'idle' }
    case 'error':
      return { phase: 'error', error: event.message }
    default: return prev
  }
}

// ── Extract Screen ────────────────────────────────────────────────────────────

interface ExtractScreenProps {
  auth: AuthState
  extraction: ExtractionState
  onConnect: () => void
  onDisconnect: () => void
  onStart: (opts: { channels?: string[]; noDms?: boolean }) => void
  onStop: () => void
  onOpenViewer: () => void
}

function ExtractScreen({ auth, extraction, onConnect, onDisconnect, onStart, onStop, onOpenViewer }: ExtractScreenProps): JSX.Element {
  const running = ['workspace', 'users', 'channels', 'messages'].includes(extraction.phase)

  return (
    <>
      <div className="header">
        <h1>Extract Slack Data</h1>
        <p className="subtitle">Pull your workspace messages into a local database — no admin access needed</p>
      </div>

      {auth.status === 'loading' && <div className="card"><p className="muted">Checking saved credentials…</p></div>}

      {(auth.status === 'idle' || auth.status === 'connecting') && (
        <div className="card">
          <div className="step-badge">Step 1</div>
          <h2>Connect to Slack</h2>
          <p>A browser window will open and load Slack. Sign in normally — your token is captured automatically.</p>
          {auth.error && <p className="error-text">{auth.error}</p>}
          <button className="btn btn-primary" onClick={onConnect} disabled={auth.status === 'connecting'}>
            {auth.status === 'connecting' ? <><span className="spinner" /> Waiting for login…</> : 'Connect to Slack →'}
          </button>
        </div>
      )}

      {auth.status === 'connected' && (
        <>
          <div className="card card-success">
            <div className="step-badge done">✓ Step 1</div>
            <h2>Connected{auth.workspaceName && <span className="workspace-name"> · {auth.workspaceName}</span>}</h2>
            <p>Token saved securely on this machine.</p>
            {!running && extraction.phase !== 'done' && (
              <button className="btn btn-ghost btn-sm" onClick={onDisconnect}>Disconnect</button>
            )}
          </div>

          {extraction.phase === 'idle' && (
            <ChannelSelector onStart={onStart} />
          )}

          {running && (
            <div className="card">
              <div className="step-badge pulse">Extracting…</div>
              <h2>{phaseLabel(extraction.phase)}</h2>
              {extraction.phase === 'messages' && (
                <>
                  <div className="channel-progress-row">
                    <span className="channel-name-label">#{extraction.channelName}</span>
                    <span className="channel-counter">{extraction.channelIndex} / {extraction.channelTotal}</span>
                  </div>
                  <div className="progress-bar-wrap">
                    <div className="progress-bar" style={{
                      width: extraction.channelTotal
                        ? `${((extraction.channelIndex ?? 0) / extraction.channelTotal) * 100}%`
                        : '0%'
                    }} />
                  </div>
                  <p className="progress-label">{(extraction.totalMessages ?? 0).toLocaleString()} messages fetched</p>
                </>
              )}
              <button className="btn btn-ghost" onClick={onStop}>Stop</button>
            </div>
          )}

          {extraction.phase === 'done' && extraction.stats && (
            <div className="card card-success">
              <div className="step-badge done">✓ Done</div>
              <h2>Extraction complete</h2>
              <div className="stats-grid">
                <div className="stat"><span className="stat-value">{extraction.stats.messages.toLocaleString()}</span><span className="stat-label">messages</span></div>
                <div className="stat"><span className="stat-value">{extraction.stats.channels.toLocaleString()}</span><span className="stat-label">channels</span></div>
                <div className="stat"><span className="stat-value">{extraction.stats.users.toLocaleString()}</span><span className="stat-label">users</span></div>
              </div>
              {extraction.dbPath && <p className="db-path">{extraction.dbPath}</p>}
              <div className="btn-row">
                <button className="btn btn-primary" onClick={onOpenViewer}>View Messages ↗</button>
                <button className="btn btn-ghost btn-sm" onClick={() => onStart({})}>Run Again</button>
              </div>
            </div>
          )}

          {extraction.phase === 'error' && (
            <div className="card card-error">
              <div className="step-badge error">Error</div>
              <h2>Extraction failed</h2>
              <p className="error-text">{extraction.error}</p>
              <button className="btn btn-ghost" onClick={() => onStart({})}>Try Again</button>
            </div>
          )}
        </>
      )}
    </>
  )
}

// ── Channel Selector ──────────────────────────────────────────────────────────

function ChannelSelector({ onStart }: { onStart: (opts: { channels?: string[]; noDms?: boolean }) => void }): JSX.Element {
  const [scope, setScope] = useState<'all' | 'custom'>('all')
  const [channels, setChannels] = useState<SlackChannel[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [includeDms, setIncludeDms] = useState(true)
  const [filter, setFilter] = useState('')

  async function loadChannels(): Promise<void> {
    setLoading(true)
    setLoadError('')
    try {
      const res = await window.api.invoke('channels:list') as { channels?: SlackChannel[]; error?: string }
      if (res.error) { setLoadError(res.error); return }
      const regular = (res.channels ?? []).filter(c => c.type === 'channel' || c.type === 'group')
      setChannels(regular)
      setSelected(new Set(regular.map(c => c.id)))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (scope === 'custom' && channels.length === 0) loadChannels()
  }, [scope])

  const filtered = useMemo(() =>
    filter ? channels.filter(c => c.name.toLowerCase().includes(filter.toLowerCase())) : channels,
    [channels, filter]
  )

  function toggleAll(checked: boolean): void {
    setSelected(checked ? new Set(filtered.map(c => c.id)) : new Set())
  }

  function toggle(id: string): void {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function handleStart(): void {
    if (scope === 'all') {
      onStart({})
    } else {
      const names = channels.filter(c => selected.has(c.id)).map(c => c.name)
      onStart({ channels: names, noDms: !includeDms })
    }
  }

  const allFilteredSelected = filtered.length > 0 && filtered.every(c => selected.has(c.id))

  return (
    <div className="card">
      <div className="step-badge">Step 2</div>
      <h2>Choose What to Extract</h2>
      <p>Re-runs are incremental — already-fetched channels only pull new messages.</p>

      <div className="option-row">
        <label className="option">
          <input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} />
          <span>Everything (all channels + DMs)</span>
        </label>
        <label className="option">
          <input type="radio" name="scope" checked={scope === 'custom'} onChange={() => setScope('custom')} />
          <span>Choose specific channels</span>
        </label>
      </div>

      {scope === 'custom' && (
        <div className="channel-picker">
          {loading && <p className="muted">Loading channels…</p>}
          {loadError && <p className="error-text">{loadError} <button className="link-btn" onClick={loadChannels}>Retry</button></p>}

          {!loading && channels.length > 0 && (
            <>
              <div className="picker-toolbar">
                <input
                  className="picker-search"
                  type="text"
                  placeholder="Filter channels…"
                  value={filter}
                  onChange={e => setFilter(e.target.value)}
                />
                <label className="option picker-select-all">
                  <input type="checkbox" checked={allFilteredSelected} onChange={e => toggleAll(e.target.checked)} />
                  <span>{allFilteredSelected ? 'Deselect all' : 'Select all'}</span>
                </label>
              </div>

              <div className="channel-list-scroll">
                {filtered.map(ch => (
                  <label key={ch.id} className="channel-check-item">
                    <input type="checkbox" checked={selected.has(ch.id)} onChange={() => toggle(ch.id)} />
                    <span className="ch-check-icon">{ch.type === 'group' ? '🔒' : '#'}</span>
                    <span className="ch-check-name">{ch.name}</span>
                  </label>
                ))}
                {filtered.length === 0 && <p className="muted">No channels match "{filter}"</p>}
              </div>

              <label className="option dm-toggle">
                <input type="checkbox" checked={includeDms} onChange={e => setIncludeDms(e.target.checked)} />
                <span>Include DMs and group DMs</span>
              </label>

              <p className="picker-count">
                {selected.size} of {channels.length} channels selected
                {includeDms && ' + all DMs'}
              </p>
            </>
          )}
        </div>
      )}

      <button
        className="btn btn-primary"
        onClick={handleStart}
        disabled={scope === 'custom' && loading}
      >
        Start Extraction →
      </button>
    </div>
  )
}

function phaseLabel(phase: ExtractionPhase): string {
  switch (phase) {
    case 'workspace': return 'Fetching workspace info…'
    case 'users':     return 'Fetching users…'
    case 'channels':  return 'Fetching channel list…'
    case 'messages':  return 'Fetching messages…'
    default:          return ''
  }
}

export default App
