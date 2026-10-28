/**
 * Lightweight, zero-dependency syntax tokenizer for code tracing.
 * Tags character ranges with semantic classes so typed code illuminates in
 * rich VS Code syntax colors while untyped code remains a faint ghost watermark.
 */

export type SyntaxKind =
  | 'k' // keyword (def, return, class, if, import, etc.)
  | 's' // string ("...", '...', `...`)
  | 'f' // function / method name
  | 'c' // comment (# ..., // ...)
  | 'n' // number (123, 0.5, 0x1f)
  | 'b' // boolean / builtin (True, False, None, self, this, null, true, false)
  | 't' // type / class (int, str, dict, Promise, etc.)
  | 'o' // operator / punctuation

const PYTHON_KEYWORDS = new Set([
  'def', 'return', 'class', 'import', 'from', 'if', 'elif', 'else', 'for', 'while',
  'in', 'is', 'not', 'and', 'or', 'try', 'except', 'finally', 'with', 'as', 'raise',
  'pass', 'break', 'continue', 'yield', 'lambda', 'global', 'nonlocal', 'assert',
  'async', 'await', 'match', 'case'
])

const JS_KEYWORDS = new Set([
  'function', 'return', 'class', 'import', 'export', 'from', 'default', 'if', 'else',
  'for', 'while', 'do', 'in', 'of', 'try', 'catch', 'finally', 'throw', 'new', 'delete',
  'typeof', 'instanceof', 'void', 'const', 'let', 'var', 'async', 'await', 'yield',
  'switch', 'case', 'break', 'continue', 'extends', 'implements', 'interface', 'type'
])

const BUILTINS = new Set([
  'True', 'False', 'None', 'self', 'cls', 'super', 'print', 'len', 'range', 'enumerate',
  'int', 'str', 'float', 'bool', 'list', 'dict', 'set', 'tuple',
  'true', 'false', 'null', 'undefined', 'this', 'console', 'window', 'document', 'process'
])

function resolveLang(lang?: string): 'py' | 'js' | null {
  if (!lang) return null
  const clean = lang.trim().toLowerCase()
  const base = clean.split(/[/\\]/).pop() ?? clean
  const ext = base.includes('.') ? base.split('.').pop() ?? '' : base
  if (['py', 'python', 'gyp'].includes(ext)) return 'py'
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'javascript', 'typescript'].includes(ext)) return 'js'
  return 'py'
}

/** Returns an array of syntax tags (one per character) for a line of code. */
export function tokenizeLine(line: string, lang?: string): string[] {
  const len = line.length
  const tags: string[] = new Array(len).fill('')
  if (len === 0 || !lang) return tags

  const targetLang = resolveLang(lang)
  if (!targetLang) return tags

  const isPy = targetLang === 'py'
  let i = 0

  while (i < len) {
    const ch = line[i]!

    // Comments
    if ((isPy && ch === '#') || (!isPy && ch === '/' && line[i + 1] === '/')) {
      for (let k = i; k < len; k++) tags[k] = 'c'
      break
    }

    // Strings
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      const isTriple = line.startsWith(quote + quote + quote, i)
      const endQuote = isTriple ? quote + quote + quote : quote
      const start = i
      i += isTriple ? 3 : 1
      while (i < len) {
        if (line[i] === '\\') {
          i += 2
          continue
        }
        if (line.startsWith(endQuote, i)) {
          i += endQuote.length
          break
        }
        i++
      }
      for (let k = start; k < Math.min(i, len); k++) tags[k] = 's'
      continue
    }

    // Numbers
    if (/\d/.test(ch) && (i === 0 || /[\s,([{:+\-*\/%=<>&|^~!]/.test(line[i - 1]!))) {
      const start = i
      while (i < len && /[0-9a-fA-FxX._]/.test(line[i]!)) i++
      for (let k = start; k < i; k++) tags[k] = 'n'
      continue
    }

    // Words / Identifiers
    if (/[a-zA-Z_]/.test(ch)) {
      const start = i
      while (i < len && /[a-zA-Z0-9_]/.test(line[i]!)) i++
      const word = line.slice(start, i)

      // Look ahead for function call: foo(
      let nextNonSpace = i
      while (nextNonSpace < len && line[nextNonSpace] === ' ') nextNonSpace++
      const isCall = line[nextNonSpace] === '('

      let tag = ''
      if (isPy ? PYTHON_KEYWORDS.has(word) : JS_KEYWORDS.has(word)) {
        tag = 'k'
      } else if (BUILTINS.has(word)) {
        tag = 'b'
      } else if (isCall) {
        tag = 'f'
      } else if (/^[A-Z][a-zA-Z0-9]*$/.test(word)) {
        tag = 't' // Class/Type Name
      }

      if (tag) {
        for (let k = start; k < i; k++) tags[k] = tag
      }
      continue
    }

    // Punctuation / Operators
    if (/[:=+\-*\/%<>!&|^~]/.test(ch)) {
      tags[i] = 'o'
    }

    i++
  }

  return tags
}
