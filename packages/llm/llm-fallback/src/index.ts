/**
 * Cross-provider LLM fallback router for the DeepSeek Harness.
 *
 * This package provides the `llmFallback` service that enables automatic
 * fallback to alternative LLM providers when the primary provider fails.
 *
 * @module @deepseek-ai/dsh-llm-fallback
 */

export { name, inject, Config, apply } from './index-plugin.ts'

// Re-export types
export type {
  FallbackStep,
  FallbackChain,
  FallbackConfig,
  ResolvedFallbackChain,
  ResolvedFallbackResult,
  FallbackExecutionState,
  LlmFallbackRouter,
} from './types.ts'

export { FallbackChainId, FallbackAttemptId } from './brand.ts'

// Re-export config
export { FallbackConfigSchema, resolveFallbackConfig, DEFAULT_FALLBACK_CONFIG } from './config.ts'
