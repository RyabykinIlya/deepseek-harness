/**
 * `thread_tier`: moving one Thread to another model tier.
 *
 * The tool exists only while a model-routing plugin is loaded, because without
 * one there are no tiers to name and no service that could record the switch.
 * The switch itself is not applied here: the coordinator's Project log receives
 * the decision, and the routing plugin reads it when the Thread's next request
 * is built — which is also why a Thread survives a Host restart with its tier
 * intact.
 *
 * @module @deepseek-ai/dsh-experimental-threads-tool/tier
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: makes `ctx.modelRouting` resolve where the service is present.
import type {} from '@deepseek-ai/dsh-experimental-model-routing'
import type { Session } from '@deepseek-ai/dsh-session'

/**
 * Read the Threads this calling Project owns.
 *
 * The same check `thread_diff` makes, kept verbatim: a coordinator must not be
 * able to retier another Project's Thread by guessing its id.
 * @param ctx - the tool's context.
 * @param tool - tool name for the error message.
 * @param session - the calling Project Session.
 * @returns the Project's Thread rows.
 * @throws Error naming the missing capability when the projection is unavailable.
 */
function readCallerThreads(ctx: Context, tool: string, session: Session): { rows: { threadId: string }[] } {
  const threads = ctx.get('threads')
  if (threads === undefined) {
    throw new Error(`${tool} cannot read Threads: @deepseek-ai/dsh-experimental-threads is not loaded`)
  }
  if (!threads.available) {
    throw new Error(`${tool} cannot read Threads: the \`threads\` Session projection is unavailable `
      + '(it requires @deepseek-ai/dsh-session-projection)')
  }
  return { rows: threads.viewOf(session) }
}

/**
 * Register `thread_tier` while a model-routing service is mounted.
 *
 * Conditional registration rather than a refusal: a composition that never loads
 * the routing plugin has no tiers, and a permanently visible tool would only
 * teach the model a vocabulary it cannot use.
 * @param ctx - the plugin's context.
 */
export function registerThreadTier(ctx: Context): void {
  ctx.inject(['modelRouting'], (routingCtx) => {
    routingCtx.tools.register(defineTool({
      name: 'thread_tier',
      description:
        "Switch one of this Project's Threads to another model tier. The switch applies from the Thread's next "
        + 'model request; the Thread keeps its worktree, branch, and history. Switching discards the Thread\'s '
        + 'prompt cache, so switch only when its current tier cannot do the work.',
      parameters: {
        thread_id: {
          type: 'string',
          description: 'Thread id from thread_status.',
        },
        tier: {
          type: 'string',
          description: 'Tier name, for example pro or flash.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            threadId: { type: 'string', required: true },
            tier: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `Thread ${value.threadId} switches to tier ${value.tier} from its next model request.`,
        }],
      },
      // The tool contract is async; nothing here awaits because the switch is
      // recorded synchronously and the next request reads it.
      // oxlint-disable-next-line typescript/require-await -- the tool contract is async by signature
      async execute(args, exec) {
        const caller = exec.agent
        if (!caller) throw new Error('thread_tier requires a calling agent (exec.agent was undefined)')
        const rows = readCallerThreads(ctx, 'thread_tier', caller.session).rows
        const { thread_id: threadId, tier } = args
        if (threadId === undefined || tier === undefined) {
          throw new Error('thread_tier needs both thread_id and tier')
        }
        if (!rows.some(row => row.threadId === threadId)) {
          throw new Error(`unknown thread id ${threadId}; call thread_status to list this Project's threads`)
        }
        const routing = ctx.get('modelRouting')
        if (routing === undefined) {
          throw new Error('thread_tier cannot switch tiers: @deepseek-ai/dsh-experimental-model-routing is not loaded')
        }
        // The service validates the tier name against what is configured and
        // records the decision; its message is the useful one, so it passes through.
        routing.setThreadTier(caller.session, threadId, tier)
        return { threadId, tier }
      },
    }))
  })
}
