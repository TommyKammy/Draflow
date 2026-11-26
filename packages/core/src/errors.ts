import type { JsonValue, SerializedError } from './types.js';

export class DraflowError extends Error {
  readonly code: string;
  readonly details: JsonValue | undefined;

  constructor(message: string, options: { code?: string; details?: JsonValue; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? 'DRAFLOW_ERROR';
    this.details = options.details;
  }
}

export class WorkflowValidationError extends DraflowError {
  constructor(message: string, details?: JsonValue) {
    super(message, { code: 'WORKFLOW_INVALID', ...(details === undefined ? {} : { details }) });
  }
}

export class NodeNotFoundError extends DraflowError {
  constructor(nodeId: string) {
    super(`Node "${nodeId}" does not exist in the workflow`, {
      code: 'NODE_NOT_FOUND',
      details: { nodeId },
    });
  }
}

export class NodeTypeNotFoundError extends DraflowError {
  constructor(type: string, version?: number) {
    super(
      version === undefined
        ? `Node type "${type}" is not registered`
        : `Node type "${type}" version ${version} is not registered`,
      { code: 'NODE_TYPE_NOT_FOUND', details: { type, version: version ?? null } },
    );
  }
}

export class NodeExecutionError extends DraflowError {
  readonly nodeId: string;

  constructor(nodeId: string, message: string, options: { cause?: unknown; details?: JsonValue } = {}) {
    super(message, {
      code: 'NODE_EXECUTION_FAILED',
      ...(options.details === undefined ? {} : { details: options.details }),
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.nodeId = nodeId;
  }
}

export class ExpressionError extends DraflowError {
  readonly expression: string;
  readonly position: number | undefined;

  constructor(
    message: string,
    options: { expression: string; position?: number; cause?: unknown; code?: string },
  ) {
    super(message, {
      code: options.code ?? 'EXPRESSION_ERROR',
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.expression = options.expression;
    this.position = options.position;
  }
}

export class ExpressionSyntaxError extends ExpressionError {
  constructor(message: string, expression: string, position?: number) {
    super(message, {
      expression,
      ...(position === undefined ? {} : { position }),
      code: 'EXPRESSION_SYNTAX',
    });
  }
}

export class ExpressionSecurityError extends ExpressionError {
  constructor(message: string, expression: string) {
    super(message, { expression, code: 'EXPRESSION_SECURITY' });
  }
}

export class ExpressionLimitError extends ExpressionError {
  constructor(message: string, expression: string) {
    super(message, { expression, code: 'EXPRESSION_LIMIT' });
  }
}

export class ExecutionCanceledError extends DraflowError {
  constructor() {
    super('Execution was canceled', { code: 'EXECUTION_CANCELED' });
  }
}

export class ExecutionTimeoutError extends DraflowError {
  constructor(timeout: number) {
    super(`Execution timed out after ${timeout} ms`, {
      code: 'EXECUTION_TIMEOUT',
      details: { timeout },
    });
  }
}

export class ExecutionLimitError extends DraflowError {
  constructor(message: string) {
    super(message, { code: 'EXECUTION_LIMIT' });
  }
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const serialized: SerializedError = {
      name: error.name,
      message: error.message,
    };
    if (error.stack !== undefined) serialized.stack = error.stack;
    if (error instanceof DraflowError) {
      serialized.code = error.code;
      if (error.details !== undefined) serialized.details = error.details;
    }
    return serialized;
  }

  return {
    name: 'Error',
    message: typeof error === 'string' ? error : String(error),
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
