/*
 * Small, deterministic previews for data that has been moved out of the
 * model context. These are deliberately shape-oriented: the complete payload
 * remains addressable in ContextStore, while the visible text preserves keys,
 * counts, useful scalar values, and both ends of text/code output.
 */

export type PreviewContentType = "json" | "code" | "text" | "unknown";

function isContinuationByte(value: number | undefined): boolean {
  return value !== undefined && (value & 0xc0) === 0x80;
}

function utf8Prefix(data: string, maxBytes: number): string {
  const buffer = Buffer.from(data, "utf8");
  let end = Math.max(0, Math.min(buffer.length, Math.floor(maxBytes)));
  while (end > 0 && isContinuationByte(buffer[end])) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function utf8Suffix(data: string, maxBytes: number): string {
  const buffer = Buffer.from(data, "utf8");
  let start = Math.max(0, buffer.length - Math.floor(maxBytes));
  while (start < buffer.length && isContinuationByte(buffer[start])) start++;
  return buffer.subarray(start).toString("utf8");
}

function fitUtf8(data: string, maxBytes: number): string {
  const limit = Math.max(256, Math.floor(maxBytes));
  if (Buffer.byteLength(data, "utf8") <= limit) return data;
  const suffix = "\n... [preview capped]";
  return utf8Prefix(data, Math.max(0, limit - Buffer.byteLength(suffix, "utf8"))) + suffix;
}

export function inferContentType(data: string): PreviewContentType {
  const trimmed = data.trim();
  if (!trimmed) return "unknown";
  try {
    JSON.parse(trimmed);
    return "json";
  } catch {
    return /^(?:import |export |from |const |let |var |function |class |interface |def |package )/m.test(trimmed)
      ? "code"
      : "text";
  }
}

function shortString(value: string, maxChars = 120): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

function valueShape(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(shortString(value));
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (Array.isArray(value)) {
    if (depth >= 2 || value.length === 0) return `Array(${value.length})`;
    const first = value[0];
    return `Array(${value.length})${typeof first === "object" && first !== null ? ` of ${valueShape(first, depth + 1)}` : ""}`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (depth >= 2) return `Object(${keys.length} keys)`;
    const shown = keys.slice(0, 6).join(", ");
    return `Object(${keys.length} keys${shown ? `: ${shown}${keys.length > 6 ? ", …" : ""}` : ""})`;
  }
  return typeof value;
}

function jsonStructuralPreview(value: unknown): string {
  if (Array.isArray(value)) {
    const lines = [`JSON array (${value.length} items)`];
    if (value.length > 0) lines.push(`first: ${valueShape(value[0])}`);
    if (value.length > 1) lines.push(`last: ${valueShape(value[value.length - 1])}`);
    return lines.join("\n");
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const lines = [`JSON object (${keys.length} keys)`];
    for (const key of keys.slice(0, 40)) lines.push(`- ${key}: ${valueShape(record[key])}`);
    if (keys.length > 40) lines.push(`- … ${keys.length - 40} more keys`);
    return lines.join("\n");
  }

  return `JSON scalar: ${valueShape(value)}`;
}

/** Build a bounded shape-oriented preview without exposing the full payload. */
export function structuralPreview(
  data: string,
  maxBytes = 2048,
  contentType: PreviewContentType = inferContentType(data),
): string {
  const limit = Math.max(256, Math.floor(maxBytes));
  const trimmed = data.trim();
  const wantsJson = contentType === "json" || (contentType === "unknown" && inferContentType(trimmed) === "json");
  if (wantsJson) {
    try {
      return fitUtf8(jsonStructuralPreview(JSON.parse(trimmed)), limit);
    } catch {
      // A stale content-type marker should not make the handle unreadable.
    }
  }

  const totalBytes = Buffer.byteLength(data, "utf8");
  if (totalBytes <= limit) return data;
  const label = contentType === "code" ? "Code" : "Text";
  const suffix = `\n... [middle omitted; ${totalBytes} bytes total]\n`;
  const available = Math.max(0, limit - Buffer.byteLength(`${label} preview:${suffix}`, "utf8"));
  const headBytes = Math.floor(available * 0.62);
  const tailBytes = Math.max(0, available - headBytes);
  const preview = `${label} preview:\n${utf8Prefix(data, headBytes)}${suffix}${utf8Suffix(data, tailBytes)}`;
  return fitUtf8(preview, limit);
}

/** Compact repetitive compiler/parser errors while retaining diagnostics and the tail. */
export function compactErrorOutput(data: string, maxBytes = 4096): string {
  const totalBytes = Buffer.byteLength(data, "utf8");
  const limit = Math.max(256, Math.floor(maxBytes));
  if (totalBytes <= limit) return data;

  const lines = data.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  const diagnostic = /error|failed|failure|exception|diagnostic|TS\d+|line\s+\d+|SyntaxError|TypeError/i;
  const selected: string[] = [];
  const add = (line: string): void => {
    const count = counts.get(line) ?? 1;
    const rendered = count > 1 ? `${line} [repeated ${count}×]` : line;
    if (!selected.includes(rendered)) selected.push(rendered);
  };

  for (const line of lines.slice(0, 8)) add(line);
  for (const line of lines.filter((line) => diagnostic.test(line)).slice(0, 32)) add(line);
  for (const line of lines.slice(-8)) add(line);

  const header = `Error output compacted: ${lines.length} lines, ${totalBytes} bytes; showing ${selected.length} representative lines.`;
  return fitUtf8(`${header}\n${selected.join("\n")}`, limit);
}
