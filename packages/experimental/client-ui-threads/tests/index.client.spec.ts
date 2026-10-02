/** Package entry points: the Host no-op plugin and the browser plugin body. */
import { describe, expect, it, vi } from 'vitest'
import { fake } from './support.client.ts'

const mountThreads = vi.hoisted(() => vi.fn(() => Promise.resolve(() => Promise.resolve())))
const THREADS = vi.hoisted(() => ({ package: 'threads' }))
const MEMORY = vi.hoisted(() => ({ package: 'memory' }))

vi.mock('@deepseek-ai/dsh-experimental-threads/remote', () => ({ default: THREADS }))
vi.mock('@deepseek-ai/dsh-experimental-project-memory/remote', () => ({ default: MEMORY }))
vi.mock('../src/client/mount.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/client/mount.ts')>(),
  mountThreads,
}))

const hostEntry = await import('../src/index.ts')
const clientEntry = await import('../src/client/index.ts')

describe('package entry points', () => {
  it('has a Host apply that does nothing', () => {
    expect(() => { hostEntry.apply() }).not.toThrow()
  })

  it('mounts the generated threads and projectMemory contributions with the default config', async () => {
    const { apply, Config } = clientEntry
    const ctx = fake<Parameters<typeof apply>[0]>({})
    await apply(ctx)
    expect(mountThreads).toHaveBeenLastCalledWith(ctx, THREADS, MEMORY, Config({}))
    const config = Config({ projectAgentPresets: ['team'] })
    await apply(ctx, config)
    expect(mountThreads).toHaveBeenLastCalledWith(ctx, THREADS, MEMORY, config)
  })
})
