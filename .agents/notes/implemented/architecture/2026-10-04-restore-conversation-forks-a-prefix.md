# Agent Note: Restore conversation forks an event prefix instead of truncating the log

Status: implemented

## Problem

A chat user wants to end a conversation at an earlier message and continue from there — the familiar "rewind" gesture. The request reads as "delete everything after this message", which the Session log cannot do.

A Session is an append-only log and the single source of truth for an agent's interaction ([session.md](../../../docs/subsystems/session.md), [core.md](../../../docs/subsystems/core.md)). The persistence seam states that committed events "are contiguous from seq 0 and never rewritten" ([persistence.md](../../../docs/subsystems/persistence.md)), and its only mutators are `append` and `flush`. The JSONL backend's `truncateTornTail` is crash repair: a provider-private byte-offset operation reachable only from the torn-frame scanner, which logs a damage warning. An open read handle rejects a log that shrank below a prefix it already observed, and a test pins that refusal.

The one shortening operation the Host offers is `session.fork`: it builds a prefix seed with `buildForkSeed` and always publishes it under a new Session id, leaving the source untouched. Its boundary policy deliberately rejects a prefix that ends inside an open Turn rather than clipping it — the Remote-level fork instead supplies synthetic `forked` closers through `buildForkSeed`.

The user asked for this on 2026-10-04 and, told that truncation is unavailable, chose the fork semantics. The next day they asked for the message itself to come back for editing, which fixed the cut boundary: ending the conversation *at* the message would leave it visible above the resent copy.

## Decision

### Restore forks the prefix before the message and returns its text

The Chat message row carries a restore control beside Copy on every sent user and steering message. It forks the source Session with the event immediately **before** the message as the inclusive boundary, opens the child, and places the message body in the new composer through the Conversation plugin's `input.requestDraftInitialization`. Because the message falls outside the cut, the resent text takes its place rather than appearing as a second bubble. The source Session is never modified, so nothing is destroyed and no confirmation is required.

The composer draft lives in a Lexical editor owned by `ui-conversation`; the declared store's `draft` is only a persistence mirror. `requestDraftInitialization` is the same seam `ui-workspace` uses for New Session content, and navigation retains the child before the restore runs, so the binding is live and the draft is adopted before the composer first paints.

A cut landing inside an open Turn inherits synthetic `forked` closers, so the new Session ends that Turn just before the message and the next prompt continues from it.

Branch keeps its own placement on the completed-turn footer and its `branch_session_click` report. The two controls share one fork call in `apply.ts` and differ only in which message names the cut and which action they report, so a restore click records `restore_conversation_click` with that message's durable id.

### No availability gate

Restoring the transcript's last message is the ordinary "edit what I just sent" case, so every sent user and steering message offers the control.

## Alternatives considered

**Truncate the durable log in place.** Rejected by the persistence contract: committed events are never rewritten, an open read handle refuses a shrunken log, and the JSONL artifact is concatenated Zstandard frames with no seq-to-byte map, so a cut means re-encoding the prefix and rewriting the artifact under the session's single writer.

**Hide the tail behind a new log-only event.** The physical log would stay append-only, but every fold whose seqs sit past the cut changes (message derivation, projections, session title, feedback, subagent catalog, threads, plan), and the model must stop seeing events that remain in its own source of truth. This is a larger change than the storage cut, not a smaller one.

**Keep the message inside the cut and still prefill the composer.** Rejected: sending the prefilled text would then append a second copy of the user's own message to the transcript.

**Replace the branch control instead of adding a second one.** Branch answers a different question — where an answer came from, as a sibling conversation — while restore answers "continue from here with this message". Keeping both leaves the original session list shape intact for users who already rely on branch.

**Confirm before restoring.** Unnecessary under fork semantics: the source Session is untouched, so there is nothing to lose and a dialog would only add a step to a reversible navigation.

## Consequences

Restoring adds a Session rather than shortening one, so a user who repeatedly rewinds accumulates siblings in the sidebar; archiving the abandoned parent is a separate existing action.

The cut closes an open Turn with a `forked` reason, which is visible in the new conversation's transcript as an ended turn rather than an unanswered message.

Only text is restored. A recorded message carries durable `ImageAttachmentRef`/`FileAttachmentRef` values, while a composer draft needs browser-owned attachments created from `File` objects, so re-hydrating attachments is a separate change with no current consumer for the extra API.

Every user and steering message renders a second control, which lengthens the action row on wide bubbles.

A same-Session restore would require a new `SessionPersistence` operation plus a JSONL implementation, a reset of the write handle's cursor and the read handle's observed-prefix guard, and invalidation of every derived fold named above; the earlier proposal to drop a log tail was [rejected](2026-06-20-truncate-interrupted-turns.md) as a silent corruption of the canonical transcript.
