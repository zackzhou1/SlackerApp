import { BrowserWindow, session as electronSession } from 'electron'

export interface SlackCredentials {
  token: string
  cookie: string
}

export async function openAuthWindow(): Promise<SlackCredentials | null> {
  const authSession = electronSession.fromPartition('persist:slack-auth')

  const win = new BrowserWindow({
    width: 960,
    height: 720,
    show: true,
    autoHideMenuBar: true,
    title: 'Sign in to Slack — Slacker',
    webPreferences: {
      session: authSession,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  return new Promise((resolve) => {
    let settled = false

    function settle(result: SlackCredentials | null): void {
      if (settled) return
      settled = true
      if (!win.isDestroyed()) win.close()
      resolve(result)
    }

    async function tryExtract(): Promise<boolean> {
      try {
        const token: string | null = await win.webContents.executeJavaScript(`
          (() => {
            try {
              const cfg = JSON.parse(localStorage.getItem('localConfig_v2') || '{}');
              const teams = cfg.teams || {};
              // Try every team entry — pick the first valid xoxc- token
              for (const team of Object.values(teams)) {
                const tok = team.token;
                if (typeof tok === 'string' && tok.startsWith('xoxc-')) return tok;
              }
              return null;
            } catch (e) { return null; }
          })()
        `)

        if (!token) return false

        // The 'd' cookie is set on .slack.com — try both domains
        let cookie: string | undefined
        for (const url of ['https://app.slack.com', 'https://slack.com']) {
          const cookies = await authSession.cookies.get({ url, name: 'd' })
          cookie = cookies[0]?.value
          if (cookie) break
        }
        if (!cookie) return false

        settle({ token, cookie })
        return true
      } catch {
        return false
      }
    }

    async function pollExtract(retries = 12, interval = 500): Promise<void> {
      for (let i = 0; i < retries; i++) {
        const ok = await tryExtract()
        if (ok) return
        await delay(interval)
      }
    }

    // Slack uses SPA navigation — watch both full navigations and in-page pushState
    win.webContents.on('did-navigate', async (_event, url) => {
      if (/app\.slack\.com/.test(url)) await pollExtract()
    })

    win.webContents.on('did-navigate-in-page', async (_event, url) => {
      if (/app\.slack\.com/.test(url)) await pollExtract(6, 400)
    })

    win.webContents.on('did-finish-load', async () => {
      if (/app\.slack\.com/.test(win.webContents.getURL())) await pollExtract(6, 400)
    })

    win.on('closed', () => settle(null))

    win.loadURL('https://app.slack.com')
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
