import { safeStorage, app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'

const CREDS_FILE = join(app.getPath('userData'), 'credentials.enc')

export interface StoredCredentials {
  token: string
  cookie: string
  workspaceName?: string
  workspaceDomain?: string
}

export function saveCredentials(creds: StoredCredentials): void {
  const json = JSON.stringify(creds)
  if (safeStorage.isEncryptionAvailable()) {
    // Encrypted via Windows DPAPI / macOS Keychain / Linux libsecret
    writeFileSync(CREDS_FILE, safeStorage.encryptString(json))
  } else {
    // safeStorage unavailable (e.g. headless CI) — store plain
    writeFileSync(CREDS_FILE, json, 'utf8')
  }
}

export function loadCredentials(): StoredCredentials | null {
  if (!existsSync(CREDS_FILE)) return null
  try {
    const data = readFileSync(CREDS_FILE)
    let json: string
    if (safeStorage.isEncryptionAvailable()) {
      json = safeStorage.decryptString(data)
    } else {
      json = data.toString('utf8')
    }
    return JSON.parse(json) as StoredCredentials
  } catch {
    return null
  }
}

export function clearCredentials(): void {
  if (!existsSync(CREDS_FILE)) return
  try {
    writeFileSync(CREDS_FILE, Buffer.alloc(256)) // overwrite before delete
    unlinkSync(CREDS_FILE)
  } catch {
    // ignore
  }
}
