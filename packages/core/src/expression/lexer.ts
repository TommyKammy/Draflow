import { ExpressionSyntaxError } from '../errors.js';

export type TokenType = 'number' | 'string' | 'identifier' | 'punct' | 'eof';

export interface Token {
  type: TokenType;
  value: string;
  start: number;
  end: number;
}

const PUNCTUATORS = [
  '===',
  '!==',
  '??',
  '?.',
  '=>',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '+',
  '-',
  '*',
  '/',
  '%',
  '!',
  '<',
  '>',
  '=',
  '?',
  ':',
  '.',
  ',',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
] as const;

const SINGLE_CHAR_PUNCT = new Set(['+', '-', '*', '/', '%', '!', '<', '>', '=', '?', ':', '.', ',', '(', ')', '[', ']', '{', '}']);

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    if (char === undefined) break;

    if (isWhitespace(char)) {
      index += 1;
      continue;
    }

    if (char === '/' && source[index + 1] === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }

    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end === -1) throw new ExpressionSyntaxError('Unterminated comment', source, index);
      index = end + 2;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      const start = index;
      const decoded = readString(source, index, char);
      index = decoded.end;
      tokens.push({ type: 'string', value: decoded.value, start, end: index });
      continue;
    }

    if (isDigit(char) || (char === '.' && isDigit(source[index + 1] ?? ''))) {
      const start = index;
      index = readNumber(source, index);
      tokens.push({ type: 'number', value: source.slice(start, index), start, end: index });
      continue;
    }

    if (isIdentifierStart(char)) {
      const start = index;
      index += 1;
      while (index < source.length && isIdentifierPart(source[index] ?? '')) index += 1;
      tokens.push({ type: 'identifier', value: source.slice(start, index), start, end: index });
      continue;
    }

    const punct = PUNCTUATORS.find((candidate) => source.startsWith(candidate, index));
    if (punct !== undefined) {
      tokens.push({ type: 'punct', value: punct, start: index, end: index + punct.length });
      index += punct.length;
      continue;
    }

    if (SINGLE_CHAR_PUNCT.has(char)) {
      tokens.push({ type: 'punct', value: char, start: index, end: index + 1 });
      index += 1;
      continue;
    }

    throw new ExpressionSyntaxError(`Unexpected character "${char}"`, source, index);
  }

  tokens.push({ type: 'eof', value: 'eof', start: source.length, end: source.length });
  return tokens;
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v';
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function isIdentifierStart(char: string): boolean {
  return (
    (char >= 'a' && char <= 'z') ||
    (char >= 'A' && char <= 'Z') ||
    char === '_' ||
    char === '$'
  );
}

function isIdentifierPart(char: string): boolean {
  return isIdentifierStart(char) || isDigit(char);
}

function readNumber(source: string, start: number): number {
  let index = start;

  if (source[index] === '0' && (source[index + 1] === 'x' || source[index + 1] === 'X')) {
    index += 2;
    while (index < source.length && isHexDigit(source[index] ?? '')) index += 1;
    return index;
  }

  while (index < source.length && isDigit(source[index] ?? '')) index += 1;

  if (source[index] === '.') {
    index += 1;
    while (index < source.length && isDigit(source[index] ?? '')) index += 1;
  }

  if (source[index] === 'e' || source[index] === 'E') {
    const exponentStart = index;
    index += 1;
    if (source[index] === '+' || source[index] === '-') index += 1;
    let digits = 0;
    while (index < source.length && isDigit(source[index] ?? '')) {
      index += 1;
      digits += 1;
    }
    if (digits === 0) index = exponentStart;
  }

  return index;
}

function isHexDigit(char: string): boolean {
  return isDigit(char) || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F');
}

function readString(
  source: string,
  start: number,
  quote: "'" | '"' | '`',
): { value: string; end: number } {
  let index = start + 1;
  let value = '';

  while (index < source.length) {
    const char = source[index];
    if (char === undefined) break;

    if (char === quote) {
      return { value, end: index + 1 };
    }

    if (quote === '`' && char === '$' && source[index + 1] === '{') {
      throw new ExpressionSyntaxError(
        'Template literal interpolation is not supported. Use the outer {{ }} syntax instead.',
        source,
        index,
      );
    }

    if (char === '\\') {
      const escaped = readEscape(source, index);
      value += escaped.value;
      index = escaped.end;
      continue;
    }

    value += char;
    index += 1;
  }

  throw new ExpressionSyntaxError('Unterminated string literal', source, start);
}

function readEscape(source: string, start: number): { value: string; end: number } {
  const next = source[start + 1];
  if (next === undefined) {
    throw new ExpressionSyntaxError('Unterminated escape sequence', source, start);
  }

  switch (next) {
    case 'n':
      return { value: '\n', end: start + 2 };
    case 'r':
      return { value: '\r', end: start + 2 };
    case 't':
      return { value: '\t', end: start + 2 };
    case 'b':
      return { value: '\b', end: start + 2 };
    case 'f':
      return { value: '\f', end: start + 2 };
    case 'v':
      return { value: '\v', end: start + 2 };
    case '0':
      return { value: '\0', end: start + 2 };
    case '\\':
    case "'":
    case '"':
    case '`':
    case '/':
      return { value: next, end: start + 2 };
    case 'u': {
      const hex = source.slice(start + 2, start + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        throw new ExpressionSyntaxError('Invalid Unicode escape', source, start);
      }
      return { value: String.fromCharCode(Number.parseInt(hex, 16)), end: start + 6 };
    }
    case 'x': {
      const hex = source.slice(start + 2, start + 4);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        throw new ExpressionSyntaxError('Invalid hexadecimal escape', source, start);
      }
      return { value: String.fromCharCode(Number.parseInt(hex, 16)), end: start + 4 };
    }
    default:
      return { value: next, end: start + 2 };
  }
}
