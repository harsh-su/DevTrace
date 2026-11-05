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

const RUST_KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum',
  'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod',
  'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super',
  'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while', 'yield', 'union'
])

const CPP_KEYWORDS = new Set([
  'alignas', 'alignof', 'auto', 'bool', 'break', 'case', 'catch', 'char', 'class',
  'const', 'constexpr', 'continue', 'default', 'delete', 'do', 'double', 'else',
  'enum', 'explicit', 'export', 'extern', 'false', 'float', 'for', 'friend', 'goto',
  'if', 'inline', 'int', 'long', 'mutable', 'namespace', 'new', 'noexcept', 'nullptr',
  'operator', 'private', 'protected', 'public', 'return', 'short', 'signed', 'sizeof',
  'static', 'struct', 'switch', 'template', 'this', 'throw', 'true', 'try', 'typedef',
  'typename', 'union', 'unsigned', 'using', 'virtual', 'void', 'volatile', 'while'
])

const BUILTINS = new Set([
  'True', 'False', 'None', 'self', 'cls', 'super', 'print', 'len', 'range', 'enumerate',
  'int', 'str', 'float', 'bool', 'list', 'dict', 'set', 'tuple',
  'true', 'false', 'null', 'undefined', 'this', 'console', 'window', 'document', 'process',
  'String', 'Vec', 'Option', 'Result', 'Box', 'std', 'cout', 'cin', 'cerr', 'endl', 'printf'
])

type TokenLang = 'py' | 'js' | 'rust' | 'cpp' | null

function resolveLang(lang?: string): TokenLang {
  if (!lang) return null
  const clean = lang.trim().toLowerCase()
  const base = clean.split(/[/\\]/).pop() ?? clean
  const ext = base.includes('.') ? base.split('.').pop() ?? '' : ''
  const token = ext || base
  if (['py', 'python', 'gyp'].includes(token)) return 'py'
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'javascript', 'typescript'].includes(token)) return 'js'
  if (['rs', 'rust'].includes(token)) return 'rust'
  if (['c', 'h', 'cc', 'cpp', 'cxx', 'c++', 'hpp', 'hh', 'hxx'].includes(token)) return 'cpp'
  return null
}

/** Returns an array of syntax tags (one per character) for a line of code. */
export function tokenizeLine(line: string, lang?: string): string[] {
  const len = line.length
  const tags: string[] = new Array(len).fill('')
  if (len === 0 || !lang) return tags

  const targetLang = resolveLang(lang)
  if (!targetLang) return tags

  const isPy = targetLang === 'py'
  const isSlash = targetLang === 'js' || targetLang === 'rust' || targetLang === 'cpp'
  const keywords =
    targetLang === 'py'
      ? PYTHON_KEYWORDS
      : targetLang === 'js'
        ? JS_KEYWORDS
        : targetLang === 'rust'
          ? RUST_KEYWORDS
          : CPP_KEYWORDS
  let i = 0

  while (i < len) {
    const ch = line[i]!

    // Comments
    if ((isPy && ch === '#') || (isSlash && ch === '/' && line[i + 1] === '/')) {
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
      if (keywords.has(word)) {
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
