/**
 * extractor.ts
 * TypeScript port of slack_extract.py.
 * Runs inside a worker thread — call runExtraction() with a progress callback.
 */

import Database, { Database as DB } from 'better-sqlite3'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ExtractionOptions {
  token: string
  cookie: string
  dbPath: string
  channels?: string[]   // channel names or IDs to filter to
  noDms?: boolean
}

export type ProgressEvent =
  | { type: 'workspace'; name: string; domain: string }
  | { type: 'users'; count: number }
  | { type: 'channels'; count: number }
  | { type: 'channel-start'; name: string; index: number; total: number; resuming: boolean }
  | { type: 'channel-progress'; name: string; messages: number }
  | { type: 'channel-done'; name: string; messages: number }
  | { type: 'channel-skip'; name: string; reason: string }
  | { type: 'done'; stats: { users: number; channels: number; messages: number } }
  | { type: 'stopped' }
  | { type: 'error'; message: string }

// Thrown internally when shouldStop() becomes true inside the client
class StopError extends Error { constructor() { super('stopped') } }

// ── Slack HTTP client ────────────────────────────────────────────────────────

const REQUEST_DELAY = 1100 // ms — safe for all Slack API tiers

// Interruptible delay — wakes every 100ms to check shouldStop
async function interruptibleDelay(ms: number, shouldStop: () => boolean): Promise<void> {
  const step = 100
  let elapsed = 0
  while (elapsed < ms && !shouldStop()) {
    await delay(Math.min(step, ms - elapsed))
    elapsed += step
  }
}

class SlackClient {
  constructor(
    private token: string,
    private cookie: string,
    private shouldStop: () => boolean = () => false
  ) {}

  async call(
    method: string,
    params: Record<string, string | number | boolean> = {},
    skipDelay = false
  ): Promise<Record<string, unknown>> {
    if (!skipDelay) await interruptibleDelay(REQUEST_DELAY, this.shouldStop)
    if (this.shouldStop()) throw new StopError()

    const body = new URLSearchParams({ token: this.token })
    for (const [k, v] of Object.entries(params)) body.set(k, String(v))

    const resp = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `d=${this.cookie}`
      },
      body: body.toString()
    })

    if (resp.status === 429) {
      const wait = parseInt(resp.headers.get('Retry-After') ?? '30')
      await interruptibleDelay(wait * 1000, this.shouldStop)
      return this.call(method, params, true)
    }

    if (!resp.ok) throw new Error(`HTTP ${resp.status} on ${method}`)

    const data = (await resp.json()) as Record<string, unknown>
    if (!data.ok) throw new Error(`Slack API error on ${method}: ${data.error}`)
    return data
  }

  async *paginate(
    method: string,
    resultKey: string,
    params: Record<string, string | number | boolean> = {}
  ): AsyncGenerator<Record<string, unknown>> {
    let cursor: string | undefined
    while (true) {
      const data = await this.call(method, cursor ? { ...params, cursor } : params)
      for (const item of (data[resultKey] as Record<string, unknown>[])) yield item
      cursor = (data.response_metadata as Record<string, string> | undefined)?.next_cursor
      if (!cursor) break
    }
  }
}

// ── Database ─────────────────────────────────────────────────────────────────

function initDb(dbPath: string): DB {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, name TEXT, domain TEXT, raw JSON
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT, real_name TEXT, display_name TEXT,
      email TEXT, is_bot INTEGER, deleted INTEGER, raw JSON
    );
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY, name TEXT,
      type TEXT,           -- 'channel','group','im','mpim'
      is_private INTEGER, is_archived INTEGER, member_count INTEGER,
      topic TEXT, purpose TEXT, members JSON,
      fetched_at TEXT,     -- NULL = incomplete, ISO = done
      resume_cursor TEXT,
      raw JSON
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT, ts TEXT, user_id TEXT, text TEXT, thread_ts TEXT,
      reply_count INTEGER, reactions JSON, files JSON, raw JSON,
      FOREIGN KEY (channel_id) REFERENCES channels(id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
    CREATE INDEX IF NOT EXISTS idx_messages_ts      ON messages(ts);
    CREATE INDEX IF NOT EXISTS idx_messages_thread  ON messages(thread_ts);
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY, name TEXT, title TEXT, mimetype TEXT,
      filetype TEXT, size INTEGER, channel_id TEXT, message_ts TEXT,
      user_id TEXT, local_path TEXT, downloaded_at TEXT,
      url_private TEXT, raw JSON
    );
    CREATE INDEX IF NOT EXISTS idx_files_channel ON files(channel_id);
    CREATE INDEX IF NOT EXISTS idx_files_message  ON files(message_ts);
  `)

  // migrate old column name if needed
  const cols = (db.prepare('PRAGMA table_info(channels)').all() as { name: string }[])
    .map((r) => r.name)
  if (cols.includes('last_fetched_ts') && !cols.includes('fetched_at')) {
    db.exec('ALTER TABLE channels RENAME COLUMN last_fetched_ts TO fetched_at')
  }
  if (!cols.includes('resume_cursor')) {
    db.exec('ALTER TABLE channels ADD COLUMN resume_cursor TEXT')
  }

  return db
}

// ── Extraction steps ─────────────────────────────────────────────────────────

async function fetchWorkspace(
  client: SlackClient,
  db: DB
): Promise<{ teamId: string; userId: string; name: string; domain: string }> {
  const auth = await client.call('auth.test', {}, true)
  const teamId = auth.team_id as string

  const teamData = await client.call('team.info')
  const team = teamData.team as Record<string, string>

  db.prepare(`
    INSERT OR REPLACE INTO workspaces (id, name, domain, raw) VALUES (?, ?, ?, ?)
  `).run(teamId, team.name, team.domain, JSON.stringify(team))

  return { teamId, userId: auth.user_id as string, name: team.name, domain: team.domain }
}

async function fetchUsers(client: SlackClient, db: DB): Promise<number> {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO users
      (id, name, real_name, display_name, email, is_bot, deleted, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)

  let count = 0
  for await (const user of client.paginate('users.list', 'members', { limit: 200 })) {
    const u = user as Record<string, unknown>
    const profile = (u.profile as Record<string, string>) ?? {}
    insert.run(
      u.id, u.name, u.real_name,
      profile.display_name, profile.email,
      u.is_bot ? 1 : 0, u.deleted ? 1 : 0,
      JSON.stringify(u)
    )
    count++
  }

  return count
}

async function fetchChannels(client: SlackClient, db: DB): Promise<number> {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO channels
      (id, name, type, is_private, is_archived, member_count,
       topic, purpose, members, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  let count = 0
  for await (const ch of client.paginate(
    'conversations.list', 'channels',
    { types: 'public_channel,private_channel,im,mpim', exclude_archived: false, limit: 200 }
  )) {
    const c = ch as Record<string, unknown>
    const chType = c.is_im ? 'im' : c.is_mpim ? 'mpim' : c.is_private ? 'group' : 'channel'
    const members = chType === 'im' && c.user ? [c.user] : (c.members ?? [])

    insert.run(
      c.id,
      (c.name as string) || (c.user as string) || `DM-${c.id}`,
      chType,
      (c.is_private || c.is_im) ? 1 : 0,
      c.is_archived ? 1 : 0,
      c.num_members ?? 0,
      (c.topic as Record<string, string>)?.value ?? '',
      (c.purpose as Record<string, string>)?.value ?? '',
      JSON.stringify(members),
      JSON.stringify(c)
    )
    count++
  }

  return count
}

function saveMessage(
  db: DB,
  stmt: ReturnType<DB['prepare']>,
  chId: string,
  msg: Record<string, unknown>
): void {
  stmt.run(
    `${chId}:${msg.ts}`, chId, msg.ts,
    (msg.user as string) ?? (msg.bot_id as string) ?? null,
    (msg.text as string) ?? '',
    msg.thread_ts ?? null,
    msg.reply_count ?? 0,
    JSON.stringify(msg.reactions ?? []),
    JSON.stringify(msg.files ?? []),
    JSON.stringify(msg)
  )
}

async function fetchThread(
  client: SlackClient,
  db: DB,
  insertStmt: ReturnType<DB['prepare']>,
  chId: string,
  threadTs: string
): Promise<void> {
  try {
    for await (const msg of client.paginate(
      'conversations.replies', 'messages',
      { channel: chId, ts: threadTs, limit: 200 }
    )) {
      const m = msg as Record<string, unknown>
      if (m.ts === threadTs) continue // parent already saved
      saveMessage(db, insertStmt, chId, m)
    }
  } catch {
    // thread may be inaccessible
  }
}

async function fetchMessages(
  client: SlackClient,
  db: DB,
  options: { onlyChannels?: string[]; includeDms: boolean },
  emit: (e: ProgressEvent) => void,
  shouldStop: () => boolean
): Promise<void> {
  type ChannelRow = {
    id: string; name: string; type: string
    fetched_at: string | null; resume_cursor: string | null
  }

  let channels = db.prepare(
    'SELECT id, name, type, fetched_at, resume_cursor FROM channels'
  ).all() as ChannelRow[]

  if (options.onlyChannels?.length) {
    const only = new Set(options.onlyChannels)
    channels = channels.filter(
      (c) =>
        only.has(c.id) ||
        only.has(c.name) ||
        (options.includeDms && (c.type === 'im' || c.type === 'mpim'))
    )
  }

  const insertMsg = db.prepare(`
    INSERT OR REPLACE INTO messages
      (id, channel_id, ts, user_id, text, thread_ts,
       reply_count, reactions, files, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const total = channels.length

  for (let i = 0; i < channels.length; i++) {
    if (shouldStop()) break

    const ch = channels[i]
    const display = ch.name || ch.id

    // ── Already fully fetched → incremental update ──
    if (ch.fetched_at) {
      const newest = (
        db.prepare('SELECT MAX(ts) as ts FROM messages WHERE channel_id = ?').get(ch.id) as
          { ts: string | null }
      ).ts

      if (!newest) {
        emit({ type: 'channel-skip', name: display, reason: 'no baseline ts' })
        continue
      }

      emit({ type: 'channel-start', name: display, index: i + 1, total, resuming: false })

      let newCount = 0
      try {
        const data = await client.call('conversations.history', {
          channel: ch.id, oldest: newest, limit: 200
        })
        const msgs = ((data.messages as Record<string, unknown>[]) ?? [])
          .filter((m) => m.ts !== newest)

        if (!msgs.length) {
          db.prepare('UPDATE channels SET fetched_at = ? WHERE id = ?')
            .run(new Date().toISOString(), ch.id)
          continue
        }

        for (const msg of msgs) {
          if (shouldStop()) break
          saveMessage(db, insertMsg, ch.id, msg)
          newCount++
          if ((msg.reply_count as number) > 0 && msg.thread_ts === msg.ts) {
            await fetchThread(client, db, insertMsg, ch.id, msg.ts as string)
          }
        }

        let cursor = (
          data.response_metadata as Record<string, string> | undefined
        )?.next_cursor
        while (cursor && !shouldStop()) {
          const page = await client.call('conversations.history', {
            channel: ch.id, oldest: newest, cursor, limit: 200
          })
          for (const msg of (page.messages as Record<string, unknown>[]) ?? []) {
            if (shouldStop()) break
            saveMessage(db, insertMsg, ch.id, msg)
            newCount++
            if ((msg.reply_count as number) > 0 && msg.thread_ts === msg.ts) {
              await fetchThread(client, db, insertMsg, ch.id, msg.ts as string)
            }
          }
          cursor = (
            page.response_metadata as Record<string, string> | undefined
          )?.next_cursor
        }

        db.prepare('UPDATE channels SET fetched_at = ? WHERE id = ?')
          .run(new Date().toISOString(), ch.id)
        emit({ type: 'channel-done', name: display, messages: newCount })
      } catch (e) {
        emit({ type: 'channel-skip', name: display, reason: String(e) })
      }
      continue
    }

    // ── Full fetch (with resume support) ──
    emit({
      type: 'channel-start', name: display, index: i + 1, total,
      resuming: ch.resume_cursor !== null
    })

    let msgCount = (
      db.prepare('SELECT COUNT(*) as n FROM messages WHERE channel_id = ?').get(ch.id) as
        { n: number }
    ).n

    try {
      let cursor: string | undefined = ch.resume_cursor ?? undefined

      while (!shouldStop()) {
        const params: Record<string, string | number> = { channel: ch.id, limit: 200 }
        if (cursor) params.cursor = cursor

        const data = await client.call('conversations.history', params)
        const msgs = (data.messages as Record<string, unknown>[]) ?? []

        for (const msg of msgs) {
          if (shouldStop()) break
          saveMessage(db, insertMsg, ch.id, msg)
          msgCount++
          if ((msg.reply_count as number) > 0 && msg.thread_ts === msg.ts) {
            await fetchThread(client, db, insertMsg, ch.id, msg.ts as string)
          }
        }

        emit({ type: 'channel-progress', name: display, messages: msgCount })

        cursor = (
          data.response_metadata as Record<string, string> | undefined
        )?.next_cursor

        db.prepare('UPDATE channels SET resume_cursor = ? WHERE id = ?')
          .run(cursor ?? null, ch.id)

        if (!cursor) break
      }

      if (!shouldStop()) {
        db.prepare('UPDATE channels SET fetched_at = ?, resume_cursor = NULL WHERE id = ?')
          .run(new Date().toISOString(), ch.id)
        emit({ type: 'channel-done', name: display, messages: msgCount })
      }
    } catch (e) {
      emit({ type: 'channel-skip', name: display, reason: String(e) })
    }
  }
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function runExtraction(
  options: ExtractionOptions,
  emit: (e: ProgressEvent) => void,
  shouldStop: () => boolean
): Promise<void> {
  const db = initDb(options.dbPath)

  try {
    const client = new SlackClient(options.token, options.cookie, shouldStop)

    // 1. Workspace
    const ws = await fetchWorkspace(client, db)
    emit({ type: 'workspace', name: ws.name, domain: ws.domain })

    if (shouldStop()) { emit({ type: 'stopped' }); return }

    // 2. Users
    const userCount = await fetchUsers(client, db)
    emit({ type: 'users', count: userCount })

    if (shouldStop()) { emit({ type: 'stopped' }); return }

    // 3. Channels
    const channelCount = await fetchChannels(client, db)
    emit({ type: 'channels', count: channelCount })

    if (shouldStop()) { emit({ type: 'stopped' }); return }

    // 4. Messages
    await fetchMessages(
      client, db,
      { onlyChannels: options.channels, includeDms: !options.noDms },
      emit, shouldStop
    )

    if (shouldStop()) { emit({ type: 'stopped' }); return }

    // 5. Summary
    const stats = {
      users: (db.prepare('SELECT COUNT(*) as n FROM users').get() as { n: number }).n,
      channels: (db.prepare('SELECT COUNT(*) as n FROM channels').get() as { n: number }).n,
      messages: (db.prepare('SELECT COUNT(*) as n FROM messages').get() as { n: number }).n
    }
    emit({ type: 'done', stats })
  } catch (e) {
    if (e instanceof StopError) {
      emit({ type: 'stopped' })
    } else {
      throw e
    }
  } finally {
    db.close()
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
