/*
 * Small, deterministic previews for data that has been moved out of the
 * model context. These are deliberately shape-oriented: the complete payload
 * remains addressable in ContextStore, while the visible text preserves keys,
 * counts, useful scalar values, and both ends of text/code output.
 *
 * All preview budgets are UTF-8 bytes (see structuralPreview/compactErrorOutput
 * maxBytes). Token estimates elsewhere are ~bytes/4 ASCII-biased; prefer byte
 * budgets in boundary messages.
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
  const limit = Math.max(0, Math.floor(maxBytes));
  if (Buffer.byteLength(data, "utf8") <= limit) return data;
  const suffix = "\n... [preview capped]";
  if (limit < Buffer.byteLength(suffix, "utf8")) return utf8Prefix(data, limit);
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

function shortString(value: string, maxChars = 240): string {
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

function previewPriority(value: unknown): number {
  if (typeof value === "string") return value.length <= 240 ? 0 : 4;
  if (value === null || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.length <= 12 ? 2 : 5;
  const fields = Object.values(value);
  return fields.length <= 12 && fields.every((v) => v === null ||
    (typeof v !== "object" && (typeof v !== "string" || v.length <= 240))) ? 1 : 3;
}

function jsonStructuralPreview(value: unknown): string {
  const label = Array.isArray(value) ? `JSON array (${value.length} items)`
    : value && typeof value === "object" ? `JSON object (${Object.keys(value).length} keys)`
    : `JSON scalar: ${valueShape(value)}`;
  const lines = [label, "Selected fields (not a complete value):"];
  const pending = [{ entry: value, path: "$", depth: 0 }];
  let visited = 0;
  while (pending.length && visited++ < 120) {
    pending.sort((a, b) => previewPriority(a.entry) - previewPriority(b.entry) || a.depth - b.depth);
    const { entry, path, depth } = pending.shift()!;
    if (entry === null || typeof entry !== "object" || depth >= 4) {
      lines.push(`- ${path}: ${valueShape(entry)}`);
      continue;
    }
    let children: Array<[string, unknown]>;
    if (Array.isArray(entry)) {
      lines.push(`- ${path}: Array(${entry.length})`);
      const indices = entry.length <= 12 ? entry.map((_, i) => i) : [0, entry.length - 1];
      children = indices.map((i) => [`${path}[${i}]`, entry[i]]);
    } else {
      const keys = Object.keys(entry);
      lines.push(`- ${path}: Object(${keys.length} keys)`);
      children = keys.map((key) => [
        /^[A-Za-z_$][\w$-]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`,
        (entry as Record<string, unknown>)[key],
      ]);
    }
    // Short actionable siblings come before bulky schemas, logs, diffs and arrays.
    children.sort((a, b) => previewPriority(a[1]) - previewPriority(b[1]));
    for (const [childPath, child] of children.slice(0, 40)) pending.push({ entry: child, path: childPath, depth: depth + 1 });
    if (children.length > 40) lines.push(`- ${path}: … ${children.length - 40} more fields`);
  }
  return lines.join("\n");
}

export interface FabricSection { name: string; chars: number; text: string }

/** Recognize Fabric's sectioned text format, not arbitrary YAML or execution metadata. */
function fabricSections(data: string): { outline: string; sections: FabricSection[] } | undefined {
  const headers = [...data.matchAll(/^--- (.+?) \((\d+) chars\) ---\r?$/gm)];
  if (headers.length === 0) return undefined;
  const outline = data.slice(0, headers[0].index);
  if (!outline.includes('"<multi-line string, see section: ')) return undefined;
  const referenced = headers.filter((header) => outline.includes(JSON.stringify(`<multi-line string, see section: ${header[1]}>`)));
  if (referenced.length === 0) return undefined;
  const sections = referenced.map((header, i) => ({
    name: header[1],
    chars: Number(header[2]),
    text: data.slice(header.index! + header[0].length, referenced[i + 1]?.index ?? data.length).trim(),
  }));
  return { outline, sections };
}

/** Section names of a Fabric sectioned result; undefined for any other payload. */
export function fabricSectionNames(data: string): string[] | undefined {
  return fabricSections(data)?.sections.map((section) => section.name);
}

/** One named section of a Fabric sectioned result. */
export function fabricSection(data: string, name: string): FabricSection | undefined {
  return fabricSections(data)?.sections.find((section) => section.name === name);
}

function fabricSectionPreview(data: string, limit: number): string | undefined {
  const parsed = fabricSections(data);
  if (!parsed) return undefined;
  const candidates = parsed.outline.split(/\r?\n/).map((line, i) => ({ line, number: i + 1 }))
    .filter(({ line }) => line.trim() && line.length <= 240);
  const priority = (line: string): number => {
    const depth = line.length - line.trimStart().length;
    return /^(?:- )?(?:ok|success|status|exitCode|path|output|count|error):/.test(line.trimStart()) ? depth - 1000 : depth;
  };
  candidates.sort((a, b) => priority(a.line) - priority(b.line));
  const small = parsed.sections.filter((section) => Buffer.byteLength(section.text, "utf8") <= Math.min(600, limit / 3));
  const outlineBudget = Math.floor(limit * (small.length ? 0.4 : 0.65));
  const lines = ["Fabric sectioned result — selected fields, not a complete value:"];
  lines.push(fitUtf8(candidates.slice(0, 32).map(({ line, number }) => `${number}: ${line}`).join("\n"), outlineBudget));
  for (const section of small.slice(0, 6)) {
    lines.push(`Section ${JSON.stringify(section.name)} (${section.chars} chars):\n${section.text}`);
  }
  lines.push("Sections (read one with ctx_read section):");
  for (const section of parsed.sections.slice(0, 24)) lines.push(`- ${JSON.stringify(section.name)}: ${section.chars} chars`);
  return fitUtf8(lines.join("\n"), limit);
}

/** Only successful edit envelopes qualify; arbitrary diffs and failed operations do not. */
export function isVerboseEditAcknowledgement(data: string): boolean {
  const isAck = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const details = record.details as Record<string, unknown> | undefined;
    return record.ok === true && record.isError !== true && !record.error && typeof record.output === "string" &&
      record.output.startsWith("Successfully ") && record.output.length <= 1024 &&
      !!details && [details.diff, details.patch].some((v) => typeof v === "string" && v.length > 1024);
  };
  try {
    const value = JSON.parse(data);
    return Array.isArray(value) ? value.length > 0 && value.length <= 32 && value.every(isAck) : isAck(value);
  } catch {
    const parsed = fabricSections(data);
    return !!parsed && /^(?:- )?ok: true\r?\n/.test(parsed.outline) &&
      /^\s*output: ["']?Successfully /m.test(parsed.outline) &&
      !/^\s*(?:- )?(?:ok: false|isError: true|error:)/m.test(parsed.outline) &&
      parsed.sections.some((section) => /(?:^|\.)details\.(?:diff|patch)$/.test(section.name) && section.text.length > 1024);
  }
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
  const sections = fabricSectionPreview(data, limit);
  if (sections) return sections;
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
  const limit = Math.max(0, Math.floor(maxBytes));
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
