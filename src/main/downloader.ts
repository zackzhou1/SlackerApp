/**
 * downloader.ts
 * TypeScript port of download_files.py.
 * Runs inside a worker thread — call runDownload() with a progress callback.
 */

import Database, { Database as DB } from 'better-sqlite3'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

// ── Types ────────────────────────────────────────────────────────────────────

export interface DownloadOptions {
  token: string
  cookie: string
  dbPath: string
  downloadsDir: string
  channelFilter?: string  // optional channel name filter
}

export type DownloadProgressEvent =
  | { type: 'scan-done'; total: number; pending: number }
  | { type: 'file-start'; name: string; index: number; total: number; channel: string }
  | { type: 'file-done'; name: string; index: number; total: number }
  | { type: 'file-skip'; name: string; reason: string }
  | { type: 'file-fail'; name: string; error: string }
  | { type: 'done'; downloaded: number; skipped: number; failed: number }
  | { type: 'stopped' }
  | { type: 'error'; message: string }

// ── Constants ────────────────────────────────────────────────────────────────

const REQUEST_DELAY = 500 // ms between downloads

const SKIP_MIMETYPES = new Set([
  'application/vnd.slack-docs', // Slack posts — no binary to download
])

// ── Helpers ───────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function safeFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._\- ]/g, '').trim()
  return cleaned || 'file'
}

// ── Database ──────────────────────────────────────────────────────────────────

function openDb(dbPath: string): DB {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY, name TEXT, title TEXT, mimetype TEXT,
      filetype TEXT, size INTEGER, channel_id TEXT, message_ts TEXT,
      user_id TEXT, local_path TEXT, downloaded_at TEXT,
      url_private TEXT, raw JSON
    );
    CREATE INDEX IF NOT EXISTS idx_files_channel ON files(channel_id);
    CREATE INDEX IF NOT EXISTS idx_files_message  ON files(message_ts);
  `)
  return db
}

interface Attachment {
  fileId: string
  name: string
  title: string
  mimetype: string
  filetype: string
  size: number
  channelId: string
  channelName: string
  messageTs: string
  userId: string
  urlPrivate: string
  raw: unknown
}

function scanMessages(db: DB, channelFilter?: string): Attachment[] {
  let query = `
    SELECT m.ts, m.channel_id, m.user_id, m.files,
           c.name as channel_name
    FROM messages m
    LEFT JOIN channels c ON c.id = m.channel_id
    WHERE m.files IS NOT NULL AND m.files != '[]'
  `
  const params: string[] = []

  if (channelFilter) {
    query += ' AND c.name = ?'
    params.push(channelFilter)
  }

  const rows = db.prepare(query).all(...params) as Array<{
    ts: string
    channel_id: string
    user_id: string
    files: string
    channel_name: string | null
  }>

  const attachments: Attachment[] = []

  for (const row of rows) {
    let files: Record<string, unknown>[]
    try {
      files = JSON.parse(row.files || '[]') as Record<string, unknown>[]
    } catch {
      continue
    }

    for (const f of files) {
      if (!f['id']) continue
      attachments.push({
        fileId: f['id'] as string,
        name: (f['name'] as string) || 'unknown',
        title: (f['title'] as string) || '',
        mimetype: (f['mimetype'] as string) || '',
        filetype: (f['filetype'] as string) || '',
        size: (f['size'] as number) || 0,
        channelId: row.channel_id,
        channelName: row.channel_name || row.channel_id,
        messageTs: row.ts,
        userId: row.user_id,
        urlPrivate: (f['url_private_download'] as string) || (f['url_private'] as string) || '',
        raw: f,
      })
    }
  }

  return attachments
}

function isAlreadyDownloaded(db: DB, fileId: string, downloadsDir: string): boolean {
  const row = db.prepare(
    'SELECT local_path FROM files WHERE id = ? AND downloaded_at IS NOT NULL'
  ).get(fileId) as { local_path: string | null } | undefined

  if (!row) return false
  if (!row.local_path) return false
  return existsSync(row.local_path)
}

function upsertFile(
  db: DB,
  a: Attachment,
  localPath: string | null,
  downloadedAt: string
): void {
  db.prepare(`
    INSERT OR REPLACE INTO files
      (id, name, title, mimetype, filetype, size, channel_id,
       message_ts, user_id, local_path, downloaded_at, url_private, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    a.fileId, a.name, a.title, a.mimetype, a.filetype, a.size,
    a.channelId, a.messageTs, a.userId,
    localPath, downloadedAt, a.urlPrivate, JSON.stringify(a.raw)
  )
}

// ── Download ──────────────────────────────────────────────────────────────────

async function fetchFile(
  url: string,
  token: string,
  cookie: string,
  shouldStop: () => boolean
): Promise<Buffer> {
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Cookie: `d=${cookie}`,
    },
  })

  if (resp.status === 429) {
    const retryAfter = parseInt(resp.headers.get('Retry-After') ?? '30', 10)
    // Interruptible wait on rate limit
    const step = 100
    let elapsed = 0
    const waitMs = retryAfter * 1000
    while (elapsed < waitMs && !shouldStop()) {
      await delay(Math.min(step, waitMs - elapsed))
      elapsed += step
    }
    if (shouldStop()) throw new Error('stopped')
    return fetchFile(url, token, cookie, shouldStop)
  }

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)

  const arrayBuf = await resp.arrayBuffer()
  return Buffer.from(arrayBuf)
}

// ── Main entry ────────────────────────────────────────────────────────────────

export async function runDownload(
  options: DownloadOptions,
  emit: (event: DownloadProgressEvent) => void,
  shouldStop: () => boolean
): Promise<void> {
  const db = openDb(options.dbPath)

  try {
    // 1. Scan messages for file attachments
    const allAttachments = scanMessages(db, options.channelFilter)

    // Deduplicate by file_id (same file can appear in multiple messages)
    const seen = new Map<string, Attachment>()
    for (const a of allAttachments) {
      if (!seen.has(a.fileId)) seen.set(a.fileId, a)
    }
    const deduplicated = Array.from(seen.values())

    const pending = deduplicated.filter(
      (a) => !isAlreadyDownloaded(db, a.fileId, options.downloadsDir)
    )

    emit({ type: 'scan-done', total: deduplicated.length, pending: pending.length })

    let downloaded = 0
    let skipped = 0
    let failed = 0
    const total = pending.length

    // 2. Download each pending file
    for (let i = 0; i < pending.length; i++) {
      if (shouldStop()) {
        emit({ type: 'stopped' })
        return
      }

      const a = pending[i]
      const safeName = safeFilename(a.name)

      emit({
        type: 'file-start',
        name: safeName,
        index: i + 1,
        total,
        channel: a.channelName,
      })

      // Skip files with no downloadable binary
      if (!a.urlPrivate || SKIP_MIMETYPES.has(a.mimetype)) {
        const reason = !a.urlPrivate ? 'no url_private' : 'skipped mimetype'
        upsertFile(db, a, null, new Date().toISOString())
        emit({ type: 'file-skip', name: safeName, reason })
        skipped++
        continue
      }

      const destDir = join(options.downloadsDir, a.fileId)
      const destPath = join(destDir, safeName)

      try {
        const buf = await fetchFile(a.urlPrivate, options.token, options.cookie, shouldStop)

        mkdirSync(destDir, { recursive: true })
        writeFileSync(destPath, buf)

        upsertFile(db, a, destPath, new Date().toISOString())
        emit({ type: 'file-done', name: safeName, index: i + 1, total })
        downloaded++
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        emit({ type: 'file-fail', name: safeName, error: message })
        failed++
      }

      // Rate limit: 500ms between downloads
      if (i < pending.length - 1 && !shouldStop()) {
        await delay(REQUEST_DELAY)
      }
    }

    emit({ type: 'done', downloaded, skipped, failed })
  } finally {
    db.close()
  }
}
