import { useEffect, useState } from 'react'
import { ProgressEvent } from '../../main/extractor'

// ── Auth state ────────────────────────────────────────────────────────────────

type AuthStatus = 'loading' | 'idle' | 'connecting' | 'connected'
interface AuthState {
  status: AuthStatus
  workspaceName?: string
  error?: string
}

// ── Extraction state ──────────────────────────────────────────────────────────

type ExtractionPhase = 'idle' | 'workspace' | 'users' | 'channels' | 'messages' | 'done' | 'error'
interface ExtractionState {
  phase: ExtractionPhase
  channelName?: string
  channelIndex?: number
  channelTotal?: number
  channelMessages?: number
  totalMessages?: number
  stats?: { users: number; channels: number; messages: number }
  dbPath?: string
  error?: string
}

// ── App ───────────────────────────────────────────────────────────────────────


function App(): JSX.Element {
  const screen = 'extract'
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' })
  const [extraction, setExtraction] = useState<ExtractionState>({ phase: 'idle' })

  // Check saved credentials on startup
  useEffect(() => {
    window.api.invoke('auth:check').then((res) => {
      const r = res as { connected: boolean; workspaceName?: string }
      setAuth(r.connected ? { status: 'connected', workspaceName: r.workspaceName } : { status: 'idle' })
    }).catch(() => setAuth({ status: 'idle' }))
  }, [])

  // Stream extraction progress events from main process
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

  async function handleStartExtraction(opts: { channels?: string[]; noDms?: boolean }): Promise<void> {
    setExtraction({ phase: 'workspace' })
    const res = await window.api.invoke('extract:start', opts) as { error?: string; dbPath?: string }
    if (res.error) setExtraction({ phase: 'error', error: res.error })
    else setExtraction((prev) => ({ ...prev, dbPath: res.dbPath }))
  }

  async function handleStop(): Promise<void> {
    await window.api.invoke('extract:stop')
  }

  return (
    <div className="app">
      <div className="sidebar">
        <div className="logo">
          <span className="logo-icon">#</span>
          <span className="logo-text">Slacker</span>
        </div>
        <nav className="nav">
          <button className={`nav-item ${screen === 'extract' ? 'active' : ''}`}>
            Extract
          </button>
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
          onStart={handleStartExtraction}
          onStop={handleStop}
          onOpenViewer={() => window.api.invoke('viewer:open')}
        />
      </div>
    </div>
  )
}

// ── Progress reducer ──────────────────────────────────────────────────────────

function applyProgressEvent(prev: ExtractionState, event: ProgressEvent): ExtractionState {
  switch (event.type) {
    case 'workspace':
      return { ...prev, phase: 'workspace' }
    case 'users':
      return { ...prev, phase: 'users' }
    case 'channels':
      return { ...prev, phase: 'channels' }
    case 'channel-start':
      return {
        ...prev, phase: 'messages',
        channelName: event.name,
        channelIndex: event.index,
        channelTotal: event.total,
        channelMessages: 0
      }
    case 'channel-progress':
      return {
        ...prev,
        channelMessages: event.messages,
        totalMessages: (prev.totalMessages ?? 0) + 1
      }
    case 'channel-done':
      return {
        ...prev,
        totalMessages: (prev.totalMessages ?? 0) + event.messages
      }
    case 'done':
      return { phase: 'done', stats: event.stats }
    case 'error':
      return { phase: 'error', error: event.message }
    default:
      return prev
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

      {/* ── Step 1: Connect ── */}
      {auth.status === 'loading' && (
        <div className="card">
          <p className="muted">Checking saved credentials…</p>
        </div>
      )}

      {(auth.status === 'idle' || auth.status === 'connecting') && (
        <div className="card">
          <div className="step-badge">Step 1</div>
          <h2>Connect to Slack</h2>
          <p>A browser window will open and load Slack. Sign in normally — your token is captured automatically. No DevTools, no copying values.</p>
          {auth.error && <p className="error-text">{auth.error}</p>}
          <button className="btn btn-primary" onClick={onConnect} disabled={auth.status === 'connecting'}>
            {auth.status === 'connecting' ? <><span className="spinner" /> Waiting for login…</> : 'Connect to Slack →'}
          </button>
        </div>
      )}

      {auth.status === 'connected' && (
        <>
          {/* Connected badge */}
          <div className="card card-success">
            <div className="step-badge done">✓ Step 1</div>
            <h2>Connected{auth.workspaceName && <span className="workspace-name"> · {auth.workspaceName}</span>}</h2>
            <p>Token saved securely on this machine.</p>
            {!running && extraction.phase !== 'done' && (
              <button className="btn btn-ghost btn-sm" onClick={onDisconnect}>Disconnect</button>
            )}
          </div>

          {/* ── Step 2: Configure + run ── */}
          {extraction.phase === 'idle' && (
            <div className="card">
              <div className="step-badge">Step 2</div>
              <h2>Choose What to Extract</h2>
              <p>Select what to download. Re-runs are incremental — already-fetched channels only pull new messages.</p>
              <div className="option-row">
                <label className="option">
                  <input type="radio" name="scope" defaultChecked />
                  <span>Everything (all channels + DMs)</span>
                </label>
                <label className="option">
                  <input type="radio" name="scope" disabled />
                  <span className="muted">Custom channel selection — coming soon</span>
                </label>
              </div>
              <button className="btn btn-primary" onClick={() => onStart({})}>
                Start Extraction →
              </button>
            </div>
          )}

          {/* ── Running ── */}
          {running && (
            <div className="card">
              <div className="step-badge pulse">Extracting…</div>
              <h2>{phaseLabel(extraction.phase)}</h2>
              {extraction.phase === 'messages' && (
                <>
                  <div className="channel-progress-row">
                    <span className="channel-name-label">#{extraction.channelName}</span>
                    <span className="channel-counter">
                      {extraction.channelIndex} / {extraction.channelTotal}
                    </span>
                  </div>
                  <div className="progress-bar-wrap">
                    <div
                      className="progress-bar"
                      style={{
                        width: extraction.channelTotal
                          ? `${((extraction.channelIndex ?? 0) / extraction.channelTotal) * 100}%`
                          : '0%'
                      }}
                    />
                  </div>
                  <p className="progress-label">
                    {(extraction.totalMessages ?? 0).toLocaleString()} messages fetched
                  </p>
                </>
              )}
              <button className="btn btn-ghost" onClick={onStop}>Stop</button>
            </div>
          )}

          {/* ── Done ── */}
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

          {/* ── Error ── */}
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
