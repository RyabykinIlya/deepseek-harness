/**
 * Unit tests for the llm-fallback config module.
 *
 * @module @deepseek-ai/dsh-llm-fallback/tests
 */

import { describe, it, expect } from 'vitest'
import { resolveFallbackConfig } from '../src/config.ts'
import { FallbackChainId } from '../src/brand.ts'

describe('llm-fallback config', () => {
  it('resolves explicit config with multiple chains', () => {
    const config = {
      chains: {
        default: {
          name: 'Default',
          steps: [
            { provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek Chat' },
            { provider: 'claude-proxy', model: 'claude-opus-5', label: 'Claude Opus 5' },
          ],
        },
        coding: {
          name: 'Coding',
          steps: [
            { provider: 'claude-proxy', model: 'claude-opus-5', label: 'Claude Opus 5' },
            { provider: 'deepseek', model: 'deepseek-coder', label: 'DeepSeek Coder' },
          ],
        },
      },
    }

    const resolved = resolveFallbackConfig(config)

    expect(resolved.has('default')).toBe(true)
    expect(resolved.has('coding')).toBe(true)
    expect(resolved.size).toBe(2)
  })

  it('resolves chain with correct steps and frozen array', () => {
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

    expect(chain.name).toBe('Test')
    expect(chain.steps.length).toBe(2)
    expect(chain.steps[0]).toEqual({
      provider: 'a',
      model: 'a',
      label: 'A',
    })
    expect(chain.steps[1]).toEqual({
      provider: 'b',
      model: 'b',
      label: 'B',
    })
    // Steps array should be frozen
    expect(Object.isFrozen(chain.steps)).toBe(true)
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

  it('uses intent as name when name not provided', () => {
    const config = {
      chains: {
        myIntent: {
          steps: [
            { provider: 'a', model: 'a' },
          ],
        },
      },
    }

    const resolved = resolveFallbackConfig(config)
    const chain = resolved.get('myIntent')!

    expect(chain.name).toBe('myIntent')
  })

  it('throws on empty steps array', () => {
    const config = {
      chains: {
        empty: {
          steps: [],
        },
      },
    }

    expect(() => resolveFallbackConfig(config)).toThrow('llm-fallback: chain "empty" has no steps')
  })

  it('throws on step with empty provider', () => {
    const config = {
      chains: {
        test: {
          steps: [
            { provider: '', model: 'a' },
          ],
        },
      },
    }

    expect(() => resolveFallbackConfig(config)).toThrow('llm-fallback: chain "test" has a step with empty provider')
  })

  it('throws on step with empty model', () => {
    const config = {
      chains: {
        test: {
          steps: [
            { provider: 'a', model: '' },
          ],
        },
      },
    }

    expect(() => resolveFallbackConfig(config)).toThrow('llm-fallback: chain "test" has a step with empty model')
  })

  it('throws on duplicate (provider, model) pair within chain', () => {
    const config = {
      chains: {
        test: {
          steps: [
            { provider: 'a', model: 'm' },
            { provider: 'a', model: 'm' },
          ],
        },
      },
    }

    expect(() => resolveFallbackConfig(config)).toThrow(
      'llm-fallback: chain "test" has duplicate (provider, model) pair: a|m',
    )
  })

  it('brand function works correctly', () => {
    const chainId = FallbackChainId('test-chain')
    expect(chainId).toBe('test-chain')
  })

  it('empty config produces empty map', () => {
    const config = { chains: {} }
    const resolved = resolveFallbackConfig(config)
    expect(resolved.size).toBe(0)
  })
})
