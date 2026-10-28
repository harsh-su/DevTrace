const esbuild = require('esbuild')

const watch = process.argv.includes('--watch')

const extension = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  logLevel: 'info',
}

// The trace panel is a React app. It shares SourceView/Results and the core
// engine with the browser tracer, so it is bundled separately for the webview.
const webview = {
  entryPoints: ['src/webview/main.tsx'],
  bundle: true,
  outfile: 'dist/webview.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  minify: !watch,
  sourcemap: true,
  logLevel: 'info',
}

const flow = {
  entryPoints: ['src/webview/flow.tsx'],
  bundle: true,
  outfile: 'dist/flow.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  minify: !watch,
  sourcemap: true,
  logLevel: 'info',
}

async function main() {
  if (watch) {
    const [ext, web, flowBuild] = await Promise.all([esbuild.context(extension), esbuild.context(webview), esbuild.context(flow)])
    await Promise.all([ext.watch(), web.watch(), flowBuild.watch()])
  } else {
    await Promise.all([esbuild.build(extension), esbuild.build(webview), esbuild.build(flow)])
  }
}

main().catch(() => process.exit(1))
