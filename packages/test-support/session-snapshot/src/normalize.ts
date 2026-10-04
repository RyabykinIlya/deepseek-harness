/**
 * Pure ACP transcript and session-log normalizers. They scrub session ids, run cwd, RPC ids,
 * timestamps, goal lifecycle clocks, and hook duration while preserving semantic payload values.
 * The prompt-text and tool-schema scrubbers stay composable so one scenario per header class can
 * pin prompt and tool-schema sidecars.
 * @module @deepseek-ai/dsh-session-snapshot/normalize
 */

import {
  decodeSeqRanges,
} from '@deepseek-ai/dsh-session'
import { prepareSessionSnapshotFixtureForComparison } from '@deepseek-ai/dsh-llm-replay'
import { redactSessionSnapshotIds } from './identity.ts'
import { sessionHeaderVersion } from './session-files.ts'

const SESSION_ID = '{{sessionId}}'
const MESSAGE_ID = '{{messageId}}'
const USED_TOKENS = '{{usedTokens}}'
const CWD = '{{cwd}}'
const SYSTEM = '{{system}}'
const TOOLS = '{{tools}}'
const EVENT_TIME = '{{eventTime}}'
const EVENT_OMITTED_BYTES = '{{eventOmittedBytes}}'
const SOURCE_SESSION_FORMAT = '{{sourceSessionFormatVersion}}'
const PACKED_CHUNK_ROW_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])

function isPackedFixtureRow(record: Record<string, unknown>): boolean {
  return typeof record.type === 'string' && PACKED_CHUNK_ROW_TYPES.has(record.type)
}

function omitFixtureEnvelope(record: Record<string, unknown>): void {
  delete record.seq
  delete record.time
  delete record.seq0
  delete record.time0
}

/** A cwd-rooted path after volatile cwd replacement, through its last separator-delimited segment. */
const CWD_ROOTED_PATH_RE = /\{\{cwd(?::[1-9]\d*)?\}\}(?:[\\/][^\s<>"'`]+)+/g
const PATH_TAG_RE = /(<path>)([^<]*)(<\/path>)/g
const ADDITIONAL_INSTRUCTIONS_PATH_RE = /(Additional instructions from: )([^\r\n]+)/g
const EMBEDDED_EVENT_TIME_RE = /^(  "time": )\d+(?=,\r?$)/gm
const EVENT_READ_OMITTED_BYTES_RE = /(\r?\n\r?\n\(Omitted )\d+( bytes\.)/g
const EVENT_READ_TARGET_REGION_RE
  = /^Session [^\r\n]+ — [^\r\n]+\r?\nTarget event seq \d+:\r?\n```json\r?\n\{\r?\n[\s\S]*?(?=\r?\n```(?:\r?\n|$)|\r?\n\r?\n\(Omitted )/
const PATH_TEXT_BOUNDARY_RE = /[\s<>'"`()\[\]{},;:!?=]/
const FILE_URI_PATH_PREFIX_RE = /(?:^|[^a-z0-9+.-])file:\/\/\/?$/i

/** A UUID v4 string, the shape `randomUUID()` produces for session ids. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
// Separator runs also match JSON-escaped Windows paths; extraction preserves their exact serialized spelling.
const LOCAL_SPILL_PATH_RE = new RegExp(
  String.raw`\{\{cwd\}\}[\\/]+\.spill[\\/]+session-[0-9a-f]{12}[\\/]+[0-9a-f]{12}-([A-Za-z0-9._~-]+?)`
  + String.raw`(?=\. Use read with offset/limit|[\s)"]|\\+"|$)`,
  'g',
)
const SNAPSHOT_SPILL_PATH_RE = new RegExp(
  String.raw`(?:[A-Za-z]:)?[\\/]+(?:tmp|t)[\\/]+(?:dsh-acp-snap-[0-9a-f]{9}|dsh-acp-snapshot-spill)[\\/]+session-[0-9a-f]{12}[\\/]+[0-9a-f]{12}-([A-Za-z0-9._~-]+?)`
  + String.raw`(?=\. Use read with offset/limit|[\s)"]|\\+"|$)`,
  'g',
)

/**
 * Extract every snapshot-mode spill path from a session log, keyed by spill
 * filename. Used by refresh write-back to keep spill paths stable across runs.
 * @param content - the raw session log text to scan.
 * @returns spill filename → the full matched spill path, last match wins per name.
 */
export function extractSnapshotSpillPaths(content: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const match of content.matchAll(SNAPSHOT_SPILL_PATH_RE)) {
    const name = match[1]
    /* v8 ignore next -- the filename capture is required and non-empty whenever the spill regex matches */
    if (name === undefined) continue
    result.set(name, match[0])
  }
  return result
}

/** Convert separators only inside generated path-bearing text markers. */
function canonicalizeEmbeddedPaths(value: string): string {
  return value
    .replace(PATH_TAG_RE, (_match, open: string, path: string, close: string) =>
      `${open}${path.replaceAll('\\', '/')}${close}`)
    .replace(ADDITIONAL_INSTRUCTIONS_PATH_RE, (_match, prefix: string, path: string) =>
      `${prefix}${path.replaceAll('\\', '/')}`)
}

/** One Session role whose cwd is not rooted at the generated workspace. */
export interface SessionRoleCwd {
  /** Absolute live cwd of the relocated role, as its own header spelled it. */
  readonly cwd: string
  /** Stable fixture token: `{{cwd:N}}` for the role at fixture ordinal N. */
  readonly token: string
}

/** The `{{cwd:N}}` tokens {@link sessionRoleCwds} mints, one per fixture ordinal. */
const ROLE_TOKEN_RE = /^\{\{cwd:([1-9]\d*)\}\}$/u

/**
 * The absolute spelling a relocated role's cwd is STORED as in a committed
 * fixture.
 *
 * `{{cwd:N}}` is a comparison token, not a path, and a Session header's `cwd`
 * is validated as an absolute path by every released physical format before a
 * fixture is read — for replay input and for expected-output comparison alike.
 * The placeholder is therefore a path, derived from the role's ordinal, and it
 * carries no run-specific bytes: reading it back, {@link sessionRoleCwds}
 * classifies it exactly as it classifies the live worktree path, so both
 * normalize to the same `{{cwd:N}}`.
 *
 * @param token - the role's `{{cwd:N}}` token.
 * @returns the fixture's absolute placeholder for that role.
 */
export function roleFixtureCwd(token: string): string {
  const ordinal = ROLE_TOKEN_RE.exec(token)?.[1]
  /* v8 ignore next -- only sessionRoleCwds mints role tokens, and it mints {{cwd:N}}. */
  if (ordinal === undefined) throw new Error(`session-snapshot: ${token} is not a relocated-role token`)
  return `/dsh-snapshot-role-cwd/${ordinal}`
}

/** Inputs the normalizers need to recognize a run's volatile values. */
export interface NormalizeContext {
  /** The session id(s) the run issued — replaced with `{{sessionId}}`. */
  sessionIds: string[]
  /** The generated cwd the run used — replaced with `{{cwd}}`. */
  cwd: string
  /** Other filesystem spellings of the same cwd (for example Windows short and long paths). */
  cwdAliases?: readonly string[]
  /**
   * Cwds of roles that are not rooted at the generated cwd — a Thread's git
   * worktree, for example — replaced with their own `{{cwd:N}}` tokens. See
   * {@link sessionRoleCwds}.
   */
  roleCwds?: readonly SessionRoleCwd[]
}

/** How cwd-rooted path separators are represented after the cwd is tokenized. */
export type CwdPathMode = 'canonical' | 'native'

/** Optional controls shared by stdout and session-log normalization. */
export interface NormalizeOptions {
  /** Use `/` for shared goldens, or preserve captured separators for a platform-specific golden. */
  cwdPathMode?: CwdPathMode
  /** Keep already-redacted typed ids and arbitrary UUID-like prose unchanged. */
  identityMode?: 'legacy' | 'preserve'
}

/** Comparison controls for complete primary and child Session logs. */
export interface SessionSnapshotComparisonOptions extends Omit<NormalizeOptions, 'identityMode'> {
  /** Inputs are captured native writer output, rather than source-versus-migrated-artifact comparisons. */
  nativeWriterOutput?: true
}

/** Every known spelling of one absolute path: itself plus the macOS realpath alias. */
function pathSpellings(path: string, aliases: readonly string[] = []): string[] {
  const spellings = [...new Set([path, ...aliases])]
    .filter(spelling => spelling.length > 0)
  const macAliases = spellings
    .filter(spelling => spelling.startsWith('/') && !spelling.startsWith('/private/'))
    .map(spelling => `/private${spelling}`)
  return [...new Set([...spellings, ...macAliases])]
    .sort((left, right) => right.length - left.length)
}

/** Return every known spelling of the generated cwd, most specific first. */
function cwdSpellings(ctx: NormalizeContext): string[] {
  return pathSpellings(ctx.cwd, ctx.cwdAliases ?? [])
}

/** Whether `child` is `parent` itself or a path below it. */
function isUnderPath(child: string, parent: string): boolean {
  if (child === parent) return true
  const separator = parent.includes('/') || !parent.includes('\\') ? '/' : '\\'
  const prefix = parent.endsWith(separator) ? parent : `${parent}${separator}`
  return child.startsWith(prefix)
}

/** Read the cwd one Session header declares, or `undefined` when it declares none. */
function headerCwdOf(log: string): string | undefined {
  const line = log.split(/\r?\n/u).find(candidate => candidate.trim().length > 0)
  if (line === undefined) return undefined
  const header: unknown = JSON.parse(line)
  if (header === null || typeof header !== 'object' || Array.isArray(header)) return undefined
  const { cwd } = header as { cwd?: unknown }
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/**
 * Collect the role cwds a primary-first log set carries outside the generated workspace.
 *
 * A Thread child runs in its own git worktree, whose path embeds a per-run
 * repository hash, so neither the generated-workspace token nor typed identity
 * redaction can make it stable. Each such role keeps its own `{{cwd:N}}` token,
 * where N is the fixture ordinal the harness already uses for that role. A role
 * rooted INSIDE the generated workspace keeps the existing `{{cwd}}/…` spelling,
 * so every scenario that already replays is untouched.
 *
 * @param logs - primary-first Session JSONL logs.
 * @param primaryCwd - the generated workspace cwd, in any one of its spellings.
 * @param aliases - other spellings of the generated workspace.
 * @returns relocated roles ordered longest cwd first, so nested paths resolve correctly.
 */
export function sessionRoleCwds(
  logs: readonly string[],
  primaryCwd: string,
  aliases: readonly string[] = [],
): SessionRoleCwd[] {
  const roots = pathSpellings(primaryCwd, aliases)
  const roles: SessionRoleCwd[] = []
  for (const [index, log] of logs.entries()) {
    if (index === 0) continue
    const cwd = headerCwdOf(log)
    if (cwd === undefined) continue
    if (roots.some(root => isUnderPath(cwd, root))) continue
    roles.push({ cwd, token: `{{cwd:${index}}}` })
  }
  return roles.sort((left, right) => right.cwd.length - left.cwd.length)
}

/** Replace every relocated role cwd with its own stable token, most specific cwd first. */
function replaceRoleCwds(value: string, roles: readonly SessionRoleCwd[]): string {
  let out = value
  const ordered = roles.length < 2 ? roles : [...roles].sort((left, right) => right.cwd.length - left.cwd.length)
  for (const role of ordered) {
    for (const spelling of pathSpellings(role.cwd)) out = replaceCwdSpelling(out, spelling, role.token)
    out = out.split(`/private${role.token}`).join(role.token)
  }
  return out
}

/** Whether an embedded cwd match starts and ends at a path/text boundary. */
function isCwdMatch(value: string, start: number, length: number): boolean {
  const before = value[start - 1]
  const after = value[start + length]
  const afterPunctuation = value[start + length + 1]
  const startsAtBoundary = before === undefined
    || PATH_TEXT_BOUNDARY_RE.test(before)
    || FILE_URI_PATH_PREFIX_RE.test(value.slice(0, start))
  const endsAtBoundary = after === undefined
    || after === '/'
    || after === '\\'
    || PATH_TEXT_BOUNDARY_RE.test(after)
    || after === '.' && (afterPunctuation === undefined || PATH_TEXT_BOUNDARY_RE.test(afterPunctuation))
  return startsAtBoundary && endsAtBoundary
}

/** Replace one cwd spelling without matching a longer path segment that merely shares its prefix. */
function replaceCwdSpelling(value: string, spelling: string, replacement: string): string {
  let cursor = 0
  let out = ''
  while (cursor < value.length) {
    const match = value.indexOf(spelling, cursor)
    if (match < 0) return out + value.slice(cursor)
    const end = match + spelling.length
    if (isCwdMatch(value, match, spelling.length)) {
      out += value.slice(cursor, match) + replacement
      cursor = end
    } else {
      out += value.slice(cursor, end)
      cursor = end
    }
  }
  return out
}

/** Replace every known cwd spelling with one stable token. */
function replaceCwd(value: string, ctx: NormalizeContext, replacement: string): string {
  let out = value
  for (const spelling of cwdSpellings(ctx)) out = replaceCwdSpelling(out, spelling, replacement)
  return out
}

/** Replace cwd, session ids, and any stray UUID with stable tokens in a string. */
function scrubString(
  value: string,
  ctx: NormalizeContext,
  cwdPathMode: CwdPathMode,
  identityMode: 'legacy' | 'preserve',
): string {
  let out = replaceCwd(value, ctx, CWD)
  // A relocated role (a Thread worktree) is tokenized on its own ordinal, so the
  // generated-workspace token can never absorb it and the per-run repository hash
  // it carries never reaches a fixture.
  if (ctx.roleCwds !== undefined && ctx.roleCwds.length > 0) out = replaceRoleCwds(out, ctx.roleCwds)
  // Filesystem APIs can report one directory with several spellings. Replace
  // every known spelling longest-first so a shorter alias cannot corrupt a
  // longer one before it is tokenized. macOS additionally symlinks
  // /tmp → /private/tmp and /var → /private/var: the session header cwd may
  // omit the /private prefix while fs tools resolve symlinks, so cover the
  // prefixed form of every spelling too, then collapse a residual prefixed
  // token.
  out = out.split(`/private${CWD}`).join(CWD)
  if (cwdPathMode === 'canonical') {
    // Restrict separator conversion to paths rooted at the cwd token. A global
    // backslash rewrite would corrupt regexes, commands, and model-authored text.
    out = out.replace(CWD_ROOTED_PATH_RE, path => path.replaceAll('\\', '/'))
    out = canonicalizeEmbeddedPaths(out)
  }
  out = out.replace(LOCAL_SPILL_PATH_RE, (_match, name: string) => `{{spillLocator:${name}}}`)
  out = out.replace(SNAPSHOT_SPILL_PATH_RE, (_match, name: string) => `{{spillLocator:${name}}}`)
  // Exact event-read results render the target as pretty JSON inside a
  // distinctive envelope. Restrict time scrubbing to that fenced target so
  // neighbor, model, bash, and unrelated tool text remains regression-visible.
  if (EVENT_READ_TARGET_REGION_RE.test(out)) {
    out = out.replace(
      EVENT_READ_TARGET_REGION_RE,
      target => target.replace(EMBEDDED_EVENT_TIME_RE, `$1${EVENT_TIME}`),
    )
    out = out.replace(EVENT_READ_OMITTED_BYTES_RE, `$1${EVENT_OMITTED_BYTES}$2`)
  }
  if (identityMode === 'legacy') {
    for (const id of ctx.sessionIds) out = out.split(id).join(SESSION_ID)
    out = out.replace(UUID_RE, SESSION_ID)
  }
  return out
}

/** Recursively scrub a parsed JSON value (strings replaced; structure kept). */
function scrubValue(
  value: unknown,
  ctx: NormalizeContext,
  cwdPathMode: CwdPathMode,
  identityMode: 'legacy' | 'preserve',
  key?: string,
): unknown {
  if (typeof value === 'string') {
    if (identityMode === 'legacy' && key === 'messageId') return MESSAGE_ID
    const scrubbed = scrubString(value, ctx, cwdPathMode, identityMode)
    return cwdPathMode === 'canonical' && key === 'path' ? scrubbed.replaceAll('\\', '/') : scrubbed
  }
  if (Array.isArray(value)) return value.map(v => scrubValue(v, ctx, cwdPathMode, identityMode))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v, ctx, cwdPathMode, identityMode, k)
    if (
      (value as { sessionUpdate?: unknown }).sessionUpdate === 'usage_update'
      && typeof (value as { used?: unknown }).used === 'number'
    ) out.used = USED_TOKENS
    return out
  }
  return value
}

/** Escape one literal path segment for use in a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Replace any absolute spelling whose final segment is the generated cwd basename. */
function tokenizeFixtureString(
  value: string,
  ctx: NormalizeContext,
  basename: string,
  rootToken: string,
  roles: readonly SessionRoleCwd[],
): string {
  const exact = replaceCwd(value, ctx, rootToken)
  const absoluteCwd = new RegExp(
    String.raw`(?:[A-Za-z]:)?[\\/](?:[^\\/\s<>"]+[\\/])*${escapeRegExp(basename)}`
    + String.raw`(?=$|[\\/\s<>'"()\[\]{},;:!?=])`,
    'g',
  )
  const rooted = exact.replace(absoluteCwd, rootToken).split(`/private${rootToken}`).join(rootToken)
  return roles.length === 0 ? rooted : replaceRoleCwds(rooted, roles)
}

/** Recursively replace generated-cwd spellings while preserving every other JSON value. */
function tokenizeFixtureValue(
  value: unknown,
  ctx: NormalizeContext,
  basename: string,
  rootToken: string,
  roles: readonly SessionRoleCwd[],
): unknown {
  if (typeof value === 'string') return tokenizeFixtureString(value, ctx, basename, rootToken, roles)
  if (Array.isArray(value)) return value.map(item => tokenizeFixtureValue(item, ctx, basename, rootToken, roles))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      tokenizeFixtureValue(item, ctx, basename, rootToken, roles),
    ]))
  }
  return value
}

/** Optional relocated roles whose cwds share one generated-workspace token. */
export interface TokenizeFixtureOptions {
  /** Roles outside the generated workspace, from {@link sessionRoleCwds}. */
  readonly roleCwds?: readonly SessionRoleCwd[]
}

/**
 * Store one generated workspace as `{{cwd}}` while retaining every other
 * session value. The caller opts in only for workspaces created under a
 * platform temporary root; explicitly relocated workspaces keep their real
 * path. A log whose own cwd belongs to a relocated role stores that role's
 * `{{cwd:N}}` token in every body value and its absolute
 * {@link roleFixtureCwd} placeholder in the header, and every log tokenizes
 * every relocated role cwd, so a parent's record of a child's worktree matches
 * the child's own header.
 *
 * @param rawLog The raw or refresh-stabilized session JSONL fixture.
 * @param options Relocated role cwds shared by the scenario's primary-first logs.
 * @returns Compact JSONL whose known cwd spellings become `{{cwd}}` or `{{cwd:N}}`.
 * @throws If a non-empty line is invalid JSON or the session cwd has no basename.
 */
export function tokenizeSessionFixtureCwd(rawLog: string, options: TokenizeFixtureOptions = {}): string {
  const lines = rawLog.split('\n')
  const headerIndex = lines.findIndex(line => line.trim().length > 0)
  const header = headerIndex < 0 ? undefined : JSON.parse(lines[headerIndex] as string) as { cwd?: unknown }
  const cwd = typeof header?.cwd === 'string' ? header.cwd : ''
  const basename = cwd.split(/[\\/]/).at(-1)
  if (basename === undefined || basename.length === 0) {
    throw new Error('acp-snapshot: cannot tokenize a cwd without a basename')
  }
  const roles = options.roleCwds ?? []
  const own = roles.find(role => pathSpellings(role.cwd).includes(cwd))
    // A committed fixture already stores this role as its placeholder, so
    // write-back recognizes its own output and stays a fixed point.
    ?? roles.find(role => roleFixtureCwd(role.token) === cwd)
  // An already-stored log keeps the token it was written with, so write-back is a
  // fixed point and a relocated role never collapses into `{{cwd}}`.
  const stored = /^\{\{cwd(?::[1-9]\d*)?\}\}$/u.exec(cwd)?.[0]
  const rootToken = own?.token ?? stored ?? CWD
  // The header's own `cwd` is the one value a released format re-validates as an
  // absolute path, so a relocated role stores its placeholder there and its
  // comparison token everywhere else.
  const storedCwd = own === undefined ? rootToken : roleFixtureCwd(own.token)
  const ctx: NormalizeContext = { sessionIds: [], cwd }
  return lines.map((line, index) => {
    if (line.trim().length === 0) return line
    const value = tokenizeFixtureValue(JSON.parse(line), ctx, basename, rootToken, roles)
    if (index === headerIndex && value !== null && typeof value === 'object') {
      ;(value as { cwd?: unknown }).cwd = storedCwd
    }
    return JSON.stringify(value)
  }).join('\n')
}

/**
 * Normalize a raw stdout transcript (newline-delimited JSON-RPC frames) into a stable expected output
 * in the same shape as the wire: one compact JSON frame per line (NDJSON), with the JSON-RPC
 * `id` rewritten to a per-transcript sequence (1, 2, 3, …) and all volatile strings scrubbed.
 * Invalid JSON throws, doubling as a protocol-stdout purity check.
 *
 * @param rawStdout The captured stdout bytes, decoded utf8.
 * @param ctx The run's volatile values to scrub.
 * @param options Separator output controls; shared canonical paths are the default.
 * @returns The normalized NDJSON transcript, one frame per line.
 */
export function normalizeStdout(
  rawStdout: string,
  ctx: NormalizeContext,
  options: NormalizeOptions = {},
): string {
  const cwdPathMode = options.cwdPathMode ?? 'canonical'
  const identityMode = options.identityMode ?? 'legacy'
  const lines = rawStdout.split('\n').filter(line => line.trim().length > 0)
  // Map each distinct JSON-RPC id (request/response correlate by id) to a stable
  // sequence number, in first-seen order, so id churn doesn't perturb the expected output.
  const idSeq = new Map<string, number>()
  const stableId = (id: unknown): number => {
    const key = JSON.stringify(id)
    let n = idSeq.get(key)
    if (n === undefined) { n = idSeq.size + 1; idSeq.set(key, n) }
    return n
  }
  const frames = lines.map((line) => {
    const frame = JSON.parse(line) as Record<string, unknown>
    if ('id' in frame && frame.id !== undefined && frame.id !== null) {
      frame.id = stableId(frame.id)
    }
    return scrubValue(frame, ctx, cwdPathMode, identityMode) as Record<string, unknown>
  })
  return frames.map(f => JSON.stringify(f)).join('\n') + '\n'
}

/**
 * Normalize a session JSONL log into a stable expected output: the header line's
 * volatile fields (`createdAt`, `id`, `cwd`) are zeroed/scrubbed; event,
 * historical packed-row, embedded Assistant-stream, goal lifecycle, and
 * catalog child-creation clocks are zeroed; and all volatile strings are
 * scrubbed. Projected inputs remain
 * projected. Packed `data.dt` gaps are normalized even when the projected row
 * omits its `time0` anchor.
 * Output is JSONL in the same shape as the input — one compact record per
 * line.
 *
 * @param rawLog The raw session `.jsonl` content.
 * @param ctx The run's volatile values to scrub.
 * @param options Separator output controls; shared canonical paths are the default.
 * @returns The normalized JSONL log, one record per line.
 */
export function normalizeSessionLog(
  rawLog: string,
  ctx: NormalizeContext,
  options: NormalizeOptions = {},
): string {
  const cwdPathMode = options.cwdPathMode ?? 'canonical'
  const identityMode = options.identityMode ?? 'legacy'
  const lines = rawLog.split('\n').filter(line => line.trim().length > 0)
  const records = lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>
    if (record.type === 'session') {
      if ('createdAt' in record) record.createdAt = 0
    } else if (isPackedFixtureRow(record)) {
      if ('time0' in record) record.time0 = 0
      const data = record.data
      if (data !== null && typeof data === 'object' && Array.isArray((data as { dt?: unknown }).dt)) {
        (data as { dt: unknown[] }).dt = (data as { dt: unknown[] }).dt.map(() => 0)
      }
    } else if ('time' in record) {
      record.time = 0
    }
    if ((record.type === 'assistant/message' || record.type === 'assistant/attempt')
      && record.data !== null && typeof record.data === 'object') {
      const stream = (record.data as { stream?: unknown }).stream
      if (Array.isArray(stream)) {
        for (const member of stream) {
          if (member === null || typeof member !== 'object') continue
          const timed = member as { time?: unknown; time0?: unknown; dt?: unknown }
          if (typeof timed.time === 'number') timed.time = 0
          if (typeof timed.time0 === 'number') timed.time0 = 0
          if (Array.isArray(timed.dt)) timed.dt = timed.dt.map(() => 0)
        }
      }
    }
    if (record.type === 'hook/result' && record.data !== null && typeof record.data === 'object') {
      const data = record.data as Record<string, unknown>
      if ('durationMs' in data) data.durationMs = 0
    }
    normalizeFeedbackClocks(record)
    if (record.type === 'goal/change' && record.data !== null && typeof record.data === 'object') {
      const data = record.data as Record<string, unknown>
      if ('createdAt' in data) data.createdAt = 0
      if ('updatedAt' in data) data.updatedAt = 0
    }
    if (record.type === 'subagent/catalog' && record.data !== null && typeof record.data === 'object') {
      const data = record.data as Record<string, unknown>
      if ('childCreatedAt' in data) data.childCreatedAt = 0
    }
    if (Object.hasOwn(record, 'sourceEventSeqs')) {
      record.sourceEventSeqs = decodeSeqRanges(record.sourceEventSeqs)
    }
    return scrubValue(record, ctx, cwdPathMode, identityMode) as Record<string, unknown>
  })
  return records.map(r => JSON.stringify(r)).join('\n') + '\n'
}

/**
 * Canonicalize projected v3 body records. Compact streams are nested event data,
 * so persistence flush boundaries cannot change the row layout.
 */
function projectSessionSnapshot(rawLog: string): string {
  const lines = rawLog.split('\n').filter(line => line.trim().length > 0)
  const header = lines.shift() as string

  const body = lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>
    omitFixtureEnvelope(record)
    return JSON.stringify(record)
  })
  return [header, ...body, ''].join('\n')
}

/**
 * Normalize and project persisted session JSONL for a committed fixture.
 * This composes ordinary log normalization with request-header scrubbing and
 * persistence-envelope projection, then writes the v3 logical event stream as
 * one record per event, independent of persistence flush boundaries. Event order
 * and source-event references are preserved.
 *
 * @param rawLog - persisted or already-projected session JSONL.
 * @param ctx - the run's volatile values to scrub.
 * @param options - separator output controls.
 * @returns normalized committed session snapshot JSONL.
 */
export function normalizeSessionSnapshot(
  rawLog: string,
  ctx: NormalizeContext,
  options: NormalizeOptions = {},
): string {
  return projectSessionSnapshot(scrubSessionSnapshot(normalizeSessionLog(rawLog, ctx, options)))
}

/**
 * Normalize one scenario's primary and child logs with shared typed identity redaction.
 * Native-writer comparison strictly restores each input before tokenizing its own delivery generation.
 * @param rawLogs - primary-first persisted or projected session JSONL.
 * @param ctx - generated cwd spellings and other volatile run facts.
 * @param options - separator and native-writer comparison controls; identity relationships are preserved.
 * @returns comparison-only Session records in input order; not persistence or fixture write-back input.
 */
export function normalizeSessionSnapshots(
  rawLogs: readonly string[],
  ctx: NormalizeContext,
  options: SessionSnapshotComparisonOptions = {},
): string[] {
  const { nativeWriterOutput, ...normalizeOptions } = options
  const comparableLogs = rawLogs.map((log) => {
    if (!hasSessionFormatVersion(log)) return normalizeSessionFormatMetadata(log)
    const currentLog = prepareSessionSnapshotFixtureForComparison(log)
    return normalizeSessionFormatMetadata(currentLog, nativeWriterOutput
      ? sessionHeaderVersion(log, 'source Session snapshot') : undefined)
  })
  // Roles are collected from the redacted logs, so a relocated cwd whose final
  // segment is a typed identity token is still recognized as one path.
  const redacted = redactSessionSnapshotIds(comparableLogs)
  const roleCtx: NormalizeContext = {
    ...ctx,
    roleCwds: mergeRoleCwds(ctx.roleCwds, sessionRoleCwds(redacted, ctx.cwd, ctx.cwdAliases ?? [])),
  }
  return redacted.map(log => projectSessionSnapshot(
    scrubSessionSnapshot(normalizeSessionLog(
      log,
      { ...roleCtx, sessionIds: [] },
      { ...normalizeOptions, identityMode: 'preserve' },
    )),
  ))
}

/**
 * Union caller-supplied and freshly collected role cwds.
 *
 * One role can be described by two spellings: the caller's context carries the
 * cwd as the run spelled it, while collection reads it back after identity
 * redaction replaced a typed token inside the path. Both must survive, because
 * each matches a different rendering of the same text; the longest cwd is
 * applied first, and a spelling that no longer occurs replaces nothing.
 */
function mergeRoleCwds(
  supplied: readonly SessionRoleCwd[] | undefined,
  collected: readonly SessionRoleCwd[],
): SessionRoleCwd[] {
  const seen = new Set<string>()
  const merged: SessionRoleCwd[] = []
  for (const role of [...supplied ?? [], ...collected]) {
    const key = `${role.token}\u0000${role.cwd}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(role)
  }
  return merged
}

/**
 * Omit the artifact header generation after official migration for comparison.
 * An explicit source version tokenizes only delivery markers for that original input generation.
 * Other delivery generations and every captured-source generation retain their recorded values.
 * @param rawLog - Session records or events as compact JSON lines.
 * @param sourceVersion - original generation of strictly validated native writer output; otherwise omit.
 * @returns comparison-only records with the Session header version omitted and native delivery qualifiers tokenized.
 */
export function normalizeSessionFormatMetadata(rawLog: string, sourceVersion?: number): string {
  return rawLog.split('\n').map((line) => {
    if (line.trim().length === 0) return line
    const record = JSON.parse(line) as Record<string, unknown>
    if (record.type === 'session' && Object.hasOwn(record, 'version')) {
      delete record.version
    } else if (sourceVersion !== undefined && record.type === 'session-log-deepseek/delivery-accepted') {
      const data = record.data as Record<string, unknown> | undefined
      if (data?.sessionFormatVersion !== sourceVersion) return line
      data.sessionFormatVersion = SOURCE_SESSION_FORMAT
    } else return line
    return JSON.stringify(record)
  }).join('\n')
}

/** Whether a fixture declares a released Session format and therefore participates in migration burn-in. */
function hasSessionFormatVersion(rawLog: string): boolean {
  const firstLine = rawLog.split(/\r?\n/).find(line => line.trim().length > 0)
  if (firstLine === undefined) throw new Error('session snapshot must start with a session header')
  const header = JSON.parse(firstLine) as unknown
  if (header === null || typeof header !== 'object' || Array.isArray(header)
    || (header as Record<string, unknown>)['type'] !== 'session') {
    throw new Error('session snapshot must start with a session header')
  }
  return Object.hasOwn(header, 'version')
}

/**
 * Replace the rendered prompt text of every `system/message` event with the
 * `{{system}}` token. The text block keeps its position and type, so the
 * fixture still shows one system node per prompt version; an empty `content`
 * (no system prompt) stays empty. Request headers and every other line pass
 * through byte-for-byte; the transform is idempotent.
 *
 * @param rawLog The raw session `.jsonl` content.
 * @returns The JSONL with system-prompt text tokenized.
 */
export function scrubSystemPrompts(rawLog: string): string {
  return scrubModelRequestContent(rawLog, { system: true })
}

/**
 * Replace tool schemas in full request-header snapshots with `{{tools}}`
 * tokens while retaining field presence. Logs containing developer messages
 * retain tool names so historical addition references remain verifiable.
 * System-prompt text stays verbatim so
 * pinning fixtures can move only schema bulk into their dedicated JSON
 * sidecar. Lines without a tool payload pass through byte-for-byte; the
 * transform is idempotent.
 *
 * @param rawLog The raw session `.jsonl` content.
 * @returns The JSONL with tool-schema content tokenized.
 */
export function scrubToolSchemas(rawLog: string): string {
  return scrubModelRequestContent(rawLog, { tools: true })
}

/**
 * Replace all bulky model-request content in a session JSONL with stable
 * tokens: the `system/message` prompt text handled by
 * {@link scrubSystemPrompts} and the request-header tool schemas handled by
 * {@link scrubToolSchemas}. Field presence, config, and reason are kept.
 * Lines without content to scrub pass through byte-for-byte, and the
 * transform is idempotent.
 *
 * @param rawLog The raw session `.jsonl` content.
 * @returns The JSONL with prompt text and schema bulk tokenized, other lines byte-identical.
 */
export function scrubModelRequestBulk(rawLog: string): string {
  return scrubModelRequestContent(rawLog, { system: true, tools: true })
}

/**
 * Project a persisted session log while tokenizing prompt text and schema
 * bulk. Each non-empty line is parsed at most once; the session header stays
 * byte-identical. Body records omit their persistence-only envelopes and expand
 * source-event ranges without changing reference order.
 *
 * @param rawLog - persisted or already-projected session JSONL.
 * @returns committed snapshot JSONL with prompt text and tool schemas tokenized.
 */
export function scrubSessionSnapshot(rawLog: string): string {
  const scrubbed = scrubModelRequestBulk(rawLog)
  let recordIndex = 0
  return scrubbed.split('\n').map((line) => {
    if (line.trim().length === 0) return line
    const record = JSON.parse(line) as Record<string, unknown>
    if (recordIndex++ === 0) {
      if (record.type !== 'session') throw new Error('session snapshot must start with a session header')
      return line
    }
    omitFixtureEnvelope(record)
    if (Object.hasOwn(record, 'sourceEventSeqs')) {
      record.sourceEventSeqs = decodeSeqRanges(record.sourceEventSeqs)
    }
    normalizeFeedbackClocks(record)
    return JSON.stringify(record)
  }).join('\n')
}

/** Normalize service-owned feedback clocks without touching user-authored payloads. */
function normalizeFeedbackClocks(record: Record<string, unknown>): void {
  if (record.type !== 'feedback/message-put' || record.data === null || typeof record.data !== 'object') return
  const item = (record.data as { item?: unknown }).item
  if (item === null || typeof item !== 'object') return
  const clocks = item as Record<string, unknown>
  if ('createdAt' in clocks) clocks.createdAt = 0
  if ('updatedAt' in clocks) clocks.updatedAt = 0
}

/** Which independent model-request payloads a scrubber replaces. */
interface ModelRequestScrubOptions {
  /** Tokenize the prompt text of every `system/message` event. */
  system?: boolean
  /** Tokenize the `tools` field of every `request/header` event. */
  tools?: boolean
}

/** Return the first text block of a `system/message` payload, or `undefined` when it carries none. */
function systemPromptBlock(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const message = data.message as Record<string, unknown> | null | undefined
  if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return undefined
  const block = message.content[0] as Record<string, unknown> | null | undefined
  return block !== null && typeof block === 'object' && typeof block.text === 'string' ? block : undefined
}

/** Transform the selected model-request payloads. */
function scrubModelRequestContent(rawLog: string, options: ModelRequestScrubOptions): string {
  const lines = rawLog.split('\n')
  const records = lines.map(line => line.trim().length === 0 ? undefined : JSON.parse(line) as Record<string, unknown>)
  const retainToolNames = records.some(record => record?.type === 'developer/message')
  const out = lines.map((line, index) => {
    const record = records[index]
    if (record === undefined) return line
    const data = record.data as Record<string, unknown> | null | undefined
    if (data === null || typeof data !== 'object') return line
    if (options.system === true && record.type === 'system/message') {
      const block = systemPromptBlock(data)
      if (block === undefined) return line
      block.text = SYSTEM
      return JSON.stringify(record)
    }
    if (options.tools === true && record.type === 'request/header') {
      const header = data.header as Record<string, unknown> | null | undefined
      if (header === null || typeof header !== 'object' || !('tools' in header)) return line
      header.tools = retainToolNames && Array.isArray(header.tools)
        ? header.tools.map((tool: string | { name: string }) => typeof tool === 'string' ? tool : tool.name)
        : TOOLS
      return JSON.stringify(record)
    }
    return line
  })
  return out.join('\n')
}
