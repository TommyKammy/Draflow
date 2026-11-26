import { WorkflowValidationError } from './errors.js';
import type { NodeRegistry } from './registry.js';
import type { Connection, ValidationIssue, ValidationResult, Workflow, WorkflowNode } from './types.js';
import { isParameterVisible } from './parameters.js';

export function validateWorkflow(
  workflow: Workflow,
  registry?: NodeRegistry,
): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (workflow.schema !== 'draflow/v1') {
    issues.push({
      severity: 'error',
      code: 'SCHEMA_VERSION',
      message: `Unsupported workflow schema "${String(workflow.schema)}"`,
      path: 'schema',
    });
  }

  const ids = new Set<string>();
  const names = new Set<string>();

  for (const node of workflow.nodes) {
    if (ids.has(node.id)) {
      issues.push({
        severity: 'error',
        code: 'DUPLICATE_NODE_ID',
        message: `Duplicate node id "${node.id}"`,
        nodeId: node.id,
      });
    }
    ids.add(node.id);

    if (names.has(node.name)) {
      issues.push({
        severity: 'error',
        code: 'DUPLICATE_NODE_NAME',
        message: `Duplicate node name "${node.name}"`,
        nodeId: node.id,
        path: 'name',
      });
    }
    names.add(node.name);

    const nodeType = registry?.get(node.type, node.typeVersion);
    if (registry !== undefined && nodeType === undefined) {
      issues.push({
        severity: 'error',
        code: 'NODE_TYPE_NOT_FOUND',
        message: `Node type "${node.type}" (version ${node.typeVersion}) is not registered`,
        nodeId: node.id,
        path: 'type',
      });
      continue;
    }

    if (nodeType !== undefined) {
      for (const parameter of nodeType.parameters) {
        if (parameter.required !== true) continue;
        if (!isParameterVisible(parameter, node, nodeType)) continue;
        const value = node.parameters[parameter.name];
        if (value === undefined || value === null || value === '') {
          issues.push({
            severity: 'warning',
            code: 'REQUIRED_PARAMETER_MISSING',
            message: `Required parameter "${parameter.name}" is empty`,
            nodeId: node.id,
            path: `parameters.${parameter.name}`,
          });
        }
      }
    }
  }

  for (const connection of workflow.connections) {
    validateConnection(connection, workflow, registry, issues);
  }

  return { ok: !issues.some((issue) => issue.severity === 'error'), issues };
}

function validateConnection(
  connection: Connection,
  workflow: Workflow,
  registry: NodeRegistry | undefined,
  issues: ValidationIssue[],
): void {
  const from = workflow.nodes.find((node) => node.id === connection.from.node);
  const to = workflow.nodes.find((node) => node.id === connection.to.node);

  if (from === undefined) {
    issues.push({
      severity: 'error',
      code: 'CONNECTION_SOURCE_MISSING',
      message: `Connection "${connection.id}" starts at unknown node "${connection.from.node}"`,
      connectionId: connection.id,
    });
    return;
  }
  if (to === undefined) {
    issues.push({
      severity: 'error',
      code: 'CONNECTION_TARGET_MISSING',
      message: `Connection "${connection.id}" ends at unknown node "${connection.to.node}"`,
      connectionId: connection.id,
    });
    return;
  }

  if (connection.from.index < 0 || connection.to.index < 0) {
    issues.push({
      severity: 'error',
      code: 'CONNECTION_INDEX',
      message: `Connection "${connection.id}" has a negative port index`,
      connectionId: connection.id,
    });
  }

  if (registry === undefined) return;

  const fromType = registry.get(from.type, from.typeVersion);
  const toType = registry.get(to.type, to.typeVersion);

  if (fromType !== undefined) {
    const outputs = fromType.ports.outputs.filter((port) => port.type === connection.from.port);
    const dynamicErrorOutput =
      connection.from.port === 'error' && from.settings?.onError === 'errorOutput';

    if (outputs.length === 0 && !dynamicErrorOutput) {
      issues.push({
        severity: 'error',
        code: 'OUTPUT_PORT_MISSING',
        message: `Node "${from.name}" has no output port "${connection.from.port}"`,
        nodeId: from.id,
        connectionId: connection.id,
      });
    } else if (outputs.length > 0 && connection.from.index >= outputs.length) {
      issues.push({
        severity: 'error',
        code: 'OUTPUT_INDEX',
        message: `Node "${from.name}" has no output "${connection.from.port}[${connection.from.index}]"`,
        nodeId: from.id,
        connectionId: connection.id,
      });
    } else if (outputs.length === 0 && dynamicErrorOutput && connection.from.index !== 0) {
      issues.push({
        severity: 'error',
        code: 'OUTPUT_INDEX',
        message: `Node "${from.name}" has no output "${connection.from.port}[${connection.from.index}]"`,
        nodeId: from.id,
        connectionId: connection.id,
      });
    }
  }

  if (toType !== undefined) {
    const inputs = toType.ports.inputs.filter((port) => port.type === connection.to.port);
    if (inputs.length === 0) {
      issues.push({
        severity: 'error',
        code: 'INPUT_PORT_MISSING',
        message: `Node "${to.name}" has no input port "${connection.to.port}"`,
        nodeId: to.id,
        connectionId: connection.id,
      });
    } else if (connection.to.index >= inputs.length) {
      issues.push({
        severity: 'error',
        code: 'INPUT_INDEX',
        message: `Node "${to.name}" has no input "${connection.to.port}[${connection.to.index}]"`,
        nodeId: to.id,
        connectionId: connection.id,
      });
    }
  }
}

export function assertValidWorkflow(workflow: Workflow, registry?: NodeRegistry): void {
  const result = validateWorkflow(workflow, registry);
  if (!result.ok) {
    const message = result.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.message)
      .join('; ');
    throw new WorkflowValidationError(message || 'Workflow is invalid');
  }
}

export function isWorkflow(value: unknown): value is Workflow {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { schema?: unknown }).schema === 'draflow/v1'
  );
}

export function nodeById(workflow: Workflow, nodeId: string): WorkflowNode | undefined {
  return workflow.nodes.find((node) => node.id === nodeId);
}

export function nodeByName(workflow: Workflow, name: string): WorkflowNode | undefined {
  return workflow.nodes.find((node) => node.name === name);
}
