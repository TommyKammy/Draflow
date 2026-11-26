import type {
  ArrayExpr,
  ArrowExpr,
  BinaryExpr,
  CallExpr,
  ConditionalExpr,
  Expr,
  IdentifierExpr,
  LiteralExpr,
  LogicalExpr,
  MemberExpr,
  ObjectExpr,
  UnaryExpr,
} from './ast.js';
import { ExpressionSyntaxError } from '../errors.js';
import { tokenize, type Token } from './lexer.js';

export function parseExpressionSource(source: string): Expr {
  return new Parser(source).parse();
}

class Parser {
  readonly #source: string;
  readonly #tokens: Token[];
  #index = 0;

  constructor(source: string) {
    this.#source = source;
    this.#tokens = tokenize(source);
  }

  parse(): Expr {
    if (this.#peek().type === 'eof') {
      throw new ExpressionSyntaxError('Expression is empty', this.#source, 0);
    }
    const expression = this.#parseExpression();
    this.#expect('eof');
    return expression;
  }

  #peek(offset = 0): Token {
    return this.#tokens[this.#index + offset] ?? this.#tokens[this.#tokens.length - 1]!;
  }

  #next(): Token {
    const token = this.#peek();
    if (token.type !== 'eof') this.#index += 1;
    return token;
  }

  #atPunctuation(value: string): boolean {
    const token = this.#peek();
    return token.type === 'punct' && token.value === value;
  }

  #match(value: string): boolean {
    if (this.#atPunctuation(value)) {
      this.#next();
      return true;
    }
    return false;
  }

  #expect(value: string): Token {
    const token = this.#peek();
    if (value === 'eof') {
      if (token.type !== 'eof') {
        throw new ExpressionSyntaxError(
          `Expected end of expression but found ${describeToken(token)}`,
          this.#source,
          token.start,
        );
      }
      return this.#next();
    }
    if (token.type !== 'punct' || token.value !== value) {
      throw new ExpressionSyntaxError(
        `Expected "${value}" but found ${describeToken(token)}`,
        this.#source,
        token.start,
      );
    }
    return this.#next();
  }

  #expectIdentifier(): Token {
    const token = this.#peek();
    if (token.type !== 'identifier') {
      throw new ExpressionSyntaxError(
        `Expected an identifier but found ${describeToken(token)}`,
        this.#source,
        token.start,
      );
    }
    return this.#next();
  }

  #parseExpression(): Expr {
    return this.#parseConditional();
  }

  #parseConditional(): Expr {
    const test = this.#parseNullish();
    if (!this.#match('?')) return test;

    const consequent = this.#parseExpression();
    this.#expect(':');
    const alternate = this.#parseExpression();
    return {
      type: 'Conditional',
      test,
      consequent,
      alternate,
      start: test.start,
      end: alternate.end,
    } satisfies ConditionalExpr;
  }

  #parseNullish(): Expr {
    return this.#parseBinaryLevel(
      () => this.#parseOr(),
      new Set(['??']),
      (operator, left, right) => ({
        type: 'Logical',
        operator: operator as '??',
        left,
        right,
        start: left.start,
        end: right.end,
      }),
    );
  }

  #parseOr(): Expr {
    return this.#parseBinaryLevel(
      () => this.#parseAnd(),
      new Set(['||']),
      (operator, left, right) => ({
        type: 'Logical',
        operator: operator as '||',
        left,
        right,
        start: left.start,
        end: right.end,
      }),
    );
  }

  #parseAnd(): Expr {
    return this.#parseBinaryLevel(
      () => this.#parseEquality(),
      new Set(['&&']),
      (operator, left, right) => ({
        type: 'Logical',
        operator: operator as '&&',
        left,
        right,
        start: left.start,
        end: right.end,
      }),
    );
  }

  #parseEquality(): Expr {
    return this.#parseBinaryLevel(
      () => this.#parseRelational(),
      new Set(['==', '!=', '===', '!==']),
      binaryNode,
    );
  }

  #parseRelational(): Expr {
    let left = this.#parseAdditive();

    while (true) {
      const token = this.#peek();
      const operator = token.type === 'punct' ? token.value : '';
      if (operator === '<' || operator === '<=' || operator === '>' || operator === '>=') {
        this.#next();
        const right = this.#parseAdditive();
        left = binaryNode(operator, left, right);
        continue;
      }
      if (token.type === 'identifier' && token.value === 'in') {
        this.#next();
        const right = this.#parseAdditive();
        left = binaryNode('in', left, right);
        continue;
      }
      break;
    }

    return left;
  }

  #parseAdditive(): Expr {
    return this.#parseBinaryLevel(
      () => this.#parseMultiplicative(),
      new Set(['+', '-']),
      binaryNode,
    );
  }

  #parseMultiplicative(): Expr {
    return this.#parseBinaryLevel(
      () => this.#parseUnary(),
      new Set(['*', '/', '%']),
      binaryNode,
    );
  }

  #parseBinaryLevel(
    parseOperand: () => Expr,
    operators: Set<string>,
    build: (operator: string, left: Expr, right: Expr) => Expr,
  ): Expr {
    let left = parseOperand();
    while (true) {
      const token = this.#peek();
      if (token.type !== 'punct' || !operators.has(token.value)) break;
      const operator = this.#next().value;
      const right = parseOperand();
      left = build(operator, left, right);
    }
    return left;
  }

  #parseUnary(): Expr {
    const token = this.#peek();
    if (
      token.type === 'punct' &&
      (token.value === '!' || token.value === '-' || token.value === '+')
    ) {
      this.#next();
      const argument = this.#parseUnary();
      return {
        type: 'Unary',
        operator: token.value as '!' | '-' | '+',
        argument,
        start: token.start,
        end: argument.end,
      } satisfies UnaryExpr;
    }
    return this.#parsePostfix();
  }

  #parsePostfix(): Expr {
    let expression = this.#parsePrimary();

    while (true) {
      if (this.#match('.')) {
        const property = this.#expectIdentifier();
        expression = {
          type: 'Member',
          object: expression,
          property: identifierNode(property),
          computed: false,
          optional: false,
          start: expression.start,
          end: property.end,
        } satisfies MemberExpr;
        continue;
      }

      if (this.#match('?.')) {
        if (this.#match('(')) {
          const args = this.#parseArguments();
          const end = this.#previousEnd();
          expression = {
            type: 'Call',
            callee: expression,
            args,
            optional: true,
            start: expression.start,
            end,
          } satisfies CallExpr;
          continue;
        }
        if (this.#match('[')) {
          const property = this.#parseExpression();
          const close = this.#expect(']');
          expression = {
            type: 'Member',
            object: expression,
            property,
            computed: true,
            optional: true,
            start: expression.start,
            end: close.end,
          } satisfies MemberExpr;
          continue;
        }
        const property = this.#expectIdentifier();
        expression = {
          type: 'Member',
          object: expression,
          property: identifierNode(property),
          computed: false,
          optional: true,
          start: expression.start,
          end: property.end,
        } satisfies MemberExpr;
        continue;
      }

      if (this.#match('[')) {
        const property = this.#parseExpression();
        const close = this.#expect(']');
        expression = {
          type: 'Member',
          object: expression,
          property,
          computed: true,
          optional: false,
          start: expression.start,
          end: close.end,
        } satisfies MemberExpr;
        continue;
      }

      if (this.#match('(')) {
        const args = this.#parseArguments();
        expression = {
          type: 'Call',
          callee: expression,
          args,
          optional: false,
          start: expression.start,
          end: this.#previousEnd(),
        } satisfies CallExpr;
        continue;
      }

      break;
    }

    return expression;
  }

  #parseArguments(): Expr[] {
    const args: Expr[] = [];
    if (this.#match(')')) return args;
    while (true) {
      args.push(this.#parseExpression());
      if (this.#match(',')) {
        if (this.#atPunctuation(')')) break;
        continue;
      }
      break;
    }
    this.#expect(')');
    return args;
  }

  #parsePrimary(): Expr {
    const token = this.#peek();

    if (token.type === 'number') {
      this.#next();
      const value = token.value.startsWith('0x') || token.value.startsWith('0X')
        ? Number.parseInt(token.value.slice(2), 16)
        : Number(token.value);
      if (!Number.isFinite(value)) {
        throw new ExpressionSyntaxError(`Invalid number "${token.value}"`, this.#source, token.start);
      }
      return literalNode(value, token);
    }

    if (token.type === 'string') {
      this.#next();
      return literalNode(token.value, token);
    }

    if (token.type === 'identifier') {
      this.#next();
      switch (token.value) {
        case 'true':
          return literalNode(true, token);
        case 'false':
          return literalNode(false, token);
        case 'null':
          return literalNode(null, token);
        case 'undefined':
          return literalNode(undefined, token);
        default:
          break;
      }

      if (this.#atPunctuation('=>')) {
        this.#next();
        const body = this.#parseExpression();
        return {
          type: 'Arrow',
          params: [token.value],
          body,
          start: token.start,
          end: body.end,
        } satisfies ArrowExpr;
      }

      return identifierNode(token);
    }

    if (token.value === '(') {
      const arrow = this.#tryParseArrow();
      if (arrow !== undefined) return arrow;
      this.#next();
      const expression = this.#parseExpression();
      this.#expect(')');
      return expression;
    }

    if (token.value === '[') {
      return this.#parseArray();
    }

    if (token.value === '{') {
      return this.#parseObject();
    }

    throw new ExpressionSyntaxError(
      `Unexpected ${describeToken(token)}`,
      this.#source,
      token.start,
    );
  }

  #tryParseArrow(): ArrowExpr | undefined {
    const startIndex = this.#index;
    const startToken = this.#peek();
    this.#next();

    const params: string[] = [];
    if (!this.#atPunctuation(')')) {
      try {
        while (true) {
          const param = this.#expectIdentifier();
          params.push(param.value);
          if (this.#match(',')) {
            if (this.#atPunctuation(')')) break;
            continue;
          }
          break;
        }
      } catch {
        this.#index = startIndex;
        return undefined;
      }
    }

    if (!this.#atPunctuation(')')) {
      this.#index = startIndex;
      return undefined;
    }
    this.#next();

    if (!this.#atPunctuation('=>')) {
      this.#index = startIndex;
      return undefined;
    }
    this.#next();

    const body = this.#parseExpression();
    return {
      type: 'Arrow',
      params,
      body,
      start: startToken.start,
      end: body.end,
    } satisfies ArrowExpr;
  }

  #parseArray(): ArrayExpr {
    const start = this.#expect('[');
    const elements: Expr[] = [];
    if (this.#match(']')) {
      return { type: 'Array', elements, start: start.start, end: this.#previousEnd() };
    }

    while (true) {
      elements.push(this.#parseExpression());
      if (this.#match(',')) {
        if (this.#atPunctuation(']')) break;
        continue;
      }
      break;
    }

    const close = this.#expect(']');
    return { type: 'Array', elements, start: start.start, end: close.end };
  }

  #parseObject(): ObjectExpr {
    const start = this.#expect('{');
    const properties: ObjectExpr['properties'] = [];
    if (this.#match('}')) {
      return { type: 'Object', properties, start: start.start, end: this.#previousEnd() };
    }

    while (true) {
      const keyToken = this.#peek();
      let key: string;

      if (keyToken.type === 'identifier' || keyToken.type === 'string') {
        this.#next();
        key = keyToken.value;
      } else if (keyToken.type === 'number') {
        this.#next();
        key = keyToken.value;
      } else {
        throw new ExpressionSyntaxError(
          `Expected an object key but found ${describeToken(keyToken)}`,
          this.#source,
          keyToken.start,
        );
      }

      if (this.#match(':')) {
        const value = this.#parseExpression();
        properties.push({ key, value });
      } else {
        properties.push({ key, value: { type: 'Identifier', name: key, start: keyToken.start, end: keyToken.end } });
      }

      if (this.#match(',')) {
        if (this.#atPunctuation('}')) break;
        continue;
      }
      break;
    }

    const close = this.#expect('}');
    return { type: 'Object', properties, start: start.start, end: close.end };
  }

  #previousEnd(): number {
    return this.#tokens[Math.max(0, this.#index - 1)]?.end ?? 0;
  }
}

function literalNode(value: null | boolean | number | string | undefined, token: Token): LiteralExpr {
  return { type: 'Literal', value, start: token.start, end: token.end };
}

function identifierNode(token: Token): IdentifierExpr {
  return { type: 'Identifier', name: token.value, start: token.start, end: token.end };
}

function binaryNode(operator: string, left: Expr, right: Expr): BinaryExpr {
  return { type: 'Binary', operator, left, right, start: left.start, end: right.end };
}

function describeToken(token: Token): string {
  if (token.type === 'eof') return 'end of expression';
  if (token.type === 'string') return 'a string literal';
  return `"${token.value}"`;
}
