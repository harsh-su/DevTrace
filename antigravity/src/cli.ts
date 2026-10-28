#!/usr/bin/env node
import { handlePreToolUse, type PreToolUseInput } from './hook.js'

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

async function main() {
  let input: PreToolUseInput = {}
  try {
    const raw = await readStdin()
    if (raw.trim()) {
      input = JSON.parse(raw) as PreToolUseInput
    }
  } catch (err) {
    // If parse error, allow tool execution to prevent hard failure
    process.stdout.write(JSON.stringify({ decision: 'allow' }))
    return
  }

  try {
    const result = await handlePreToolUse(input)
    process.stdout.write(JSON.stringify(result))
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        decision: 'allow',
        reason: `DevTrace hook error: ${(err as Error).message}`,
      }),
    )
  }
}

main()
