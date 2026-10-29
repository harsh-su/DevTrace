// Copies plugin sources into the extension assets so they can be
// shipped in the VSIX and installed with one command.
const { copyFileSync, mkdirSync, existsSync } = require('node:fs')
const { join, dirname } = require('node:path')

const assetsDir = join(__dirname, '..', 'assets')
mkdirSync(assetsDir, { recursive: true })

// 1. OpenCode plugin
const openCodeSrc = join(__dirname, '..', '..', 'opencode-plugin', 'src', 'index.ts')
const openCodeDest = join(assetsDir, 'opencode-plugin.ts')
if (existsSync(openCodeSrc)) {
  copyFileSync(openCodeSrc, openCodeDest)
  console.log(`[copy-plugin] ${openCodeSrc} -> ${openCodeDest}`)
}

// 2. Antigravity hook
const agSrc = join(__dirname, '..', '..', 'antigravity', 'dist', 'devtrace-hook.mjs')
const agDest = join(assetsDir, 'antigravity-devtrace.mjs')
if (existsSync(agSrc)) {
  copyFileSync(agSrc, agDest)
  console.log(`[copy-plugin] ${agSrc} -> ${agDest}`)
}
