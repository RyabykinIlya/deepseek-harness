/**
 * Unit tests for the llm-fallback package.
 *
 * @module @deepseek-ai/dsh-llm-fallback/tests
 */

import { describe, it, expect } from 'vitest'
import { resolveFallbackConfig, DEFAULT_FALLBACK_CONFIG } from '../src/config.ts'
import { FallbackChainId, FallbackAttemptId } from '../src/brand.ts'

describe('llm-fallback config', () => {
  it('resolves default config', () => {
    const resolved = resolveFallbackConfig(DEFAULT_FALLBACK_CONFIG)

    expect(resolved.has('default')).toBe(true)
    expect(resolved.has('coding')).toBe(true)
    expect(resolved.has('session-title')).toBe(true)
  })

  it('default chain has correct steps', () => {
    const resolved = resolveFallbackConfig(DEFAULT_FALLBACK_CONFIG)
    const chain = resolved.get('default')!

    expect(chain.name).toBe('Default')
    expect(chain.steps.length).toBe(2)
    expect(chain.steps[0]).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
      label: 'DeepSeek Chat',
    })
    expect(chain.steps[1]).toEqual({
      provider: 'claude-proxy',
      model: 'claude-opus-5',
      label: 'Claude Opus 5',
    })
  })

  it('coding chain has correct steps', () => {
    const resolved = resolveFallbackConfig(DEFAULT_FALLBACK_CONFIG)
    const chain = resolved.get('coding')!

    expect(chain.name).toBe('Coding')
    expect(chain.steps.length).toBe(2)
    expect(chain.steps[0]?.provider).toBe('claude-proxy')
    expect(chain.steps[1]?.provider).toBe('deepseek')
  })

  it('generates chain ID when not provided', () => {
    const config = {
      chains: {
        test: {
          name: 'Test',
          steps: [
            { provider: 'a', model: 'a', label: 'A' },
            { provider: 'b', model: 'b', label: 'B' },
          ],
        },
      },
    }

    const resolved = resolveFallbackConfig(config)
    const chain = resolved.get('test')!

    expect(chain.id).toBeDefined()
    expect(typeof chain.id).toBe('string')
    expect(chain.id.length).toBeGreaterThan(0)
  })

  it('uses provided chain ID', () => {
    const customId = FallbackChainId('custom-id')
    const config = {
      chains: {
        test: {
          id: customId,
          name: 'Test',
          steps: [
            { provider: 'a', model: 'a', label: 'A' },
          ],
        },
      },
    }

    const resolved = resolveFallbackConfig(config)
    const chain = resolved.get('test')!

    expect(chain.id).toBe(customId)
  })

  it('brand functions work correctly', () => {
    const chainId = FallbackChainId('test-chain')
    const attemptId = FallbackAttemptId('test-attempt')

    expect(chainId).toBe('test-chain')
    expect(attemptId).toBe('test-attempt')
  })
})

describe('llm-fallback types', () => {
  it('FallbackChainId brands string', () => {
    const id = FallbackChainId('my-chain')
    expect(id).toBe('my-chain')
  })

  it('FallbackAttemptId brands string', () => {
    const id = FallbackAttemptId('my-attempt')
    expect(id).toBe('my-attempt')
  })
})
