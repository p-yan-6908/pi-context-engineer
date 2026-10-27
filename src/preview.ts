/*
 * Small, deterministic previews for data that has been moved out of the
 * model context. These are deliberately shape-oriented: the complete payload
 * remains addressable in ContextStore, while the visible text preserves keys,
 * counts, useful scalar values, an outline of headed output, or both ends of
 * text/code output, with the byte offsets a ctx_read range needs.
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

/** A preview and, when it shows a prefix, the first payload byte it leaves out. */
export interface Preview {
  text: string;
  /** UTF-8 offset where a ctx_read range continues past what the preview shows. */
  readFrom?: number;
}

/** Longest line shown in an outline or section head. */
const PREVIEW_LINE_CHARS = 160;
/** Bytes scanned for part headers; a payload can be far larger than its preview. */
const OUTLINE_SCAN_BYTES = 2 * 1024 * 1024;
/** First lines considered per part or section. */
const MAX_HEAD_LINES = 64;

function clipLine(line: string, maxChars = PREVIEW_LINE_CHARS): string {
  if (line.length <= maxChars) return line;
  // Never split a surrogate pair; a lone surrogate encodes as U+FFFD.
  const end = /[\ud800-\udbff]/.test(line[maxChars - 1]) ? maxChars - 1 : maxChars;
  return `${line.slice(0, end)}…`;
}

/** UTF-8 bytes of lines joined with newlines. */
function byteLines(lines: string[]): number {
  return lines.reduce((bytes, line) => bytes + Buffer.byteLength(line, "utf8") + 1, 0) - (lines.length ? 1 : 0);
}

/**
 * How many lines of each candidate list to show: one more line for each list
 * in turn while the total fits, so every part gets its first lines before
 * any part gets more.
 */
function fillRoundRobin(fixedBytes: number, candidates: string[][], limit: number): number[] {
  const counts = candidates.map(() => 0);
  const open = new Set(candidates.keys());
  let used = fixedBytes;
  while (open.size > 0) {
    for (const i of [...open]) {
      const line = candidates[i][counts[i]];
      const cost = line === undefined ? Infinity : Buffer.byteLength(line, "utf8") + 1;
      if (used + cost > limit) {
        open.delete(i);
        continue;
      }
      used += cost;
      counts[i]++;
    }
  }
  return counts;
}

/** The leading lines that fit in maxBytes, newlines included. */
function linesWithin(lines: string[], maxBytes: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    used += Buffer.byteLength(line, "utf8") + 1;
    if (used > maxBytes) break;
    kept.push(line);
  }
  return kept;
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
  const sections: FabricSection[] = [];
  const headerAt = new Map(referenced.map((header, i) => [header.index!, i]));
  for (let i = 0; i < referenced.length;) {
    const header = referenced[i];
    // Fabric writes one newline after a header and two between sections.
    const afterHeader = header.index! + header[0].length;
    const start = data[afterHeader] === "\n" ? afterHeader + 1 : afterHeader;
    const chars = Number(header[2]); // Fabric counts UTF-16 code units.
    if (!Number.isSafeInteger(chars)) return undefined;
    const boundaryAt = (end: number): number | undefined => {
      if (end === data.length) return referenced.length;
      if (end > data.length) return undefined;
      const separator = data.slice(end, end + 4) === "\r\n\r\n" ? 4
        : data.slice(end, end + 2) === "\n\n" ? 2 : 0;
      const following = separator ? headerAt.get(end + separator) : undefined;
      return following !== undefined && following > i ? following : undefined;
    };
    let end = start + chars, nextIndex = boundaryAt(end);
    if (nextIndex === undefined) {
      // Fabric may shorten a section but retain its original length in the
      // header. Its omission marker gives the exact rendered length. Never
      // guess a boundary from the next header-looking line inside the body.
      const candidates = new Map<number, number>();
      const marker = /…\[(\d+) chars omitted\]…/g;
      marker.lastIndex = start;
      const limit = Math.min(data.length, start + chars);
      for (let match = marker.exec(data); match && match.index < limit; match = marker.exec(data)) {
        const omitted = Number(match[1]);
        if (!Number.isSafeInteger(omitted) || omitted <= 0 || omitted > chars) continue;
        const candidate = start + chars - omitted + match[0].length;
        if (candidate < match.index + match[0].length || candidate > limit) continue;
        const following = boundaryAt(candidate);
        if (following !== undefined) candidates.set(candidate, following);
        if (candidates.size > 1) return undefined;
      }
      if (candidates.size !== 1) return undefined;
      [end, nextIndex] = [...candidates][0];
    }
    sections.push({ name: header[1], chars, text: data.slice(start, end) });
    i = nextIndex;
  }
  // A missing advertised section or duplicate selected name is ambiguous.
  const advertised = outline.split("<multi-line string, see section: ").length - 1;
  if (sections.length !== advertised || new Set(sections.map((section) => section.name)).size !== sections.length) return undefined;
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
  // Pointer lines only repeat section names, which the section heads carry.
  const candidates = parsed.outline.split(/\r?\n/).map((line, i) => ({ line, number: i + 1 }))
    .filter(({ line }) => line.trim() && line.length <= 240 && !line.includes('"<multi-line string, see section: '));
  const priority = (line: string): number => {
    const depth = line.length - line.trimStart().length;
    return /^(?:- )?(?:ok|success|status|exitCode|path|output|count|error):/.test(line.trimStart()) ? depth - 1000 : depth;
  };
  candidates.sort((a, b) => priority(a.line) - priority(b.line));
  const count = parsed.sections.length;
  const shown = parsed.sections.slice(0, 24);
  const fixed = [
    `Fabric sectioned result, ${count} section${count === 1 ? "" : "s"}; read one with ctx_read section:`,
    ...linesWithin(candidates.slice(0, 32).map(({ line, number }) => `${number}: ${line}`), Math.floor(limit * 0.35)),
  ];
  const titles = shown.map((section) => `Section ${JSON.stringify(section.name)} (${section.chars} chars):`);
  const more = count > shown.length ? [`... ${count - shown.length} more sections`] : [];
  const heads = shown.map((section) => section.text.split(/\r?\n/, MAX_HEAD_LINES * 4)
    .filter((line) => line.trim()).slice(0, MAX_HEAD_LINES).map((line) => clipLine(line)));
  const counts = fillRoundRobin(byteLines([...fixed, ...titles, ...more]), heads, limit);
  const text = [...fixed, ...shown.flatMap((_, i) => [titles[i], ...heads[i].slice(0, counts[i])]), ...more].join("\n");
  return fitUtf8(text, limit);
}

interface OutlineRow { line: string; offset: number }

interface OutlinePart {
  label: string;
  offset: number;
  end: number;
  /** Bytes of the header line that opens the part; 0 when the label is not a payload line. */
  headerBytes: number;
  rows: OutlineRow[];
}

/** The header family of a line that opens a part, such as "=====" for "===== src/a.ts =====". */
function headerFamily(line: string, markdown: boolean): string | undefined {
  if (line.length > 240) return undefined;
  if (line.startsWith("diff --git ")) return "diff";
  // Single-# lines are comments in shell and Python; deeper headings mark sections anywhere.
  if (/^#{2,6}\s+\S/.test(line) || (markdown && /^#\s+\S/.test(line))) return "#";
  const run = /^([=\-*~#])\1{2,}/.exec(line)?.[0];
  return run && /^\s*[^=\-*~#\s]/.test(line.slice(run.length)) ? run : undefined;
}

/** A `path:line:` or `path:line-` row of grep -n output. */
const GREP_ROW = /^([^\s:][^:]*?):\d+[:-]/;

/**
 * Split headed output into parts: runs of one file in grep output, or the
 * spans between repeated header lines (file separators, markdown headings,
 * `--- name ---` markers, diff headers). Families are taken in order of first
 * appearance, so outer structure wins when inner headings would crowd it out.
 */
function outlineParts(data: string, totalBytes: number, contentType: PreviewContentType, maxParts: number): OutlinePart[] | undefined {
  const scanned = totalBytes > OUTLINE_SCAN_BYTES ? utf8Prefix(data, OUTLINE_SCAN_BYTES) : data;
  const rows: OutlineRow[] = [];
  let offset = 0;
  for (const line of scanned.split("\n")) {
    rows.push({ line: line.endsWith("\r") ? line.slice(0, -1) : line, offset });
    offset += Buffer.byteLength(line, "utf8") + 1;
  }
  const filled = rows.filter((row) => row.line.trim()).length;
  const parts: OutlinePart[] = [];
  if (filled >= 4 && rows.filter((row) => GREP_ROW.test(row.line)).length >= filled * 0.6) {
    for (const row of rows) {
      const file = GREP_ROW.exec(row.line)?.[1];
      const current = parts.at(-1);
      if (file !== undefined && file !== current?.label) parts.push({ label: file, offset: row.offset, end: totalBytes, headerBytes: 0, rows: [row] });
      else current?.rows.push(row);
    }
  } else {
    const families = new Map<string, number[]>();
    rows.forEach((row, index) => {
      const family = headerFamily(row.line, contentType !== "code");
      if (family) families.set(family, [...(families.get(family) ?? []), index]);
    });
    const headers: number[] = [];
    for (const indices of [...families.values()].filter((indices) => indices.length >= 2).sort((a, b) => a[0] - b[0])) {
      if (headers.length > 0 && headers.length + indices.length > maxParts) break;
      headers.push(...indices);
    }
    headers.sort((a, b) => a - b);
    if (headers.length > 0 && rows.slice(0, headers[0]).some((row) => row.line.trim())) {
      parts.push({ label: "(before the first header)", offset: 0, end: totalBytes, headerBytes: 0, rows: rows.slice(0, headers[0]) });
    }
    headers.forEach((index, i) => parts.push({
      label: rows[index].line.trim(),
      offset: rows[index].offset,
      end: totalBytes,
      headerBytes: Buffer.byteLength(rows[index].line, "utf8") + 1,
      rows: rows.slice(index + 1, headers[i + 1] ?? rows.length),
    }));
  }
  for (let i = 0; i + 1 < parts.length; i++) parts[i].end = parts[i + 1].offset;
  // One dominant part is better served by the payload's head and tail.
  if (parts.length < 2 || parts.some((part) => part.end - part.offset > totalBytes * 0.9)) return undefined;
  return parts;
}

/** Every part's label, offset and size, then first lines for each part in turn while they fit. */
function outlinePreview(data: string, limit: number, contentType: PreviewContentType, totalBytes: number): Preview | undefined {
  const parts = outlineParts(data, totalBytes, contentType, Math.max(4, Math.floor(limit / 64)));
  if (!parts) return undefined;
  const scanned = totalBytes > OUTLINE_SCAN_BYTES ? ` in the first ${OUTLINE_SCAN_BYTES} bytes` : "";
  const title = `${contentType === "code" ? "Code" : "Text"} outline, ${parts.length} parts${scanned} of ${totalBytes} bytes; each offset starts a ctx_read range:`;
  const labels = parts.map((part) => `${clipLine(part.label)}  [offset ${part.offset}, ${part.end - part.offset} bytes]`);
  // Shown rows per part; a clipped row ends its part's list and is re-read in full.
  const heads = parts.map((part) => {
    const rows: Array<{ text: string; end: number }> = [];
    for (const row of part.rows) {
      if (rows.length >= MAX_HEAD_LINES) break;
      if (!row.line.trim()) continue;
      const text = clipLine(row.line);
      rows.push({ text, end: text === row.line ? row.offset + Buffer.byteLength(row.line, "utf8") + 1 : row.offset });
      if (text !== row.line) break;
    }
    return rows;
  });
  let shownParts = parts.length;
  const moreLine = (shown: number): string[] =>
    shown < parts.length ? [`... ${parts.length - shown} more parts, the next at offset ${parts[shown].offset}`] : [];
  // When even the labels overflow, list as many as fit.
  while (shownParts > 1 && byteLines([title, ...labels.slice(0, shownParts), ...moreLine(shownParts)]) > limit) shownParts--;
  const counts = fillRoundRobin(
    byteLines([title, ...labels.slice(0, shownParts), ...moreLine(shownParts)]),
    heads.slice(0, shownParts).map((rows) => rows.map((row) => row.text)),
    limit,
  );
  let readFrom: number | undefined;
  for (let i = 0; i < shownParts && readFrom === undefined; i++) {
    const shownEnd = Math.min(parts[i].end, counts[i] ? heads[i][counts[i] - 1].end : parts[i].offset + parts[i].headerBytes);
    if (shownEnd < parts[i].end) readFrom = shownEnd;
  }
  const text = [
    title,
    ...labels.slice(0, shownParts).flatMap((label, i) => [label, ...heads[i].slice(0, counts[i]).map((row) => row.text)]),
    ...moreLine(shownParts),
  ].join("\n");
  return { text: fitUtf8(text, limit), ...(readFrom !== undefined ? { readFrom } : {}) };
}

/** The payload's first and last lines, with the byte ranges shown and omitted. */
function headTailPreview(data: string, limit: number, contentType: PreviewContentType, totalBytes: number): Preview {
  const buffer = Buffer.from(data, "utf8");
  const label = contentType === "code" ? "Code" : "Text";
  const describe = (headEnd: number, tailStart: number): string =>
    `${label} preview, bytes 0-${headEnd} and ${tailStart}-${totalBytes} of ${totalBytes}:\n`;
  const marker = (headEnd: number, tailStart: number): string => `... [bytes ${headEnd}-${tailStart} omitted]\n`;
  const available = Math.max(0, limit - Buffer.byteLength(describe(totalBytes, totalBytes) + "\n" + marker(totalBytes, totalBytes), "utf8"));
  // Cut at line ends when one is near, so a range read resumes at a line start.
  let headEnd = Math.floor(available * 0.62);
  const lastBreak = buffer.lastIndexOf(0x0a, headEnd - 1);
  if (lastBreak >= 0 && lastBreak + 1 >= headEnd * 0.7) headEnd = lastBreak + 1;
  else while (headEnd > 0 && isContinuationByte(buffer[headEnd])) headEnd--;
  const tailBudget = Math.max(0, available - headEnd);
  let tailStart = totalBytes - tailBudget;
  const firstBreak = buffer.indexOf(0x0a, tailStart);
  if (firstBreak >= 0 && firstBreak + 1 - tailStart <= tailBudget * 0.3) tailStart = firstBreak + 1;
  else while (tailStart < totalBytes && isContinuationByte(buffer[tailStart])) tailStart++;
  tailStart = Math.max(headEnd, tailStart);
  const head = buffer.subarray(0, headEnd).toString("utf8");
  const text = describe(headEnd, tailStart) + head + (head.endsWith("\n") ? "" : "\n") +
    marker(headEnd, tailStart) + buffer.subarray(tailStart).toString("utf8");
  return { text: fitUtf8(text, limit), readFrom: headEnd };
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

/**
 * Build a bounded shape-oriented preview without exposing the full payload.
 * readFrom is set when the preview shows a prefix, so the notice can offer a
 * range read that starts after it instead of re-reading it.
 */
export function buildPreview(
  data: string,
  maxBytes = 2048,
  contentType: PreviewContentType = inferContentType(data),
): Preview {
  const limit = Math.max(256, Math.floor(maxBytes));
  const trimmed = data.trim();
  const wantsJson = contentType === "json" || (contentType === "unknown" && inferContentType(trimmed) === "json");
  if (wantsJson) {
    try {
      return { text: fitUtf8(jsonStructuralPreview(JSON.parse(trimmed)), limit) };
    } catch {
      // A stale content-type marker should not make the handle unreadable.
    }
  }

  const totalBytes = Buffer.byteLength(data, "utf8");
  if (totalBytes <= limit) return { text: data };
  const sections = fabricSectionPreview(data, limit);
  if (sections) return { text: sections };
  return outlinePreview(data, limit, contentType, totalBytes) ?? headTailPreview(data, limit, contentType, totalBytes);
}

export function structuralPreview(
  data: string,
  maxBytes = 2048,
  contentType: PreviewContentType = inferContentType(data),
): string {
  return buildPreview(data, maxBytes, contentType).text;
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
