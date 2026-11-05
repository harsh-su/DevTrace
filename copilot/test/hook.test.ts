import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleHook, type StagedRecord } from '../src/hook.js'

let failures = 0
function ok(label: string, cond: boolean, detail = ''): void {
  if (!cond) {
    failures++
    console.log(`  FAIL  ${label} ${detail}`)
  } else {
    console.log(`  ok    ${label}`)
  }
}

async function pendingRecords(pendingDir: string): Promise<StagedRecord[]> {
  let names: string[]
  try {
    names = await readdir(pendingDir)
  } catch {
    return []
  }
  const records: StagedRecord[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    records.push(JSON.parse(await readFile(join(pendingDir, name), 'utf8')) as StagedRecord)
  }
  return records.sort((a, b) => a.ts - b.ts)
}

async function clearPending(pendingDir: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(pendingDir)
  } catch {
    return
  }
  for (const name of names) await unlink(join(pendingDir, name))
}

async function runTests(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'aitrace-copilot-test-'))
  const devDir = join(root, '.aitrace')
  const pendingDir = join(devDir, 'pending')
  await mkdir(pendingDir, { recursive: true })

  const testFile = join(root, 'main.ts')
  await writeFile(testFile, 'const a = 1\nconst b = 2\nconst c = 3\n', 'utf8')

  console.log('1. replace_string_in_file (VS Code camelCase payload)')
  {
    const res = await handleHook(
      {
        cwd: root,
        toolName: 'replace_string_in_file',
        toolArgs: {
          filePath: testFile,
          oldString: 'const b = 2',
          newString: 'const b = 42',
        },
      },
      root,
    )

    ok('decision is deny', res.permissionDecision === 'deny')
    ok('hookSpecificOutput is VS Code shaped', res.hookSpecificOutput?.hookEventName === 'PreToolUse')
    ok('reason mentions AItrace', (res.permissionDecisionReason ?? '').includes('AItrace'))

    const disk = await readFile(testFile, 'utf8')
    ok('disk is unchanged', disk === 'const a = 1\nconst b = 2\nconst c = 3\n')

    const records = await pendingRecords(pendingDir)
    ok('one pending record', records.length === 1)
    ok('after has the proposed edit', records[0]?.after === 'const a = 1\nconst b = 42\nconst c = 3\n')
    ok('before is the committed file', records[0]?.before === 'const a = 1\nconst b = 2\nconst c = 3\n')
  }

  console.log('\n2. consecutive edits compose on the newest staged text')
  {
    const res = await handleHook(
      {
        cwd: root,
        toolName: 'replace_string_in_file',
        toolArgs: {
          filePath: testFile,
          oldString: 'const c = 3',
          newString: 'const c = 99',
        },
      },
      root,
    )
    ok('second edit is denied and staged', res.permissionDecision === 'deny')

    const records = await pendingRecords(pendingDir)
    ok('two pending records', records.length === 2)
    ok(
      'newest after has both edits',
      records[1]?.after === 'const a = 1\nconst b = 42\nconst c = 99\n',
    )
    ok('newest before is still the committed file', records[1]?.before === 'const a = 1\nconst b = 2\nconst c = 3\n')
  }

  console.log('\n3. multi_replace_string_in_file across files')
  {
    await clearPending(pendingDir)
    const fileA = join(root, 'a.ts')
    const fileB = join(root, 'b.ts')
    await writeFile(fileA, 'export const a = 1\n', 'utf8')
    await writeFile(fileB, 'export const b = 2\n', 'utf8')

    const res = await handleHook(
      {
        cwd: root,
        toolName: 'multi_replace_string_in_file',
        toolArgs: {
          replacements: [
            { filePath: fileA, oldString: 'const a = 1', newString: 'const a = 10' },
            { filePath: fileB, oldString: 'const b = 2', newString: 'const b = 20' },
          ],
        },
      },
      root,
    )

    ok('multi edit is denied', res.permissionDecision === 'deny')
    const records = await pendingRecords(pendingDir)
    ok('one record per file', records.length === 2)
    const byFile = new Map(records.map((record) => [record.file, record.after]))
    ok('file A after', byFile.get(fileA) === 'export const a = 10\n')
    ok('file B after', byFile.get(fileB) === 'export const b = 20\n')
  }

  console.log('\n4. create_file for a new file')
  {
    await clearPending(pendingDir)
    const created = join(root, 'created.ts')
    const res = await handleHook(
      {
        cwd: root,
        toolName: 'create_file',
        toolArgs: { filePath: created, content: 'export const x = 1\n' },
      },
      root,
    )
    ok('create is denied', res.permissionDecision === 'deny')
    const records = await pendingRecords(pendingDir)
    ok('one pending record', records.length === 1)
    ok('after is the proposed content', records[0]?.after === 'export const x = 1\n')
    ok('before is empty for a new file', records[0]?.before === '')
    ok('file is not on disk yet', !existsSync(created))
  }

  console.log('\n5. Copilot CLI payload (camelCase toolArgs string)')
  {
    await clearPending(pendingDir)
    const res = await handleHook(
      {
        cwd: root,
        toolName: 'edit',
        toolArgs: JSON.stringify({
          filePath: testFile,
          oldString: 'const a = 1',
          newString: 'const a = 100',
        }),
      },
      root,
    )
    ok('CLI edit is denied', res.permissionDecision === 'deny')
    const records = await pendingRecords(pendingDir)
    ok('CLI edit staged', records[0]?.after === 'const a = 100\nconst b = 2\nconst c = 3\n')
  }

  console.log('\n6. VS Code PascalCase payload (Claude-style Edit)')
  {
    await clearPending(pendingDir)
    const res = await handleHook(
      {
        hook_event_name: 'PreToolUse',
        cwd: root,
        tool_name: 'Edit',
        tool_input: {
          file_path: testFile,
          old_string: 'const b = 2',
          new_string: 'const b = 200',
        },
      },
      root,
    )
    ok('snake_case Edit is denied', res.permissionDecision === 'deny')
    const records = await pendingRecords(pendingDir)
    ok('snake_case Edit staged', records[0]?.after === 'const a = 1\nconst b = 200\nconst c = 3\n')
  }

  console.log('\n7. apply_patch update and add')
  {
    await clearPending(pendingDir)
    const added = join(root, 'patched.ts')
    const patch = [
      '*** Begin Patch',
      `*** Update File: ${testFile}`,
      '@@',
      ' const a = 1',
      '-const b = 2',
      '+const b = 222',
      `*** Add File: ${added}`,
      '+export const y = 2',
      '*** End Patch',
    ].join('\n')

    const res = await handleHook(
      { cwd: root, toolName: 'apply_patch', toolArgs: { input: patch } },
      root,
    )
    ok('apply_patch is denied', res.permissionDecision === 'deny')
    const records = await pendingRecords(pendingDir)
    ok('two records from patch', records.length === 2)
    const byFile = new Map(records.map((record) => [record.file, record.after]))
    ok('patched update after', byFile.get(testFile) === 'const a = 1\nconst b = 222\nconst c = 3\n')
    ok('patched add after', byFile.get(added) === 'export const y = 2\n')
  }

  console.log('\n8. non-editing tools pass through')
  {
    await clearPending(pendingDir)
    const res = await handleHook(
      { cwd: root, toolName: 'read_file', toolArgs: { filePath: testFile } },
      root,
    )
    ok('no permission decision', res.permissionDecision === undefined)
    ok('no pending records', (await pendingRecords(pendingDir)).length === 0)
  }

  console.log('\n9. AItrace bookkeeping writes are allowed directly (tour)')
  {
    await clearPending(pendingDir)
    const tour = join(devDir, 'tour.json')
    const res = await handleHook(
      {
        cwd: root,
        toolName: 'create_file',
        toolArgs: { filePath: tour, content: '{"title":"x","steps":[]}' },
      },
      root,
    )
    ok('tour write has no permission decision', res.permissionDecision === undefined)
    ok('tour write is not staged', (await pendingRecords(pendingDir)).length === 0)
  }

  console.log('\n10. mixed bookkeeping + source edit falls back safely')
  {
    await clearPending(pendingDir)
    const res = await handleHook(
      {
        cwd: root,
        toolName: 'multi_replace_string_in_file',
        toolArgs: {
          replacements: [
            { filePath: join(devDir, 'tour.json'), oldString: 'x', newString: 'y' },
            { filePath: testFile, oldString: 'const c = 3', newString: 'const c = 333' },
          ],
        },
      },
      root,
    )
    ok('mixed call has no permission decision', res.permissionDecision === undefined)
    ok('mixed call is not staged', (await pendingRecords(pendingDir)).length === 0)
  }

  console.log('\n11. disabled when .aitrace is absent')
  {
    const offRoot = await mkdtemp(join(tmpdir(), 'aitrace-copilot-off-'))
    const offFile = join(offRoot, 'main.ts')
    await writeFile(offFile, 'const a = 1\n', 'utf8')
    const res = await handleHook(
      {
        cwd: offRoot,
        toolName: 'replace_string_in_file',
        toolArgs: { filePath: offFile, oldString: 'const a = 1', newString: 'const a = 2' },
      },
      offRoot,
    )
    ok('edit passes through when staging is off', res.permissionDecision === undefined)
    const session = await handleHook({ cwd: offRoot, source: 'startup' }, offRoot)
    ok('session rules are off when staging is off', session.additionalContext === undefined)
    await rm(offRoot, { recursive: true, force: true })
  }

  console.log('\n12. sessionStart injects AItrace + tour rules')
  {
    const res = await handleHook({ cwd: root, source: 'startup' }, root)
    const context = res.additionalContext ?? ''
    ok('additionalContext is returned', context.length > 0)
    ok('context explains staging', context.includes('staged for the developer'))
    ok('context explains tours', context.includes('.aitrace/tour.json'))
  }

  console.log('\n13. discovers .aitrace by walking up from a nested cwd')
  {
    await clearPending(pendingDir)
    const nestedDir = join(root, 'src')
    await mkdir(nestedDir, { recursive: true })
    const nestedFile = join(nestedDir, 'nested.ts')
    await writeFile(nestedFile, 'const n = 1\n', 'utf8')

    const res = await handleHook({
      cwd: nestedDir,
      toolName: 'edit',
      toolArgs: { filePath: nestedFile, oldString: 'const n = 1', newString: 'const n = 2' },
    })
    ok('nested cwd edit is denied', res.permissionDecision === 'deny')
    const records = await pendingRecords(pendingDir)
    ok('nested edit staged at the workspace root', records[0]?.file === nestedFile)
  }

  console.log('\n14. str_replace_editor command payload')
  {
    await clearPending(pendingDir)
    const editorFile = join(root, 'editor.ts')
    await handleHook({
      cwd: root,
      toolName: 'str_replace_editor',
      toolArgs: { command: 'create', path: editorFile, file_text: 'const e = 1\n' },
    })
    await handleHook({
      cwd: root,
      toolName: 'str_replace_editor',
      toolArgs: { command: 'str_replace', path: editorFile, old_str: 'const e = 1', new_str: 'const e = 2' },
    })
    const records = await pendingRecords(pendingDir)
    ok('two str_replace_editor records', records.length === 2)
    ok('str_replace_editor composes', records[1]?.after === 'const e = 2\n')
  }

  await rm(root, { recursive: true, force: true })

  if (failures > 0) {
    console.error(`\n${failures} tests failed.`)
    process.exit(1)
  } else {
    console.log('\nAll Copilot hook tests passed.')
  }
}

runTests().catch((err) => {
  console.error(err)
  process.exit(1)
})
