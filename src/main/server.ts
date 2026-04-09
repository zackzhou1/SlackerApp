/**
 * server.ts
 * Local Express server that powers the Slack viewer.
 * Port of slack_ui.py's Flask routes.
 */

import express from 'express'
import Database, { Database as DB } from 'better-sqlite3'
import { createServer, Server } from 'http'
import { AddressInfo } from 'net'
import { join } from 'path'
import { readFileSync } from 'fs'
import { app as electronApp } from 'electron'

// ── Caches ────────────────────────────────────────────────────────────────────

type UserEntry = { name: string; realName: string }
type ChannelEntry = { name: string; type: string }

let userCache: Record<string, UserEntry> = {}
let channelCache: Record<string, ChannelEntry> = {}

// Result caches — cleared whenever loadCaches() runs (new extraction opened)
let workspaceCache: { name: string; domain: string } | null = null
let channelListCache: unknown[] | null = null
const fileListCache = new Map<string, unknown[]>()

function clearResultCaches(): void {
  workspaceCache = null
  channelListCache = null
  fileListCache.clear()
}

function loadCaches(db: DB): void {
  userCache = {}
  channelCache = {}
  for (const r of db.prepare('SELECT id, name, real_name, display_name FROM users').all() as {
    id: string; name: string; real_name: string; display_name: string
  }[]) {
    userCache[r.id] = {
      name: r.display_name || r.real_name || r.name || r.id,
      realName: r.real_name || r.display_name || r.name
    }
  }
  for (const r of db.prepare('SELECT id, name, type FROM channels').all() as {
    id: string; name: string; type: string
  }[]) {
    channelCache[r.id] = { name: r.name, type: r.type }
  }
  clearResultCaches()
}

function userDisplay(uid: string): string {
  return userCache[uid]?.name ?? uid ?? 'Unknown'
}

function channelDisplayName(id: string, name: string, type: string, members?: string): string {
  if (type === 'im') {
    // Try members JSON first (more reliable), then fall back to name-as-user-id
    if (members) {
      try {
        const ids = JSON.parse(members) as string[]
        const other = ids.find(uid => userCache[uid])
        if (other) return userDisplay(other)
      } catch { /* fall through */ }
    }
    if (name?.match(/^[UW]/)) return userDisplay(name)
    return name || id
  }
  if (type === 'mpim') {
    // Try resolving member names from members JSON
    if (members) {
      try {
        const ids = JSON.parse(members) as string[]
        const names = ids.map(uid => userCache[uid]?.name).filter(Boolean)
        if (names.length > 1) return names.join(', ')
      } catch { /* fall through */ }
    }
    // Fallback: parse mpdm-alice--bob--charlie-1 → alice, bob, charlie
    const stripped = name?.replace(/^mpdm-/, '').replace(/-\d+$/, '')
    if (stripped) return stripped.split('--').join(', ')
    return name || id
  }
  return name || id
}

// ── FTS setup ─────────────────────────────────────────────────────────────────

function setupFts(db: DB): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text,
      content=messages,
      content_rowid=rowid,
      tokenize='unicode61'
    )
  `)
  const ftsCount = (db.prepare('SELECT COUNT(*) as n FROM messages_fts').get() as { n: number }).n
  const msgCount = (db.prepare('SELECT COUNT(*) as n FROM messages').get() as { n: number }).n
  if (ftsCount !== msgCount) {
    console.log(`Building search index (${ftsCount} indexed / ${msgCount} messages)...`)
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
    console.log('Search index ready.')
  }
}

// ── Text formatting ───────────────────────────────────────────────────────────

function formatText(text: string): string {
  if (!text) return ''

  text = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // User mentions: &lt;@U123&gt; or &lt;@U123|name&gt;
  text = text.replace(/&lt;@([A-Z0-9]+)(?:\|[^&]*)?&gt;/g, (_, uid) => {
    const name = userDisplay(uid)
    return `<a class="mention user-link" data-user-id="${uid}" href="#">@${name}</a>`
  })

  // Channel mentions: &lt;#C123|name&gt;
  text = text.replace(/&lt;#([A-Z0-9a-z_-]+)(?:\|([^&]*))?&gt;/g, (_, chId, chName) => {
    const name = chName || channelCache[chId]?.name || chId
    return `<a class="mention ch-link" data-ch-id="${chId}" href="#">#${name}</a>`
  })

  // URLs: &lt;https://...|label&gt; or &lt;https://...&gt;
  text = text.replace(/&lt;(https?:\/\/[^&|>]+)(?:\|([^&]*))?&gt;/g, (_, url, label) => {
    return `<a href="${url}" target="_blank" rel="noopener">${label || url}</a>`
  })

  // Code blocks (must come before inline code)
  text = text.replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')

  // Inline code
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>')

  // Bold, italic, strikethrough
  text = text.replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
  text = text.replace(/\b_([^_\n]+)_\b/g, '<em>$1</em>')
  text = text.replace(/~([^~\n]+)~/g, '<del>$1</del>')

  return text.replace(/\n/g, '<br>')
}

function formatTs(ts: string): string {
  try {
    const d = new Date(parseFloat(ts) * 1000)
    const m = d.getMonth() + 1
    const day = d.getDate()
    const yr = String(d.getFullYear()).slice(2)
    let h = d.getHours()
    const min = String(d.getMinutes()).padStart(2, '0')
    const ampm = h >= 12 ? 'PM' : 'AM'
    h = h % 12 || 12
    return `${m}/${day}/${yr} ${h}:${min} ${ampm}`
  } catch {
    return ts
  }
}

// ── Serialization ─────────────────────────────────────────────────────────────

type FileRow = { id: string; local_path: string | null; mimetype: string | null }

function batchFileLookup(db: DB, rawFilesList: (string | null)[]): Record<string, FileRow> {
  const ids = new Set<string>()
  for (const raw of rawFilesList) {
    try {
      for (const f of JSON.parse(raw || '[]') as { id?: string }[]) {
        if (f.id) ids.add(f.id)
      }
    } catch { /* ignore */ }
  }
  if (!ids.size) return {}
  const ph = [...ids].map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT id, local_path, mimetype FROM files WHERE id IN (${ph})`
  ).all([...ids]) as FileRow[]
  return Object.fromEntries(rows.map((r) => [r.id, r]))
}

function serializeFiles(rawFiles: string | null, fileMap: Record<string, FileRow> = {}): object[] {
  try {
    const files = JSON.parse(rawFiles || '[]') as {
      id?: string; name?: string; title?: string; mimetype?: string; size?: number
    }[]
    return files.flatMap((f) => {
      if (!f.id) return []
      const row = fileMap[f.id]
      const downloaded = row?.local_path ? true : false
      return [{
        id: f.id,
        name: f.name ?? 'file',
        title: f.title ?? f.name ?? 'file',
        mimetype: row?.mimetype ?? f.mimetype ?? '',
        size: f.size ?? 0,
        downloaded,
        url: downloaded ? `/api/files/${f.id}` : null
      }]
    })
  } catch {
    return []
  }
}

type MsgRow = Record<string, unknown>

function serializeMessage(r: MsgRow, includeChannel = false, fileMap: Record<string, FileRow> = {}): object {
  const uid = r.user_id as string | null
  const out: Record<string, unknown> = {
    id: r.id,
    ts: r.ts,
    ts_display: formatTs(r.ts as string),
    user_id: uid,
    user_name: uid ? userDisplay(uid) : 'Unknown',
    text: formatText((r.text as string) ?? ''),
    thread_ts: r.thread_ts ?? null,
    reply_count: (r.reply_count as number) ?? 0,
    reactions: JSON.parse((r.reactions as string) || '[]'),
    files: serializeFiles(r.files as string | null, fileMap)
  }
  if (includeChannel) {
    const chId = r.channel_id as string
    const ch = channelCache[chId] ?? { name: '', type: 'channel' }
    out.channel_id = chId
    out.channel_name = channelDisplayName(chId, ch.name, ch.type)
    out.channel_type = ch.type
  }
  return out
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ── FTS query sanitizer ───────────────────────────────────────────────────────

function ftsQuery(q: string): string {
  const cleaned = q.replace(/["'():^*+\-]/g, ' ')
  const tokens = cleaned.split(/\s+/).filter(Boolean)
  return tokens.map((t) => `"${t}"`).join(' ')
}

// ── Build Express app ─────────────────────────────────────────────────────────

function buildApp(db: DB): express.Application {
  const exApp = express()

  exApp.get('/api/workspace', (_req, res) => {
    if (workspaceCache) { res.json(workspaceCache); return }
    const row = db.prepare('SELECT name, domain FROM workspaces LIMIT 1').get() as
      { name: string; domain: string } | undefined
    workspaceCache = row ?? { name: 'Slacker', domain: '' }
    res.json(workspaceCache)
  })

  exApp.get('/api/channels', (_req, res) => {
    if (channelListCache) { res.json(channelListCache); return }
    const rows = db.prepare(`
      SELECT c.id, c.name, c.type, c.is_archived, c.members, COUNT(m.id) as msg_count
      FROM channels c
      LEFT JOIN messages m ON m.channel_id = c.id
      GROUP BY c.id
      HAVING COUNT(m.id) > 0
    `).all() as { id: string; name: string; type: string; is_archived: number; members: string | null; msg_count: number }[]

    const mapped = rows.map((r) => ({
      id: r.id,
      name: channelDisplayName(r.id, r.name, r.type, r.members ?? undefined),
      type: r.type,
      is_archived: r.is_archived === 1,
      msg_count: r.msg_count
    }))
    // Sort by resolved display name (raw DB name is useless for DMs/MPIMs)
    mapped.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    channelListCache = mapped
    res.json(mapped)
  })

  exApp.get('/api/channels/:id/messages', (req, res) => {
    const { id } = req.params
    const before = req.query.before as string | undefined
    const limit = parseInt((req.query.limit as string) || '50')

    let query = `
      SELECT m.id, m.ts, m.user_id, m.text, m.thread_ts,
             m.reply_count, m.reactions, m.files
      FROM messages m
      WHERE m.channel_id = ?
        AND (m.thread_ts IS NULL OR m.thread_ts = m.ts)
    `
    const params: unknown[] = [id]
    if (before) { query += ' AND m.ts < ?'; params.push(before) }
    query += ' ORDER BY m.ts DESC LIMIT ?'
    params.push(limit + 1)

    const rows = db.prepare(query).all(params) as MsgRow[]
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit)
    const fileMap = batchFileLookup(db, page.map((r) => r.files as string | null))

    res.json({
      messages: page.map((r) => serializeMessage(r, false, fileMap)),
      has_more: hasMore
    })
  })

  exApp.get('/api/channels/:id/thread/:ts', (req, res) => {
    const { id, ts } = req.params
    const rows = db.prepare(`
      SELECT m.id, m.ts, m.user_id, m.text, m.thread_ts,
             m.reply_count, m.reactions, m.files
      FROM messages m
      WHERE m.channel_id = ? AND m.thread_ts = ?
      ORDER BY m.ts ASC
    `).all(id, ts) as MsgRow[]

    const fileMap = batchFileLookup(db, rows.map((r) => r.files as string | null))
    const messages = rows.map((r, i) => {
      const msg = serializeMessage(r, false, fileMap) as Record<string, unknown>
      if (i === 0) msg.is_parent = true
      return msg
    })
    res.json(messages)
  })

  exApp.get('/api/files/:id', (req, res) => {
    const row = db.prepare(
      'SELECT local_path, name, mimetype FROM files WHERE id = ?'
    ).get(req.params.id) as { local_path: string | null; name: string; mimetype: string | null } | undefined

    if (!row?.local_path) { res.status(404).send('File not found'); return }
    try {
      res.sendFile(row.local_path, {
        headers: { 'Content-Disposition': `inline; filename="${row.name}"` }
      })
    } catch {
      res.status(404).send('File missing from disk')
    }
  })

  exApp.get('/api/channels/:id/files', (req, res) => {
    const { id } = req.params
    if (fileListCache.has(id)) { res.json(fileListCache.get(id)); return }

    const rows = db.prepare(`
      SELECT f.id, f.name, f.title, f.mimetype, f.size,
             f.message_ts, f.local_path, f.user_id
      FROM files f WHERE f.channel_id = ?
      ORDER BY f.message_ts DESC
    `).all(id) as {
      id: string; name: string; title: string | null; mimetype: string | null
      size: number | null; message_ts: string | null; local_path: string | null; user_id: string | null
    }[]

    const result = rows.map((r) => ({
      id: r.id,
      name: r.name,
      title: r.title ?? r.name,
      mimetype: r.mimetype ?? '',
      size: r.size ?? 0,
      message_ts: r.message_ts,
      ts_display: r.message_ts ? formatTs(r.message_ts) : '',
      user_name: r.user_id ? userDisplay(r.user_id) : 'Unknown',
      downloaded: r.local_path !== null,
      url: r.local_path ? `/api/files/${r.id}` : null
    }))
    fileListCache.set(id, result)
    res.json(result)
  })

  exApp.get('/api/search', (req, res) => {
    const q = ((req.query.q as string) ?? '').trim()
    const userId = ((req.query.user_id as string) ?? '').trim()

    if (!q && !userId) { res.json([]); return }

    const seen = new Map<string, MsgRow>()

    if (userId) {
      const rows = db.prepare(`
        SELECT m.id, m.ts, m.channel_id, m.user_id, m.text,
               m.thread_ts, m.reply_count, m.reactions
        FROM messages m
        WHERE m.user_id = ?
          AND (m.thread_ts IS NULL OR m.thread_ts = m.ts)
        ORDER BY m.ts DESC LIMIT 100
      `).all(userId) as MsgRow[]
      for (const r of rows) seen.set(r.id as string, r)
    }

    if (q.length >= 2) {
      const fts = ftsQuery(q)
      const snippetMap = new Map<string, string>()

      if (fts) {
        try {
          const rows = db.prepare(`
            SELECT m.id, m.ts, m.channel_id, m.user_id, m.text,
                   m.thread_ts, m.reply_count, m.reactions,
                   snippet(messages_fts, 0, '\x01', '\x02', '…', 12) AS snip
            FROM messages_fts f
            JOIN messages m ON m.rowid = f.rowid
            WHERE f MATCH ?
            ORDER BY f.rank
            LIMIT 100
          `).all(fts) as (MsgRow & { snip?: string })[]
          for (const r of rows) {
            if (!seen.has(r.id as string)) seen.set(r.id as string, r)
            if (r.snip) snippetMap.set(r.id as string, r.snip as string)
          }
        } catch (e) {
          console.error('FTS error:', e)
        }
      }

      // LIKE fallback (only if FTS found nothing)
      if (!seen.size) {
        const like = `%${q}%`
        const rows = db.prepare(`
          SELECT m.id, m.ts, m.channel_id, m.user_id, m.text,
                 m.thread_ts, m.reply_count, m.reactions
          FROM messages m
          WHERE m.text LIKE ?
            AND (m.thread_ts IS NULL OR m.thread_ts = m.ts)
          ORDER BY m.ts DESC LIMIT 100
        `).all(like) as MsgRow[]
        for (const r of rows) if (!seen.has(r.id as string)) seen.set(r.id as string, r)
      }

      // User name match (always run, adds to results)
      const like = `%${q}%`
      const userRows = db.prepare(`
        SELECT m.id, m.ts, m.channel_id, m.user_id, m.text,
               m.thread_ts, m.reply_count, m.reactions
        FROM users u
        JOIN messages m ON m.user_id = u.id
        WHERE (u.real_name LIKE ? OR u.display_name LIKE ? OR u.name LIKE ?)
          AND (m.thread_ts IS NULL OR m.thread_ts = m.ts)
        ORDER BY m.ts DESC LIMIT 50
      `).all(like, like, like) as MsgRow[]
      for (const r of userRows) if (!seen.has(r.id as string)) seen.set(r.id as string, r)

      // Attach snippets to results
      for (const [id, snip] of snippetMap) {
        const r = seen.get(id)
        if (r) (r as MsgRow & { _snip?: string })._snip = snip
      }
    }

    const results = [...seen.values()]
      .sort((a, b) => parseFloat(b.ts as string) - parseFloat(a.ts as string))
      .slice(0, 100)

    res.json(results.map((r) => {
      const msg = serializeMessage(r, true) as Record<string, unknown>
      const snip = (r as MsgRow & { _snip?: string })._snip
      if (snip) {
        // \x01 = open highlight, \x02 = close highlight → convert to HTML
        msg.snippet = esc(snip)
          .replace(/\x01/g, '<mark>')
          .replace(/\x02/g, '</mark>')
      }
      return msg
    }))
  })

  // Cache management
  exApp.post('/api/cache/clear', (_req, res) => {
    loadCaches(db)   // reloads user/channel lookups + clears result caches
    res.json({ ok: true })
  })

  // Serve the viewer HTML
  exApp.get('/', (_req, res) => {
    const htmlPath = electronApp.isPackaged
      ? join(process.resourcesPath, 'viewer.html')
      : join(electronApp.getAppPath(), 'resources', 'viewer.html')
    res.sendFile(htmlPath)
  })

  return exApp
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let httpServer: Server | null = null
let currentDb: DB | null = null

export function startViewerServer(dbPath: string): Promise<number> {
  // If already running, refresh caches (extraction may have added data) and return port
  if (httpServer && currentDb) {
    loadCaches(currentDb)
    return Promise.resolve((httpServer.address() as AddressInfo).port)
  }

  return new Promise((resolve, reject) => {
    const db = new Database(dbPath)
    currentDb = db

    loadCaches(db)  // fast: just SELECTs users + channels into memory

    const expressApp = buildApp(db)
    httpServer = createServer(expressApp)

    httpServer.listen(0, '127.0.0.1', () => {
      const port = (httpServer!.address() as AddressInfo).port
      console.log(`Viewer server started on http://127.0.0.1:${port}`)
      resolve(port)  // return port immediately — FTS builds in background
      setImmediate(() => setupFts(db))  // non-blocking: search degrades gracefully until ready
    })

    httpServer.on('error', reject)
  })
}

export function stopViewerServer(): void {
  httpServer?.close()
  currentDb?.close()
  httpServer = null
  currentDb = null
}
