/**
 * Cross-provider LLM fallback router for the DeepSeek Harness.
 *
 * This package enables automatic fallback to alternative LLM providers
 * when the primary provider fails, using the agent loop's request waterfalls.
 *
 * @module @deepseek-ai/dsh-llm-fallback
 */

export { name, inject, Config, apply } from './index-plugin.ts'

// Re-export live types
export type {
  LlmFallbackEventData,
  FallbackStep,
  FallbackChain,
  FallbackChainInput,
  FallbackStepInput,
  FallbackConfig,
} from './types.ts'

export { FallbackChainId } from './brand.ts'

// Re-export config
export { Config as ConfigSchema, resolveFallbackConfig } from './config.ts'
