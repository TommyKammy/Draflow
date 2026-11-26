import {
  ExecutionCanceledError,
  ExecutionLimitError,
  ExecutionTimeoutError,
  NodeNotFoundError,
  NodeTypeNotFoundError,
  WorkflowValidationError,
  serializeError,
} from './errors.js';
import { ExpressionEngine } from './expression/index.js';
import type { ExpressionContext } from './expression/context.js';
import { buildGraph, downstreamOf, hasPath, upstreamOf, type WorkflowGraph } from './graph.js';
import type {
  CredentialReader,
  FetchLike,
  Logger,
  NodeContext,
  NodeHelpers,
  NodeType,
  ItemContext,
  PortDef,
} from './node.js';
import { NodeRegistry, resolveNodeSettings } from './registry.js';
import type {
  Connection,
  ExecutionMode,
  Item,
  JsonObject,
  JsonValue,
  ParamValue,
  PortData,
  RunData,
  RunOptions,
  RunResult,
  RunStatus,
  SerializedError,
  SourceRef,
  TaskData,
  Workflow,
  WorkflowNode,
} from './types.js';
import { assertValidWorkflow } from './validate.js';
import { cloneJson, createId, isPlainObject, sleep as defaultSleep } from './utils.js';

export interface CredentialProvider {
  get(id: string): Promise<Record<string, string> | null>;
}

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface ExecutionLimits {
  maxNodeExecutions: number;
  maxItemsPerNode: number;
  executionTimeout: number;
}

export interface ExecutionEngineOptions {
  registry: NodeRegistry;
  expression?: ExpressionEngine;
  fetch?: FetchLike;
  clock?: Clock;
  random?: () => number;
  uuid?: () => string;
  credentials?: CredentialProvider;
  logger?: Logger;
  vars?: Record<string, JsonValue>;
  env?: Record<string, string>;
  limits?: Partial<ExecutionLimits>;
}

export interface EngineEvents {
  'run:start': {
    runId: string;
    workflowId: string;
    mode: ExecutionMode;
    startedAt: number;
  };
  'node:start': {
    runId: string;
    nodeId: string;
    nodeName: string;
    runIndex: number;
    itemCount: number;
  };
  'node:finish': {
    runId: string;
    nodeId: string;
    nodeName: string;
    runIndex: number;
    task: TaskData;
  };
  'run:finish': {
    runId: string;
    result: RunResult;
  };
}

export interface RunHandle {
  id: string;
  done: Promise<RunResult>;
  cancel(): void;
  on<K extends keyof EngineEvents>(event: K, handler: (payload: EngineEvents[K]) => void): () => void;
}

interface ExecEntry {
  nodeId: string;
  input: PortData;
  source: Array<SourceRef | null>;
  itemSources?: ItemSources;
  runIndex: number;
}

interface ItemSource {
  source: SourceRef;
  itemIndex: number;
}

type ItemSources = Record<string, Array<Array<ItemSource | null>>>;

const DEFAULT_LIMITS: ExecutionLimits = {
  maxNodeExecutions: 10_000,
  maxItemsPerNode: 10_000,
  executionTimeout: 300_000,
};

export class ExecutionEngine {
  readonly registry: NodeRegistry;
  readonly expression: ExpressionEngine;
  readonly #fetch: FetchLike;
  readonly #clock: Clock;
  readonly #random: () => number;
  readonly #uuid: () => string;
  readonly #credentials: CredentialProvider | undefined;
  readonly #logger: Logger;
  readonly #vars: Record<string, JsonValue>;
  readonly #env: Record<string, string>;
  readonly #limits: ExecutionLimits;

  constructor(options: ExecutionEngineOptions) {
    this.registry = options.registry;
    this.expression = options.expression ?? new ExpressionEngine();
    this.#fetch =
      options.fetch ??
      ((input, init) => {
        if (typeof fetch !== 'function') {
          return Promise.reject(new Error('No fetch implementation is available'));
        }
        return fetch(input, init);
      });
    this.#clock = options.clock ?? {
      now: () => Date.now(),
      sleep: (ms, signal) => defaultSleep(ms, signal),
    };
    this.#random = options.random ?? (() => Math.random());
    this.#uuid = options.uuid ?? (() => createId('run'));
    this.#credentials = options.credentials;
    this.#logger = options.logger ?? noopLogger;
    this.#vars = options.vars ?? {};
    this.#env = options.env ?? {};
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  run(workflow: Workflow, options: RunOptions = {}): RunHandle {
    assertValidWorkflow(workflow, this.registry);
    const graph = buildGraph(workflow);
    const runId = options.runId ?? this.#uuid();
    const startedAt = this.#clock.now();
    const bus = new EventBus();
    const controller = new AbortController();
    const mode: ExecutionMode = options.mode ?? 'manual';
    const externalSignal = options.signal;
    let removeExternalAbort: (() => void) | undefined;

    if (externalSignal !== undefined) {
      if (externalSignal.aborted) {
        controller.abort(new ExecutionCanceledError());
      } else {
        const onAbort = (): void => controller.abort(new ExecutionCanceledError());
        externalSignal.addEventListener('abort', onAbort, { once: true });
        removeExternalAbort = () => externalSignal.removeEventListener('abort', onAbort);
      }
    }

    const done = this.#execute(workflow, graph, options, {
      runId,
      startedAt,
      mode,
      controller,
      bus,
    });

    if (removeExternalAbort !== undefined) {
      const cleanup = removeExternalAbort;
      void done.then(
        () => cleanup(),
        () => cleanup(),
      );
    }

    return {
      id: runId,
      done,
      cancel: () => controller.abort(new ExecutionCanceledError()),
      on: <K extends keyof EngineEvents>(event: K, handler: (payload: EngineEvents[K]) => void) =>
        bus.on(event, handler as (payload: unknown) => void),
    };
  }

  async #execute(
    workflow: Workflow,
    graph: WorkflowGraph,
    options: RunOptions,
    run: {
      runId: string;
      startedAt: number;
      mode: ExecutionMode;
      controller: AbortController;
      bus: EventBus;
    },
  ): Promise<RunResult> {
    // Let callers attach event listeners before execution starts.
    await Promise.resolve();

    const timezone = workflow.settings.timezone ?? 'UTC';
    const timeout =
      workflow.settings.executionTimeout ?? this.#limits.executionTimeout;
    const maxItems = workflow.settings.maxItemsPerNode ?? this.#limits.maxItemsPerNode;
    const pinData = options.pinData ?? workflow.pinData ?? {};
    const runData: RunData = Object.create(null);
    const dirty = computeDirtySet(graph, options);
    const destination = options.destinationNodeId;
    const allowed =
      destination === undefined
        ? undefined
        : upstreamOf(graph, destination, {
            includeSelf: options.destinationMode !== 'exclusive',
          });

    if (destination !== undefined && !graph.nodes.has(destination)) {
      throw new NodeNotFoundError(destination);
    }

    const stack = buildStartStack(workflow, graph, options, allowed, this.registry);
    const waiting = new Map<string, ExecEntry>();
    const queued = new Set<ExecEntry>();
    const nextRunIndices = new Map<string, number>();
    const currentRunIndices = new Map<string, number>();
    const runItemSources = new Map<string, ItemSources>();
    for (const entry of stack) nextRunIndices.set(entry.nodeId, 1);
    let lastKey = '';
    let status: RunStatus = 'success';
    let error: SerializedError | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    run.bus.emit('run:start', {
      runId: run.runId,
      workflowId: workflow.id,
      mode: run.mode,
      startedAt: run.startedAt,
    });

    if (timeout > 0 && Number.isFinite(timeout)) {
      timeoutTimer = setTimeout(() => {
        run.controller.abort(new ExecutionTimeoutError(timeout));
      }, timeout);
    }

    try {
      for (const [nodeId, tasks] of Object.entries(options.runData ?? {})) {
        if (dirty.has(nodeId)) continue;
        for (const task of tasks) {
          const limitError = outputLimitError(graph.nodes.get(nodeId)?.name ?? nodeId, task.output, maxItems);
          if (limitError !== undefined) throw limitError;
        }
        runData[nodeId] = deepClone(tasks);
      }
      let executionIndex = nextExecutionIndex(runData);
      let executions = 0;

      while (true) {
        if (run.controller.signal.aborted) {
          status = 'canceled';
          error = serializeError(abortReason(run.controller.signal));
          break;
        }

        if (this.#clock.now() - run.startedAt > timeout) {
          run.controller.abort(new ExecutionTimeoutError(timeout));
          status = 'canceled';
          error = serializeError(new ExecutionTimeoutError(timeout));
          break;
        }

        if (stack.length === 0) {
          if (!promoteWaiting(waiting, queued, graph, this.registry, stack)) break;
        }

        const entry = stack.shift();
        if (entry === undefined) break;

        if (waiting.get(entry.nodeId) === entry) waiting.delete(entry.nodeId);
        queued.delete(entry);

        if (allowed !== undefined && !allowed.has(entry.nodeId)) continue;
        if (
          destination !== undefined &&
          options.destinationMode === 'exclusive' &&
          entry.nodeId === destination
        ) {
          continue;
        }

        const node = graph.nodes.get(entry.nodeId);
        if (node === undefined) throw new NodeNotFoundError(entry.nodeId);

        const key = `${entry.nodeId}:${entry.runIndex}`;
        if (key === lastKey) {
          throw new ExecutionLimitError(
            `Stopped execution because node "${node.name}" appears to be in an endless loop`,
          );
        }
        lastKey = key;

        executions += 1;
        if (executions > this.#limits.maxNodeExecutions) {
          throw new ExecutionLimitError(
            `Execution exceeded ${this.#limits.maxNodeExecutions} node executions`,
          );
        }

        const primary = primaryItems(entry.input);
        for (const [port, ports] of Object.entries(entry.input)) {
          ports.forEach((items, index) => {
            if (items !== null && items.length > maxItems) {
              throw new ExecutionLimitError(
                `Node "${node.name}" input ${port}[${index}] received ${items.length} items, above the limit of ${maxItems}`,
              );
            }
          });
        }

        const nodeType = this.registry.get(node.type, node.typeVersion);
        if (nodeType === undefined) throw new NodeTypeNotFoundError(node.type, node.typeVersion);

        const settings = resolveNodeSettings(node);

        const existing = runData[node.id]?.[entry.runIndex];
        if (
          existing !== undefined &&
          existing.status === 'success' &&
          options.runData !== undefined &&
          !dirty.has(node.id)
        ) {
          run.bus.emit('node:start', {
            runId: run.runId,
            nodeId: node.id,
            nodeName: node.name,
            runIndex: entry.runIndex,
            itemCount: primary.length,
          });
          run.bus.emit('node:finish', {
            runId: run.runId,
            nodeId: node.id,
            nodeName: node.name,
            runIndex: entry.runIndex,
            task: existing,
          });
          markCurrentRunIndex(currentRunIndices, node.id, entry.runIndex);
          if (entry.itemSources !== undefined) {
            runItemSources.set(`${node.id}:${entry.runIndex}`, entry.itemSources);
          }
          if (destination !== undefined && entry.nodeId === destination) break;
          this.#route(
            graph,
            node,
            existing.output ?? { main: [[]] },
            entry.runIndex,
            waiting,
            queued,
            stack,
            allowed,
            nextRunIndices,
          );
          continue;
        }

        run.bus.emit('node:start', {
          runId: run.runId,
          nodeId: node.id,
          nodeName: node.name,
          runIndex: entry.runIndex,
          itemCount: primary.length,
        });

        if (run.controller.signal.aborted) {
          status = 'canceled';
          error = serializeError(abortReason(run.controller.signal));
          break;
        }

        const task = await this.#runNode({
          workflow,
          graph,
          node,
          nodeType,
          entry,
          runData,
          pinData,
          mode: run.mode,
          runId: run.runId,
          timezone,
          startedAt: run.startedAt,
          signal: run.controller.signal,
          executionIndex,
          currentRunIndices,
          itemSourcesByRun: runItemSources,
        });
        const limitError = outputLimitError(node.name, task.output, maxItems);
        if (limitError !== undefined) {
          delete task.output;
          task.status = 'error';
          task.error = serializeError(limitError);
        }
        executionIndex += 1;

        if (task.status === 'success' || task.status === 'error') {
          const tasks = runData[node.id] ?? [];
          tasks[entry.runIndex] = task;
          runData[node.id] = tasks;
        }
        markCurrentRunIndex(currentRunIndices, node.id, entry.runIndex);
        if (entry.itemSources !== undefined) {
          runItemSources.set(`${node.id}:${entry.runIndex}`, entry.itemSources);
        }

        run.bus.emit('node:finish', {
          runId: run.runId,
          nodeId: node.id,
          nodeName: node.name,
          runIndex: entry.runIndex,
          task,
        });

        if (run.controller.signal.aborted) {
          status = 'canceled';
          error = serializeError(abortReason(run.controller.signal));
          break;
        }

        if (task.status === 'error' && (limitError !== undefined || settings.onError === 'stop')) {
          status = 'error';
          error = task.error;
          break;
        }

        const output = task.output ?? { main: [[]] };
        if (destination !== undefined && entry.nodeId === destination) break;
        this.#route(
          graph,
          node,
          output,
          entry.runIndex,
          waiting,
          queued,
          stack,
          allowed,
          nextRunIndices,
        );
      }
    } catch (caught) {
      if (run.controller.signal.aborted) {
        status = 'canceled';
        error = serializeError(abortReason(run.controller.signal));
      } else {
        status = 'error';
        error = serializeError(caught);
      }
    } finally {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    }

    const result: RunResult = {
      id: run.runId,
      workflowId: workflow.id,
      status,
      startedAt: run.startedAt,
      stoppedAt: this.#clock.now(),
      runData,
    };
    if (error !== undefined) result.error = error;
    run.bus.emit('run:finish', { runId: run.runId, result });
    return result;
  }

  async #runNode(input: {
    workflow: Workflow;
    graph: WorkflowGraph;
    node: WorkflowNode;
    nodeType: NodeType;
    entry: ExecEntry;
    runData: RunData;
    pinData: Record<string, Item[]>;
    mode: ExecutionMode;
    runId: string;
    timezone: string;
    startedAt: number;
    signal: AbortSignal;
    executionIndex: number;
    currentRunIndices: Map<string, number>;
    itemSourcesByRun: Map<string, ItemSources>;
  }): Promise<TaskData> {
    const { node, nodeType, entry, runData, pinData, graph, workflow } = input;
    const settings = resolveNodeSettings(node);
    const startTime = this.#clock.now();
    const stampedInput = stampInput(entry.input);

    if (settings.executeOnce && entry.runIndex > 0) {
      const previous = runData[node.id]?.[0];
      return {
        nodeId: node.id,
        runIndex: entry.runIndex,
        startTime,
        executionTime: 0,
        executionIndex: input.executionIndex,
        status: 'success',
        input: entry.input,
        output: previous?.output ?? { main: [primaryItems(stampedInput)] },
        ...(entry.source.length > 0 ? { source: entry.source } : {}),
        hints: [],
      };
    }

    if (node.disabled === true) {
      return {
        nodeId: node.id,
        runIndex: entry.runIndex,
        startTime,
        executionTime: 0,
        executionIndex: input.executionIndex,
        status: 'success',
        input: entry.input,
        output: { main: [primaryItems(stampedInput)] },
        ...(entry.source.length > 0 ? { source: entry.source } : {}),
        hints: [],
      };
    }

    const pinned = Object.hasOwn(pinData, node.id) ? pinData[node.id] : undefined;
    if (pinned !== undefined) {
      const output = normalizeOutput(pinned);
      return {
        nodeId: node.id,
        runIndex: entry.runIndex,
        startTime,
        executionTime: 0,
        executionIndex: input.executionIndex,
        status: 'success',
        input: entry.input,
        output,
        ...(entry.source.length > 0 ? { source: entry.source } : {}),
        hints: [],
      };
    }

    const context = this.#createContext({
      workflow,
      graph,
      node,
      nodeType,
      entry,
      input: entry.input,
      runData,
      mode: input.mode,
      runId: input.runId,
      timezone: input.timezone,
      startedAt: input.startedAt,
      signal: input.signal,
      pinData,
      currentRunIndices: input.currentRunIndices,
      itemSourcesByRun: input.itemSourcesByRun,
    });

    const execute = nodeType.execute;
    if (execute === undefined) {
      return {
        nodeId: node.id,
        runIndex: entry.runIndex,
        startTime,
        executionTime: this.#clock.now() - startTime,
        executionIndex: input.executionIndex,
        status: 'success',
        input: entry.input,
        output: { main: [primaryItems(stampedInput)] },
        ...(entry.source.length > 0 ? { source: entry.source } : {}),
        hints: [],
      };
    }

    let output: PortData | undefined;
    let caught: unknown;
    let failed = false;
    const maxTries = settings.retryOnFail ? settings.maxTries : 1;

    for (let attempt = 0; attempt < maxTries; attempt += 1) {
      if (attempt > 0) {
        try {
          await this.#clock.sleep(settings.waitBetweenTries, input.signal);
        } catch {
          failed = true;
          caught = new ExecutionCanceledError();
          break;
        }
      }

      try {
        const result = await raceWithAbort(
          Promise.resolve().then(() => {
            if (input.signal.aborted) throw abortReason(input.signal);
            return execute.call(nodeType, context);
          }),
          input.signal,
        );
        output = normalizeOutput(result);
        failed = false;
        caught = undefined;
        break;
      } catch (error) {
        failed = true;
        caught = error;
        if (input.signal.aborted) break;
      }
    }

    const executionTime = this.#clock.now() - startTime;

    if (failed) {
      const serialized = serializeError(caught);
      const errorItem: Item = {
        json: { error: serialized.message },
        error: serialized,
        pairedItem: { item: 0 },
      };

      if (settings.onError === 'errorOutput') {
        return {
          nodeId: node.id,
          runIndex: entry.runIndex,
          startTime,
          executionTime,
          executionIndex: input.executionIndex,
          status: 'error',
          input: entry.input,
          output: { main: [[]], error: [[errorItem]] },
          error: serialized,
          ...(entry.source.length > 0 ? { source: entry.source } : {}),
          hints: [],
        };
      }

      if (settings.onError === 'continue') {
        return {
          nodeId: node.id,
          runIndex: entry.runIndex,
          startTime,
          executionTime,
          executionIndex: input.executionIndex,
          status: 'error',
          input: entry.input,
          output: { main: [primaryItems(stampedInput)] },
          error: serialized,
          ...(entry.source.length > 0 ? { source: entry.source } : {}),
          hints: [],
        };
      }

      return {
        nodeId: node.id,
        runIndex: entry.runIndex,
        startTime,
        executionTime,
        executionIndex: input.executionIndex,
        status: 'error',
        input: entry.input,
        ...(output === undefined ? {} : { output }),
        error: serialized,
        ...(entry.source.length > 0 ? { source: entry.source } : {}),
        hints: [],
      };
    }

    const normalized = output ?? { main: [[]] };
    const withAlways = settings.alwaysOutputData
      ? ensureAlwaysOutputData(normalized, stampedInput)
      : normalized;

    return {
      nodeId: node.id,
      runIndex: entry.runIndex,
      startTime,
      executionTime,
      executionIndex: input.executionIndex,
      status: 'success',
      input: entry.input,
      output: addMissingPairing(withAlways, stampedInput),
      ...(entry.source.length > 0 ? { source: entry.source } : {}),
      hints: [],
    };
  }

  #createContext(input: {
    workflow: Workflow;
    graph: WorkflowGraph;
    node: WorkflowNode;
    nodeType: NodeType;
    entry: ExecEntry;
    input: PortData;
    runData: RunData;
    mode: ExecutionMode;
    runId: string;
    timezone: string;
    startedAt: number;
    signal: AbortSignal;
    pinData: Record<string, Item[]>;
    currentRunIndices: Map<string, number>;
    itemSourcesByRun: Map<string, ItemSources>;
  }): NodeContext {
    const { node, nodeType, entry, input: portData, runData, graph, workflow } = input;
    const items = primaryItems(portData);
    const engine = this;

    const makeExpressionContext = (itemIndex: number): ExpressionContext => {
      const item = items[itemIndex] ?? items[0] ?? { json: {} };
      const context: ExpressionContext = {
        item,
        itemIndex,
        runIndex: entry.runIndex,
        input: (port = 'main', index = 0) => portItems(portData, port, index),
        nodeOutput: (name, outputIndex = 0, runIndex) => {
          const target = graph.byName.get(name) ?? graph.nodes.get(name);
          if (target === undefined) throw new NodeNotFoundError(name);
          const tasks = runData[target.id];
          if (tasks === undefined) return [];
          const latestRunIndex = input.currentRunIndices.get(target.id);
          const task =
            runIndex === undefined
              ? tasks[latestRunIndex ?? tasks.length - 1]
              : tasks[runIndex];
          return task?.output?.['main']?.[outputIndex] ?? [];
        },
        resolveItem: (name) =>
          resolveItemLineage(name, itemIndex, entry, graph, runData, input.itemSourcesByRun),
        nodeNames: [...graph.byName.keys()],
        vars: engine.#vars,
        timezone: input.timezone,
        execution: { id: input.runId, mode: input.mode },
        workflow: { id: workflow.id, name: workflow.name },
        params: node.parameters,
        env: engine.#env,
        now: new Date(engine.#clock.now()),
      };
      return context;
    };

    const param = <T = ParamValue>(name: string, itemIndex = 0, fallback?: T): T => {
      const raw = node.parameters[name];
      if (raw === undefined) {
        const schema = nodeType.parameters.find((parameter) => parameter.name === name);
        if (schema?.default !== undefined) {
          return engine.expression.resolve(schema.default, makeExpressionContext(itemIndex)) as T;
        }
        return fallback as T;
      }
      return engine.expression.resolve(raw, makeExpressionContext(itemIndex)) as T;
    };

    const resolveValue = <T,>(value: T, itemIndex = 0): T =>
      engine.expression.resolve(value, makeExpressionContext(itemIndex)) as T;

    const context: NodeContext = {
      items,
      itemCount: items.length,
      runIndex: entry.runIndex,
      mode: input.mode,
      param,
      resolve: resolveValue,
      input: (port = 'main', index = 0) => portItems(portData, port, index),
      firstInput: (port = 'main', index = 0) => portItems(portData, port, index)[0],
      forItem: (index): ItemContext => ({
        item: items[index] ?? { json: {} },
        itemIndex: index,
        param: <T = ParamValue>(name: string, fallback?: T) => param<T>(name, index, fallback),
        resolve: <T,>(value: T) => resolveValue(value, index),
      }),
      each: async (fn) => {
        const snapshot = [...items];
        for (let index = 0; index < snapshot.length; index += 1) {
          const item = snapshot[index];
          if (item === undefined) continue;
          await fn(item, context.forItem(index), index);
        }
      },
      output: (value) => (Array.isArray(value) ? value : [value]),
      helpers: this.#helpers(input.signal),
      credentials: this.#credentialsFor(node),
      logger: this.#logger,
      signal: input.signal,
      vars: this.#vars,
      workflow: { id: workflow.id, name: workflow.name, timezone: input.timezone },
      execution: { id: input.runId, mode: input.mode, startedAt: input.startedAt },
    };

    return context;
  }

  #helpers(signal: AbortSignal): NodeHelpers {
    return {
      fetch: this.#fetch,
      now: () => this.#clock.now(),
      sleep: (ms, abort) => this.#clock.sleep(ms, abort ?? signal),
      random: this.#random,
      uuid: this.#uuid,
      hash: async (algo, data) => {
        const bytes =
          typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
        const digest = await crypto.subtle.digest(
          algo === 'sha1' ? 'SHA-1' : 'SHA-256',
          bytes,
        );
        return [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
      },
      base64Encode: (value) => {
        const bytes = new TextEncoder().encode(value);
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
      },
      base64Decode: (value) => {
        const binary = atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return new TextDecoder().decode(bytes);
      },
    };
  }

  #credentialsFor(node: WorkflowNode): CredentialReader {
    const provider = this.#credentials;
    return {
      get: async (slot) => {
        if (provider === undefined) return null;
        const id = node.credentials?.[slot];
        if (id === undefined) return null;
        return provider.get(id);
      },
    };
  }

  #route(
    graph: WorkflowGraph,
    node: WorkflowNode,
    output: PortData,
    runIndex: number,
    waiting: Map<string, ExecEntry>,
    queued: Set<ExecEntry>,
    stack: ExecEntry[],
    allowed: Set<string> | undefined,
    nextRunIndices: Map<string, number>,
  ): void {
    for (const connection of graph.outgoing.get(node.id) ?? []) {
      if (connection.from.port !== 'main' && connection.from.port !== 'error') continue;
      if (allowed !== undefined && !allowed.has(connection.to.node)) continue;

      const items = portItems(output, connection.from.port, connection.from.index);

      const target = graph.nodes.get(connection.to.node);
      if (target === undefined) continue;

      const targetType = this.registry.get(target.type, target.typeVersion);
      const inputCount = targetType?.ports.inputs.length ?? 0;
      const incomingCount = graph.incoming.get(target.id)?.length ?? 0;
      const synchronizes = inputCount > 1;

      if (items.length === 0 && !synchronizes) continue;

      let entry = waiting.get(target.id);
      if (entry === undefined) {
        const nextRunIndex = nextRunIndices.get(target.id) ?? 0;
        nextRunIndices.set(target.id, nextRunIndex + 1);
        entry = {
          nodeId: target.id,
          input: {},
          source: [],
          runIndex: nextRunIndex,
        };
        waiting.set(target.id, entry);
      }

      if (items.length > 0) {
        appendPortItems(entry.input, connection.to.port, connection.to.index, items);
        appendItemSources(
          entry,
          connection.to.port,
          connection.to.index,
          items.length,
          {
            node: node.id,
            port: connection.from.port,
            index: connection.from.index,
            runIndex,
          },
        );
      } else {
        const ports = (entry.input[connection.to.port] ??= []);
        ports[connection.to.index] ??= [];
      }

      entry.source[connection.to.index] = {
        node: node.id,
        port: connection.from.port,
        index: connection.from.index,
        runIndex,
      };

      if (incomingCount <= 1 && isReady(target, this.registry, entry.input)) {
        fillOptionalInputs(target, this.registry, entry.input);
        if (!queued.has(entry) && (allowed === undefined || allowed.has(target.id))) {
          queued.add(entry);
          stack.push(entry);
        }
      }
    }
  }
}

class EventBus {
  readonly #handlers = new Map<string, Set<(payload: unknown) => void>>();

  on(event: string, handler: (payload: unknown) => void): () => void {
    let handlers = this.#handlers.get(event);
    if (handlers === undefined) {
      handlers = new Set();
      this.#handlers.set(event, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
    };
  }

  emit(event: string, payload: unknown): void {
    for (const handler of this.#handlers.get(event) ?? []) {
      handler(payload);
    }
  }
}

function buildStartStack(
  workflow: Workflow,
  graph: WorkflowGraph,
  options: RunOptions,
  allowed: Set<string> | undefined,
  registry: NodeRegistry,
): ExecEntry[] {
  const triggerData = options.triggerData ?? { main: [[{ json: {} }]] };
  const startNodeId = options.startNodeId;

  if (startNodeId !== undefined) {
    const node = graph.nodes.get(startNodeId);
    if (node === undefined) throw new NodeNotFoundError(startNodeId);
    return [
      {
        nodeId: node.id,
        input: clonePortData(triggerData),
        source: [null],
        runIndex: 0,
      },
    ];
  }

  const candidates = graph.startNodes.filter((node) => {
    const nodeType = registry.get(node.type, node.typeVersion);
    if (nodeType === undefined) return true;
    return nodeType.ports.inputs.length === 0 || nodeType.meta.category === 'trigger';
  });

  const starts = (candidates.length > 0 ? candidates : graph.startNodes).filter(
    (node) => allowed === undefined || allowed.has(node.id),
  );

  if (starts.length === 0) {
    if (allowed !== undefined && allowed.size === 0) return [];
    throw new WorkflowValidationError('Workflow has no start node');
  }

  return starts.map((node) => ({
    nodeId: node.id,
    input: clonePortData(triggerData),
    source: [null],
    runIndex: 0,
  }));
}

function promoteWaiting(
  waiting: Map<string, ExecEntry>,
  queued: Set<ExecEntry>,
  graph: WorkflowGraph,
  registry: NodeRegistry,
  stack: ExecEntry[],
): boolean {
  if (waiting.size === 0) return false;
  // Drain the earliest ready join and its outgoing work before releasing later
  // joins. An intermediate node may not have received its first input yet.
  for (const nodeId of graph.topologicalOrder) {
    const entry = waiting.get(nodeId);
    const node = graph.nodes.get(nodeId);
    if (entry === undefined || node === undefined || !isReady(node, registry, entry.input)) continue;
    fillOptionalInputs(node, registry, entry.input);
    queued.add(entry);
    stack.push(entry);
    return true;
  }
  // Cycles and their descendants have no topological rank. Among runnable
  // joins, prefer a strict ancestor, keeping arrival order inside a cycle.
  let selected: ExecEntry | undefined;
  for (const entry of waiting.values()) {
    const node = graph.nodes.get(entry.nodeId);
    if (node === undefined || !isReady(node, registry, entry.input)) continue;
    if (
      selected === undefined ||
      (hasPath(graph, entry.nodeId, selected.nodeId) && !hasPath(graph, selected.nodeId, entry.nodeId))
    ) {
      selected = entry;
    }
  }
  if (selected === undefined) return false;
  fillOptionalInputs(graph.nodes.get(selected.nodeId)!, registry, selected.input);
  queued.add(selected);
  stack.push(selected);
  return true;
}

function isReady(node: WorkflowNode, registry: NodeRegistry, input: PortData): boolean {
  const nodeType = registry.get(node.type, node.typeVersion);
  if (nodeType === undefined) return false;

  for (const [type, definitions] of groupInputs(nodeType)) {
    for (let index = 0; index < definitions.length; index += 1) {
      const definition = definitions[index];
      const items = input[type]?.[index];
      if ((items === undefined || items === null) && definition?.required !== false) {
        return false;
      }
    }
  }
  return true;
}

function fillOptionalInputs(node: WorkflowNode, registry: NodeRegistry, input: PortData): void {
  const nodeType = registry.get(node.type, node.typeVersion);
  if (nodeType === undefined) return;

  for (const [type, definitions] of groupInputs(nodeType)) {
    const portData = (input[type] ??= []);
    for (let index = 0; index < definitions.length; index += 1) {
      if (portData[index] === undefined || portData[index] === null) {
        portData[index] = [];
      }
    }
  }
}

function groupInputs(nodeType: NodeType): Map<string, PortDef[]> {
  const groups = new Map<string, PortDef[]>();
  for (const port of nodeType.ports.inputs) {
    const definitions = groups.get(port.type) ?? [];
    definitions.push(port);
    groups.set(port.type, definitions);
  }
  return groups;
}

function appendPortItems(input: PortData, port: string, index: number, items: Item[]): void {
  const ports = (input[port] ??= []);
  const current = ports[index] ?? [];
  ports[index] = [...current, ...items];
}

function appendItemSources(
  entry: ExecEntry,
  port: string,
  index: number,
  count: number,
  source: SourceRef,
): void {
  const itemSources = (entry.itemSources ??= {});
  const portSources = (itemSources[port] ??= []);
  const sources = (portSources[index] ??= []);
  for (let itemIndex = 0; itemIndex < count; itemIndex += 1) {
    sources.push({ source, itemIndex });
  }
}

function primaryItems(input: PortData): Item[] {
  return portItems(input, 'main', 0);
}

function portItems(input: PortData, port: string, index: number): Item[] {
  return input[port]?.[index] ?? [];
}

function clonePortData(input: PortData): PortData {
  return deepClone(input);
}

function outputLimitError(
  nodeName: string,
  output: PortData | undefined,
  limit: number,
): ExecutionLimitError | undefined {
  if (output === undefined) return;
  let count = 0;
  for (const ports of Object.values(output)) {
    for (const items of ports) count += items?.length ?? 0;
  }
  if (count > limit) {
    return new ExecutionLimitError(
      `Node "${nodeName}" produced ${count} items, above the limit of ${limit}`,
    );
  }
  return undefined;
}

function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function stampInput(input: PortData): PortData {
  const result: PortData = {};
  for (const [port, ports] of Object.entries(input)) {
    result[port] = ports.map((items, portIndex) => {
      if (items === null) return null;
      return items.map((item, itemIndex) => ({
        ...item,
        pairedItem: { item: itemIndex, input: portIndex },
      }));
    });
  }
  return result;
}

function addMissingPairing(output: PortData, input: PortData): PortData {
  const count = primaryItems(input).length;
  const result: PortData = {};
  for (const [port, ports] of Object.entries(output)) {
    result[port] = ports.map((items) => {
      if (items === null) return null;
      return items.map((item, index) => {
        if (item.pairedItem !== undefined) return item;
        if (count === items.length) return { ...item, pairedItem: { item: index } };
        return item;
      });
    });
  }
  return result;
}

function normalizeOutput(output: unknown): PortData {
  if (output === undefined || output === null) return { main: [[]] };
  if (!Array.isArray(output)) {
    if (isPlainObject(output)) {
      if ('json' in output) return { main: [[output as unknown as Item]] };
      if (Object.values(output).some((value) => Array.isArray(value))) {
        return output as unknown as PortData;
      }
    }
    return { main: [[]] };
  }
  if (output.length === 0) return { main: [[]] };

  const first = output[0];
  if (Array.isArray(first)) {
    return {
      main: output.map((entry) => (Array.isArray(entry) ? entry : [entry as Item])),
    };
  }

  if (isItem(first)) return { main: [output as Item[]] };

  const ports: PortData = {};
  for (const [port, value] of Object.entries(output as unknown as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    ports[port] = value.map((entry) => (Array.isArray(entry) ? entry : [entry as Item]));
  }
  return ports;
}

function isItem(value: unknown): value is Item {
  return isPlainObject(value) && isPlainObject(value.json);
}

function ensureAlwaysOutputData(output: PortData, input: PortData): PortData {
  const main = output.main ?? [];
  const hasAnyOutput = main.some((items) => items !== null && items.length > 0);
  if (hasAnyOutput) return output;

  const paired: Array<{ item: number; input: number }> = [];
  for (const [port, ports] of Object.entries(input)) {
    ports.forEach((items, portIndex) => {
      if (items === null) return;
      items.forEach((_item, itemIndex) => {
        paired.push({ item: itemIndex, input: portIndex });
        void port;
      });
    });
  }

  const nextMain = main.length > 0 ? [...main] : [];
  nextMain[0] = [{ json: {}, pairedItem: paired }];
  return { ...output, main: nextMain };
}

function nextExecutionIndex(runData: RunData): number {
  let max = -1;
  for (const tasks of Object.values(runData)) {
    for (const task of tasks) max = Math.max(max, task.executionIndex);
  }
  return max + 1;
}

function markCurrentRunIndex(
  currentRunIndices: Map<string, number>,
  nodeId: string,
  runIndex: number,
): void {
  const current = currentRunIndices.get(nodeId);
  if (current === undefined || runIndex > current) {
    currentRunIndices.set(nodeId, runIndex);
  }
}

function computeDirtySet(graph: WorkflowGraph, options: RunOptions): Set<string> {
  const dirty = new Set<string>();
  for (const nodeId of options.dirtyNodeIds ?? []) {
    dirty.add(nodeId);
    for (const downstream of downstreamOf(graph, nodeId)) dirty.add(downstream);
  }
  return dirty;
}

const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new ExecutionCanceledError();
}

function resolveItemLineage(
  targetName: string,
  itemIndex: number,
  entry: ExecEntry,
  graph: WorkflowGraph,
  runData: RunData,
  itemSourcesByRun: Map<string, ItemSources>,
): Item | undefined {
  const target = graph.byName.get(targetName) ?? graph.nodes.get(targetName);
  if (target === undefined) return undefined;

  const itemSource = entry.itemSources?.['main']?.[0]?.[itemIndex];
  if (itemSource !== undefined && itemSource !== null) {
    const task = runData[itemSource.source.node]?.[itemSource.source.runIndex];
    const items = task?.output?.[itemSource.source.port]?.[itemSource.source.index] ?? [];
    const item = items[itemSource.itemIndex];
    if (item !== undefined) {
      return followLineage(
        item,
        itemSource.source,
        target.id,
        runData,
        itemSourcesByRun,
        0,
      );
    }
  }

  const source = entry.source[0] ?? null;
  if (source === null) return undefined;

  const task = runData[source.node]?.[source.runIndex];
  const items = task?.output?.[source.port]?.[source.index] ?? [];
  const item = items[itemIndex];
  if (item === undefined) return undefined;

  return followLineage(item, source, target.id, runData, itemSourcesByRun, 0);
}

function followLineage(
  item: Item,
  source: SourceRef | null,
  targetId: string,
  runData: RunData,
  itemSourcesByRun: Map<string, ItemSources>,
  depth: number,
): Item | undefined {
  if (source === null || depth > 64) return undefined;
  if (source.node === targetId) return item;

  const task = runData[source.node]?.[source.runIndex];
  if (task === undefined) return undefined;

  const pairings =
    item.pairedItem === undefined
      ? []
      : Array.isArray(item.pairedItem)
        ? item.pairedItem
        : [item.pairedItem];

  for (const pairing of pairings) {
    const inputIndex = pairing.input ?? 0;
    const taskSources = itemSourcesByRun.get(`${source.node}:${source.runIndex}`);
    const perItem = taskSources?.['main']?.[inputIndex]?.[pairing.item];
    if (perItem !== undefined && perItem !== null) {
      const nextTask = runData[perItem.source.node]?.[perItem.source.runIndex];
      const nextItems =
        nextTask?.output?.[perItem.source.port]?.[perItem.source.index] ?? [];
      const nextItem = nextItems[perItem.itemIndex];
      if (nextItem !== undefined) {
        const found = followLineage(
          nextItem,
          perItem.source,
          targetId,
          runData,
          itemSourcesByRun,
          depth + 1,
        );
        if (found !== undefined) return found;
      }
    }

    const inputItems = task.input?.main?.[inputIndex] ?? [];
    const nextItem = inputItems[pairing.item];
    if (nextItem === undefined) continue;

    const nextSource = task.source?.[inputIndex] ?? null;
    const found = followLineage(
      nextItem,
      nextSource,
      targetId,
      runData,
      itemSourcesByRun,
      depth + 1,
    );
    if (found !== undefined) return found;
  }

  return undefined;
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortReason(signal));
    };

    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}
