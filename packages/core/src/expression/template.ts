import { ExpressionSyntaxError } from '../errors.js';
import { stringifyUnknown } from '../utils.js';

export interface TemplateSegment {
  type: 'text' | 'expression';
  value: string;
  start: number;
  end: number;
}

export interface CompiledTemplate {
  /** The original parameter value, including the leading "=" when present. */
  source: string;
  expressionMode: boolean;
  segments: TemplateSegment[];
  typed: boolean;
  hasExpressions: boolean;
}

export function compileTemplate(value: string): CompiledTemplate {
  if (!value.startsWith('=')) {
    return {
      source: value,
      expressionMode: false,
      segments: [{ type: 'text', value, start: 0, end: value.length }],
      typed: false,
      hasExpressions: false,
    };
  }

  const raw = value.slice(1);
  const segments = splitTemplate(raw, value);
  const hasExpressions = segments.some((segment) => segment.type === 'expression');
  const typed =
    segments.length === 1 && segments[0]?.type === 'expression' && segments[0].value.trim() !== '';

  return {
    source: value,
    expressionMode: true,
    segments,
    typed,
    hasExpressions,
  };
}

export function evaluateTemplate(
  template: CompiledTemplate,
  evaluate: (expression: string) => unknown,
): unknown {
  if (!template.expressionMode) return template.source;

  if (!template.hasExpressions) {
    return template.segments.map((segment) => segment.value).join('');
  }

  if (template.typed) {
    const segment = template.segments[0];
    return segment === undefined ? undefined : evaluate(segment.value);
  }

  let output = '';
  for (const segment of template.segments) {
    output +=
      segment.type === 'text' ? segment.value : stringifyUnknown(evaluate(segment.value));
  }
  return output;
}

function splitTemplate(raw: string, source: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let index = 0;
  let textStart = 0;

  while (index < raw.length) {
    if (raw.startsWith('{{', index)) {
      if (index > textStart) {
        segments.push({
          type: 'text',
          value: raw.slice(textStart, index),
          start: textStart,
          end: index,
        });
      }

      const expression = readExpression(raw, index + 2, source);
      segments.push({
        type: 'expression',
        value: expression.value,
        start: index + 2,
        end: expression.end,
      });
      index = expression.end;
      textStart = expression.end;
      continue;
    }

    index += 1;
  }

  if (textStart < raw.length) {
    segments.push({
      type: 'text',
      value: raw.slice(textStart),
      start: textStart,
      end: raw.length,
    });
  }

  if (segments.length === 0) {
    segments.push({ type: 'text', value: '', start: 0, end: 0 });
  }

  return segments;
}

function readExpression(
  raw: string,
  start: number,
  source: string,
): { value: string; end: number } {
  let index = start;
  let depth = 0;
  let quote: string | null = null;

  while (index < raw.length) {
    const char = raw[index];
    if (char === undefined) break;

    if (quote !== null) {
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }

    if (char === '/' && raw[index + 1] === '/') {
      index += 2;
      while (index < raw.length && raw[index] !== '\n') index += 1;
      continue;
    }

    if (char === '/' && raw[index + 1] === '*') {
      const end = raw.indexOf('*/', index + 2);
      if (end === -1) {
        throw new ExpressionSyntaxError('Unterminated comment', source, index);
      }
      index = end + 2;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      index += 1;
      continue;
    }

    if (char === '{') {
      depth += 1;
      index += 1;
      continue;
    }

    if (char === '}') {
      if (depth > 0) {
        depth -= 1;
        index += 1;
        continue;
      }
      if (raw[index + 1] === '}') {
        return { value: raw.slice(start, index), end: index + 2 };
      }
      index += 1;
      continue;
    }

    index += 1;
  }

  throw new ExpressionSyntaxError('Unclosed "{{" expression', source, start);
}
