---
kind: upgrade-guide
description: "The Project memory entry length cap rises from 500 to 2000 characters, and both memory caps become editable on the Plugins page under Project memory."
---

# Project memory caps are wider and editable in Settings

English | [中文](guide.zh.md)

## Change

In v0.2.1-alpha.1, `@deepseek-ai/dsh-experimental-project-memory` raises its `maxEntryChars` default from 500 to 2000 Unicode code points, so a `memory_write` carrying 501 through 2000 characters now succeeds instead of failing with `The memory text is N characters; the limit is 500.` Both memory caps — `maxEntryChars` and `maxEntries` — also become volatile Config fields, and `@deepseek-ai/dsh-experimental-client-ui-project-memory` registers a "Project memory" page on the Plugins page that edits them. The Host reads each cap on the next write, so a saved change applies without a restart. The row's remaining fields (`projectPresets`, `maxLineageDepth`) stay boot composition and are not editable there. Operators of the Threads profile bundle are affected; a deployment that pinned `maxEntryChars` in its own profile row is unaffected.

## Migration

1. If a deployment wants the previous bound, set it in the profile row rather than relying on the default:

   ```yaml
   - id: project-memory
     name: '@deepseek-ai/dsh-experimental-project-memory'
     config:
       maxEntryChars: 500
   ```

2. Mount `@deepseek-ai/dsh-experimental-client-ui-project-memory` beside the Host row to get the page. The Threads profile bundle ships both rows; a custom composition must add the client row itself.
3. Open Plugins → Project memory, raise **Characters per entry**, and save. Confirm the next `memory_write` of that length succeeds; the refusal message names the limit the Host is enforcing at that moment.
