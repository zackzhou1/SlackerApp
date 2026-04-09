import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { Worker } from 'worker_threads'
import { openAuthWindow } from './auth'
import { saveCredentials, loadCredentials, clearCredentials } from './credentials'
import { startViewerServer, stopViewerServer } from './server'

let mainWindow: BrowserWindow | null = null
let extractWorker: Worker | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'Slacker',
    backgroundColor: '#1a1d21',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow!.show())
  mainWindow.on('closed', () => { mainWindow = null })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function getDbPath(): string {
  return join(app.getPath('userData'), 'slack.db')
}

app.whenReady().then(() => {
  createWindow()
  registerIpc()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => stopViewerServer())

// ── IPC handlers ──────────────────────────────────────────────────────────────

function registerIpc(): void {
  // Auth -----------------------------------------------------------------------

  ipcMain.handle('auth:check', () => {
    const creds = loadCredentials()
    if (!creds) return { connected: false }
    return { connected: true, workspaceName: creds.workspaceName, workspaceDomain: creds.workspaceDomain }
  })

  ipcMain.handle('auth:connect', async () => {
    const result = await openAuthWindow()
    if (!result) return { success: false, reason: 'cancelled' }
    saveCredentials({ token: result.token, cookie: result.cookie })
    return { success: true }
  })

  ipcMain.handle('auth:disconnect', () => {
    clearCredentials()
    return { success: true }
  })

  // Extract --------------------------------------------------------------------

  ipcMain.handle('extract:start', (_event, opts: { channels?: string[]; noDms?: boolean } = {}) => {
    if (extractWorker) return { error: 'Already running' }

    const creds = loadCredentials()
    if (!creds) return { error: 'No credentials saved. Connect to Slack first.' }

    const dbPath = getDbPath()

    extractWorker = new Worker(join(__dirname, 'worker.js'), {
      workerData: {
        token: creds.token,
        cookie: creds.cookie,
        dbPath,
        channels: opts.channels,
        noDms: opts.noDms ?? false
      }
    })

    extractWorker.on('message', (event) => {
      mainWindow?.webContents.send('extract:progress', event)
    })

    extractWorker.on('error', (err) => {
      mainWindow?.webContents.send('extract:progress', { type: 'error', message: err.message })
      extractWorker = null
    })

    extractWorker.on('exit', () => {
      extractWorker = null
    })

    return { started: true, dbPath }
  })

  ipcMain.handle('extract:stop', () => {
    extractWorker?.postMessage('stop')
    return { ok: true }
  })

  // Viewer --------------------------------------------------------------------

  ipcMain.handle('viewer:open', async () => {
    const dbPath = getDbPath()
    const port = await startViewerServer(dbPath)

    const viewer = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 900,
      minHeight: 600,
      autoHideMenuBar: true,
      title: 'Slacker — Messages',
      backgroundColor: '#222529'
    })

    viewer.loadURL(`http://127.0.0.1:${port}`)
    return { ok: true }
  })
}
