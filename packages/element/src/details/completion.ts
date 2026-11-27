import { extensionMethodNames, parseExpressionSource } from '@draflow/core';
import { fieldPath, itemAccessor, mappingRoot, type Mapping } from './mapping.js';

export interface CompletionData {
  input?: Mapping['input'];
  names(): readonly string[];
  json(name?: string): unknown;
}
export interface Suggestion { label: string; insert: string; start: number; end: number }

// Locate the last data reference inside the current template expression. Skip
// quoted text and comments, including template delimiters inside either one.
function reference(prefix: string) {
  let inside = false, depth = 0, root = -1;
  for (let i = 1; i < prefix.length;) {
    if (!inside) {
      i = prefix.indexOf('{{', i);
      if (i < 0) break;
      i += 2; inside = true; depth = 0; root = i;
      continue;
    }
    const ch = prefix[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      for (i++; i < prefix.length && prefix[i] !== quote; i++) if (prefix[i] === '\\') i++;
      i++;
    } else if (prefix.startsWith('//', i) || prefix.startsWith('/*', i)) {
      const line = prefix[i + 1] === '/';
      const end = prefix.indexOf(line ? '\n' : '*/', i + 2);
      if (end < 0) return;
      i = end + (line ? 1 : 2); root = i;
    } else if (!depth && prefix.startsWith('}}', i)) {
      inside = false; i += 2;
    } else {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      if (ch === '$' && !/[\w$.]/.test(prefix[i - 1] ?? '') && !prefix.startsWith('$itemIndex', i)) root = i;
      i++;
    }
  }
  if (!inside) return;
  const raw = prefix.slice(root);
  return { text: raw.trimStart(), start: root + raw.length - raw.trimStart().length };
}

const quoted = String.raw`(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")`;
const receiver = new RegExp('^(\\$json|\\$input|\\$\\(\\s*(' + quoted + ')\\s*\\))');
const segment = new RegExp('^(?:\\.([\\w$]+)|\\[(' + quoted + '|\\d+)\\])');

function literal(source: string) {
  const ast = parseExpressionSource(source);
  return ast.type === 'Literal' ? String(ast.value) : '';
}

// Consume the remainder of the current quoted token when editing in its middle.
function quotedEnd(after: string, quote: string, closer: string) {
  if (!quote) return after.startsWith(closer) ? 1 : 0;
  for (let i = 0; i < after.length; i++) {
    if (after[i] === '\\') { i++; continue; }
    if (after[i] === quote) return after[i + 1] === closer ? i + 2 : 0;
  }
  return 0;
}

export function complete(source: string, cursor: number, data: CompletionData): Suggestion[] {
  if (!source.startsWith('=')) return [];
  const ref = reference(source.slice(0, cursor));
  if (!ref) return [];
  const { text, start } = ref;
  const after = source.slice(cursor);
  const results: Suggestion[] = [];
  const root = mappingRoot(undefined, data.input);
  const ancestorPrefix = /^\$\(\s*(['"]?)([^'"]*)$/u.exec(text);
  if (/^\$[\w]*$/.test(text) || !text || ancestorPrefix) {
    let end = cursor + (ancestorPrefix ? quotedEnd(after, ancestorPrefix[1]!, ')') : /^[\w$]*/.exec(after)![0].length);
    const accessor = itemAccessor(data.input);
    if (ancestorPrefix && source.startsWith(accessor, end)) end += accessor.length;
    if (!ancestorPrefix && '$json'.startsWith(text)) results.push({ label: '$json', insert: root, start, end });
    if (!ancestorPrefix && text && text !== '$') return results;
    for (const name of data.names()) {
      const insert = mappingRoot(name, data.input);
      if (ancestorPrefix ? name.toLowerCase().startsWith(ancestorPrefix[2]!.toLowerCase()) : insert.startsWith(text)) {
        results.push({ label: name, insert, start, end });
        if (results.length === 20) break;
      }
    }
    return results;
  }

  const base = receiver.exec(text);
  if (!base) return [];
  try {
    const name = base[2] ? literal(base[2]) : undefined;
    let tail = text.slice(base[0].length);
    if (base[0] !== '$json') {
      const accessor = itemAccessor(data.input);
      if (!tail.startsWith(accessor)) return [];
      tail = tail.slice(accessor.length);
    }
    // Strip complete path segments before the partial token at the caret.
    const partial = /(?:\.([\w$]*)|\[(['"]?)([^'"\]\\]*))$/.exec(tail);
    if (!partial) return [];
    let value = data.json(name);
    let path = tail.slice(0, partial.index);
    while (path) {
      const step = segment.exec(path);
      if (!step || value === null || typeof value !== 'object') return [];
      const key = step[1] ?? literal(step[2]!);
      if (!Object.hasOwn(value, key)) return [];
      value = (value as Record<string, unknown>)[key];
      path = path.slice(step[0].length);
    }
    const query = (partial[1] ?? partial[3] ?? '').toLowerCase();
    const from = cursor - partial[0].length;
    let end = cursor;
    if (partial[1] !== undefined) end += /^[\w$]*/.exec(after)![0].length;
    else if (partial[2]) end += quotedEnd(after, partial[2], ']');
    else end += /^\d*(?:\s*\])?/.exec(after)![0].length;
    if (value !== null && typeof value === 'object') {
      for (const key in value) {
        if (!Object.hasOwn(value, key) || ['constructor','prototype','__proto__'].includes(key) || !key.toLowerCase().startsWith(query)) continue;
        const property = fieldPath([Array.isArray(value) ? Number(key) : key]);
        results.push({ label: key, insert: property.startsWith('[') ? property : '.' + property, start: from, end });
        if (results.length === 20) break;
      }
    }
    if (results.length < 20 && partial[1] !== undefined) for (const method of extensionMethodNames(value)) {
      if (!method.toLowerCase().startsWith(query)) continue;
      results.push({ label: method + '()', insert: '.' + method + (source.startsWith('(', end) ? '' : '()'), start: from, end });
      if (results.length === 20) break;
    }
  } catch { /* An incomplete reference has no suggestions. */ }
  if (base[0] === '$json' && data.input) {
    for (const match of results) {
      match.insert = root + source.slice(start + base[0].length, match.start) + match.insert;
      match.start = start;
    }
  }
  return results;
}
