import { tokenizeLine } from '../src/syntax.js'

let failures = 0
function ok(label: string, cond: boolean): void {
  if (!cond) { failures++; console.log(`FAIL ${label}`) }
  else console.log(`ok ${label}`)
}

{
  const line = 'fn main() { // hi'
  const tags = tokenizeLine(line, 'main.rs')
  ok('rust fn keyword', tags[0] === 'k' && tags[1] === 'k')
  ok('rust function name', tags[3] === 'f' && tags[6] === 'f')
  ok('rust line comment', tags[12] === 'c' && tags[16] === 'c')
}

{
  const line = 'int main() { std::cout << "hi"; }'
  const tags = tokenizeLine(line, 'main.cpp')
  ok('cpp int keyword', tags[0] === 'k' && tags[2] === 'k')
  ok('cpp function name', tags[4] === 'f' && tags[7] === 'f')
  ok('cpp builtin', tags[13] === 'b' && tags[15] === 'b')
  const quote = line.indexOf('"')
  ok('cpp string', tags[quote] === 's' && tags[quote + 3] === 's')
}

{
  const tags = tokenizeLine('fn main() {}', 'notes.xyz')
  ok('unknown language has no tags', tags.every((t) => t === ''))
}

if (failures > 0) process.exit(1)
