/**
 * download-worker.ts
 * Runs in a Node.js worker thread. Receives download options via workerData,
 * streams DownloadProgressEvents back to the main thread via parentPort.
 */

import { workerData, parentPort, isMainThread } from 'worker_threads'
import { runDownload, DownloadOptions, DownloadProgressEvent } from './downloader'

if (isMainThread) throw new Error('must run as worker')
if (!parentPort) throw new Error('no parentPort')

const options = workerData as DownloadOptions
let stopRequested = false

parentPort.on('message', (msg: string) => {
  if (msg === 'stop') stopRequested = true
})

function emit(event: DownloadProgressEvent): void {
  parentPort!.postMessage(event)
}

runDownload(options, emit, () => stopRequested).catch((err: Error) => {
  emit({ type: 'error', message: err.message })
})
