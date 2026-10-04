/**
 * The browser-safe type entry of the model-routing package.
 *
 * A browser bundle must not pull the Host plugin's runtime in through a type
 * import, so this module re-exports only the vocabulary a surface renders or
 * writes: the tier shape the settings page edits, the projection view the chip
 * and the Thread roster read, and the Remote value shapes the page prices with.
 * Everything here is types; the module has no runtime effect.
 *
 * @module @deepseek-ai/dsh-experimental-model-routing/client
 */

export type {
  FreeUsage,
  JudgeRule,
  JudgeVerdict,
  ModelQuote,
  ModelRoutingControl,
  ModelRoutingState,
  ModelRoutingView,
  RoutingBoundary,
  RoutingEndpoint,
} from './types.ts'
export type {
  FreeMode,
  ModelInput,
  PresetRoute,
  PresetRouteSnapshot,
  Quantization,
  RoutingSettings,
  TierSettings,
  TierSettingsSnapshot,
} from './config.ts'
export type {
  EndpointRejection,
  RankedEndpoint,
  SelectionPolicy,
  SelectionResult,
  TurnMix,
  UsageTotals,
} from './select.ts'
