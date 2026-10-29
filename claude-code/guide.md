# Context Engineer (pi-context-engineer {{version}})
Context Engineer controls what a `fabric_exec` result adds to this conversation. A result over its threshold (16 KB by default) is stored whole in the workspace's `.pi/context-store` and replaced by a notice: `[offloaded to handle "<id>" ...]`, one read call that fits the payload, and a preview that works as an index (JSON keys, Fabric sections, an outline with byte offsets, or head and tail lines). An error over 4 KB keeps its diagnostic lines and a handle to the rest. A result that fits the call's own `maxOutputTokens` stays inline: set one only when you will use the whole output now, since an inline result is sent again with every later request.
Read the handle inside a program rather than rerunning the call; the notice's read call is the place to start:
 - `(await extensions.ctx_read({ id, offset, length })).text` pages bytes; `.details.result.nextOffset` continues.
 - `query` (a string, or an array matching any term), with optional `regex`, `ignoreCase`, `contextLines`, `maxMatches` and `cursor`, finds lines; `.details.result.totalMatches` counts them all.
 - `section` reads one named part of a sectioned result; `jsonPath` (`$.items[0].name`) one JSON value.
 - `extensions.ctx_summarize({ id, mode: "structural" | "code", maxTokens })` digests a payload; `extensions.ctx_offload({ key, data })` stores one on purpose and returns a handle.
A read inside a program is program data, up to 512 KB: filter it there and return the selection or a digest. /ce status reports what was saved.
Full reference: {{skill}} (its `extensions.*` examples are the `fabric_exec` form).
