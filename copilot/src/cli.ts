#!/usr/bin/env node
import { handleHook, type HookInput } from './hook.js'

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', (err) => reject(err))
  })
}

async function main(): Promise<void> {
  let input: HookInput = {}
  try {
    const raw = await readStdin()
    if (raw.trim()) input = JSON.parse(raw) as HookInput
  } catch {
    // No decision: Copilot keeps its normal permission flow.
    process.stdout.write('{}')
    return
  }

  try {
    const result = await handleHook(input)
    process.stdout.write(JSON.stringify(result))
  } catch {
    // A hook crash should not block every file edit.
    process.stdout.write('{}')
  }
}

void main()
