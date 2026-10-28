import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handlePreToolUse, type PreToolUseInput } from '../src/hook.js'

let failures = 0
function ok(label: string, cond: boolean, detail = '') {
  if (!cond) {
    failures++
    console.log(`  FAIL  ${label} ${detail}`)
  } else {
    console.log(`  ok    ${label}`)
  }
}

async function runTests() {
  const root = await mkdtemp(join(tmpdir(), 'devtrace-ag-test-'))
  const devDir = join(root, '.devtrace')
  const pendingDir = join(devDir, 'pending')
  await mkdir(pendingDir, { recursive: true })

  const testFile = join(root, 'main.ts')
  await writeFile(testFile, 'const a = 1\nconst b = 2\nconst c = 3\n', 'utf8')

  console.log('1. replace_file_content staging')
  {
    const input: PreToolUseInput = {
      toolCall: {
        name: 'replace_file_content',
        args: {
          TargetFile: testFile,
          TargetContent: 'const b = 2',
          ReplacementContent: 'const b = 42',
          StartLine: 2,
          EndLine: 2,
        },
      },
      workspacePaths: [root],
    }

    const res = await handlePreToolUse(input, root)
    ok('decision is deny', res.decision === 'deny')
    ok('reason mentions DevTrace', typeof res.reason === 'string' && res.reason.includes('DevTrace'))

    const disk = await readFile(testFile, 'utf8')
    ok('disk is unchanged', disk === 'const a = 1\nconst b = 2\nconst c = 3\n')
  }

  console.log('\n2. coalescing consecutive edits to same file')
  {
    const input2: PreToolUseInput = {
      toolCall: {
        name: 'replace_file_content',
        args: {
          TargetFile: testFile,
          TargetContent: 'const c = 3',
          ReplacementContent: 'const c = 99',
          StartLine: 3,
          EndLine: 3,
        },
      },
      workspacePaths: [root],
    }

    const res2 = await handlePreToolUse(input2, root)
    ok('second edit also denied and staged', res2.decision === 'deny')

    const files = await (await import('node:fs/promises')).readdir(pendingDir)
    const jsonFile = files.find((x) => x.endsWith('.json'))!
    const pending = await readFile(join(pendingDir, jsonFile), 'utf8')
    const rec = JSON.parse(pending)
    ok('composed both edits in after', rec.after === 'const a = 1\nconst b = 42\nconst c = 99\n')
    ok('before is initial committed disk', rec.before === 'const a = 1\nconst b = 2\nconst c = 3\n')
  }

  console.log('\n3. multi_replace_file_content')
  {
    const file2 = join(root, 'multi.ts')
    await writeFile(file2, 'function foo() {\n  return "old"\n}\n', 'utf8')

    const inputMulti: PreToolUseInput = {
      toolCall: {
        name: 'multi_replace_file_content',
        args: {
          TargetFile: file2,
          ReplacementChunks: [
            {
              TargetContent: 'function foo() {',
              ReplacementContent: 'async function foo() {',
              StartLine: 1,
              EndLine: 1,
            },
            {
              TargetContent: 'return "old"',
              ReplacementContent: 'return "new"',
              StartLine: 2,
              EndLine: 2,
            },
          ],
        },
      },
      workspacePaths: [root],
    }

    const res = await handlePreToolUse(inputMulti, root)
    ok('multi_replace denied', res.decision === 'deny')
  }

  console.log('\n4. non-writing tools allowed')
  {
    const inputRun: PreToolUseInput = {
      toolCall: {
        name: 'run_command',
        args: { CommandLine: 'npm test' },
      },
      workspacePaths: [root],
    }
    const res = await handlePreToolUse(inputRun, root)
    ok('run_command is allowed', res.decision === 'allow')
  }

  console.log('\n5. disabled when .devtrace missing')
  {
    await rm(devDir, { recursive: true, force: true })
    const input: PreToolUseInput = {
      toolCall: {
        name: 'write_to_file',
        args: { TargetFile: testFile, CodeContent: 'new' },
      },
      workspacePaths: [root],
    }
    const res = await handlePreToolUse(input, root)
    ok('allowed when .devtrace is absent', res.decision === 'allow')
  }

  await rm(root, { recursive: true, force: true })

  if (failures > 0) {
    console.error(`\n${failures} tests failed.`)
    process.exit(1)
  } else {
    console.log('\nAll Antigravity hook tests passed.')
  }
}

runTests().catch((err) => {
  console.error(err)
  process.exit(1)
})
