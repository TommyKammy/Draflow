import type { Expr } from './ast.js';
import type { ExpressionContext } from './context.js';
import { ExpressionError, ExpressionSyntaxError } from '../errors.js';
import { Evaluator } from './evaluator.js';
import { parseExpressionSource } from './parser.js';
import { createDataProxy } from './proxy.js';
import { compileTemplate, evaluateTemplate, type CompiledTemplate } from './template.js';
import { isPlainObject } from '../utils.js';

export interface ExpressionEngineOptions {
  timezone?: string;
  maxSteps?: number;
  maxDepth?: number;
}

export interface ExpressionIssue {
  message: string;
  source: string;
  position?: number;
}

interface CompiledEntry {
  template: CompiledTemplate;
  asts: Array<Expr | undefined>;
}

export class ExpressionEngine {
  readonly timezone: string;
  readonly #maxSteps: number;
  readonly #maxDepth: number;
  readonly #cache = new Map<string, CompiledEntry>();

  constructor(options: ExpressionEngineOptions = {}) {
    this.timezone = options.timezone ?? 'UTC';
    this.#maxSteps = options.maxSteps ?? 100_000;
    this.#maxDepth = options.maxDepth ?? 64;
  }

  /** Resolves a parameter value, including nested arrays and objects. */
  resolve(value: unknown, ctx: ExpressionContext): unknown {
    if (typeof value === 'string') return this.resolveString(value, ctx);
    if (Array.isArray(value)) return value.map((entry) => this.resolve(entry, ctx));
    if (isPlainObject(value)) {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        result[key] = this.resolve(entry, ctx);
      }
      return result;
    }
    return value;
  }

  resolveString(value: string, ctx: ExpressionContext): unknown {
    if (!value.startsWith('=')) return value;
    const entry = this.#compile(value);
    if (!entry.template.hasExpressions) {
      return entry.template.segments.map((segment) => segment.value).join('');
    }
    return evaluateTemplate(entry.template, (source) => {
      const index = entry.template.segments.findIndex(
        (segment) => segment.type === 'expression' && segment.value === source,
      );
      const ast = index >= 0 ? entry.asts[index] : undefined;
      if (ast === undefined) {
        throw new ExpressionSyntaxError('Expression segment was not compiled', value);
      }
      return this.#evaluateAst(ast, source, ctx);
    });
  }

  /** Evaluates a raw expression without the leading "=". */
  evaluate(expression: string, ctx: ExpressionContext): unknown {
    const ast = parseExpressionSource(expression);
    return this.#evaluateAst(ast, expression, ctx);
  }

  validate(value: string): ExpressionIssue[] {
    if (!value.startsWith('=')) return [];
    try {
      this.#compile(value);
      return [];
    } catch (error) {
      if (error instanceof ExpressionError) {
        const issue: ExpressionIssue = { message: error.message, source: value };
        if (error.position !== undefined) issue.position = error.position;
        return [issue];
      }
      return [{ message: error instanceof Error ? error.message : String(error), source: value }];
    }
  }

  #compile(value: string): CompiledEntry {
    const cached = this.#cache.get(value);
    if (cached !== undefined) return cached;

    const template = compileTemplate(value);
    const asts: Array<Expr | undefined> = template.segments.map((segment) =>
      segment.type === 'expression' ? parseExpressionSource(segment.value) : undefined,
    );
    const entry: CompiledEntry = { template, asts };
    this.#cache.set(value, entry);
    return entry;
  }

  #evaluateAst(ast: Expr, source: string, ctx: ExpressionContext): unknown {
    const data = createDataProxy({
      ...ctx,
      timezone: ctx.timezone ?? this.timezone,
    });
    const evaluator = new Evaluator({
      source,
      data,
      timezone: ctx.timezone ?? this.timezone,
      nowMillis: ctx.now?.getTime() ?? Date.now(),
      maxSteps: this.#maxSteps,
      maxDepth: this.#maxDepth,
    });
    return evaluator.evaluate(ast);
  }
}
