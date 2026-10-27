/**
 * Opt-in projection for a final model-facing tool envelope. Never applied to
 * program intermediates. Keeps metadata and media, removing only exact text
 * duplicates and transport provenance. Does not mutate its argument.
 */
export function projectToolResult(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : undefined;
  if (!content) return value; // Not an invocation envelope; preserve ordinary payloads.
  const joined = content?.filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join("\n");
  const text = typeof record.text === "string" ? record.text : joined;
  if (text === undefined) return value;
  const { source: _source, content: _content, text: _text, details, ...rest } = record;
  const remaining = content?.filter((part) => part?.type !== "text" || joined !== text);
  let projectedDetails = details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const d = details as Record<string, unknown>;
    const result = d.result;
    if (result && typeof result === "object" && !Array.isArray(result)) {
      const r = result as Record<string, unknown>;
      const { content: duplicate, ...metadata } = r;
      if (duplicate === text) projectedDetails = { ...d, result: metadata };
    }
  }
  return {
    ...rest, text,
    ...(remaining?.length ? { content: remaining } : {}),
    ...(projectedDetails !== undefined ? { details: projectedDetails } : {}),
  };
}
