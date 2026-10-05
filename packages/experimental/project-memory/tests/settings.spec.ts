/**
 * The Project memory caps as the settings form writes them.
 *
 * `SettingsForms.write()` refuses a path that is not beneath a `.volatile()`
 * field, and a non-volatile field is read once at mount, so a cap that outgrew
 * its bound could only be widened by restarting the Host. Driving the real
 * Loader entry is what proves a settings edit reaches the next write.
 */

import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ProjectMemoryService from '../src/index.ts'
import type { ProjectId } from '../src/index.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import { memoryBacking } from './harness.ts'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

const P = 'p' as ProjectId

it('applies widened caps to the next write without remounting the service', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await memoryBacking(ctx, new MemoryMediaPool())
  const live = await liveConfig(ctx, ProjectMemoryService, { maxEntries: 3, maxEntryChars: 8 })
  const before = live.fiber
  const memory = ctx.get('projectMemory')!

  await memory.add(P, '12345678', 'user')
  await expect(memory.add(P, 'nine chars', 'user')).rejects.toThrow('the limit is 8')

  await live.update({ maxEntryChars: 16, maxEntries: 4 })
  expect(live.entry.fiber === before).toBe(true)
  await memory.add(P, 'a longer entry', 'user')
  await memory.add(P, 'third entry', 'user')
  await memory.add(P, 'fourth entry', 'user')
  await expect(memory.add(P, 'a fifth entry', 'user')).rejects.toThrow('already holds 4 memory entries')

  await live.replace({})
  expect(memory.config.maxEntryChars?.get()).toBe(2000)
  expect(memory.config.maxEntries?.get()).toBe(200)
})
