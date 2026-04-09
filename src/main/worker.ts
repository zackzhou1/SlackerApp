/**
 * worker.ts
 * Runs in a Node.js worker thread. Receives extraction options via workerData,
 * streams ProgressEvents back to the main thread via parentPort.
 */

import { workerData, parentPort, isMainThread } from 'worker_threads'
import { runExtraction, ExtractionOptions, ProgressEvent } from './extractor'

if (isMainThread) throw new Error('worker.ts must run as a worker thread')
if (!parentPort) throw new Error('No parentPort available')

const options = workerData as ExtractionOptions
let stopRequested = false

// Listen for stop signal from main thread
parentPort.on('message', (msg: string) => {
  if (msg === 'stop') stopRequested = true
})

function emit(event: ProgressEvent): void {
  parentPort!.postMessage(event)
}

runExtraction(options, emit, () => stopRequested)
  .catch((err: Error) => {
    emit({ type: 'error', message: err.message })
  })
