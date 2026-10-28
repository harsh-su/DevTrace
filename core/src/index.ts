/**
 * @devtrace/core — the shared trace engine.
 *
 * Pure data, zero React, zero DOM, zero Node. The web app and the VS Code
 * extension both render this engine; a keystroke scored in the browser and one
 * scored in the editor must produce identical numbers.
 */
export * from './trace.js'
export * from './tokenize.js'
export * from './format.js'
export * from './diff.js'
export * from './tour.js'
export * from './syntax.js'
