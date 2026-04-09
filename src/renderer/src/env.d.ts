interface Window {
  api: {
    send: (channel: string, data?: unknown) => void
    invoke: (channel: string, data?: unknown) => Promise<unknown>
    on: (channel: string, callback: (...args: unknown[]) => void) => void
    off: (channel: string) => void
  }
}
