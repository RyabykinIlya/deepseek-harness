/**
 * Typed failures of the Project memory service.
 * @module @deepseek-ai/dsh-experimental-project-memory
 */

import type { ProjectMemoryErrorCode } from './types.ts'

/**
 * A refused memory operation. The message is written for the model: it names
 * the cause and the next action, so tools surface it unchanged.
 */
export class ProjectMemoryError extends Error {
  /**
   * @param code - stable failure kind.
   * @param message - model-facing explanation with the corrective action.
   */
  constructor(readonly code: ProjectMemoryErrorCode, message: string) {
    super(message)
    this.name = 'ProjectMemoryError'
  }
}
