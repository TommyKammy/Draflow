import { compileTemplate, isUnsafeObjectKey, parseExpressionSource, type ParamValue, type WorkflowNode } from '@draflow/core';

type Expr = ReturnType<typeof parseExpressionSource>;
type Replacement = { start: number; end: number; text: string };

// Only rewrite literal node lookups. Ordinary strings and dynamically computed names are user data.
function rewriteExpression(source: string, names: ReadonlyMap<string, string>, lookups: ReadonlyMap<string, string>) {
  const patches: Replacement[] = [];
  const captures = new Map<string, string>();
  function visit(node: Expr, offset: number, locals: readonly string[]) {
    const global = (expr: Expr, name: string) =>
      expr.type === 'Identifier' && expr.name === name && !locals.includes(name);
    function literal(arg: Expr | undefined, replacements: ReadonlyMap<string, string>) {
      if (arg?.type !== 'Literal' || typeof arg.value !== 'string') return;
      const name = replacements.get(arg.value);
      if (name !== undefined && name !== arg.value) {
        patches.push({ start: offset + arg.start, end: offset + arg.end, text: JSON.stringify(name) });
      }
    }
    const child = (expr: Expr) => visit(expr, offset, locals);
    switch (node.type) {
      case 'Call': {
        const fn = node.callee;
        if (global(fn, '$') || global(fn, '$items')) literal(node.args[0], lookups);
        if (fn.type === 'Member' && global(fn.object, '$node') && memberName(fn) === 'has') literal(node.args[0], names);
        child(fn);
        node.args.forEach(child);
        break;
      }
      case 'Member': {
        const key = memberName(node);
        if (global(node.object, '$node') && key !== undefined && key !== 'keys' && key !== 'has') {
          const name = lookups.get(key);
          if (name !== undefined && name !== key) {
            const quoted = JSON.stringify(name);
            if (name === 'keys' || name === 'has' || isUnsafeObjectKey(name)) {
              // Some names are reserved for member access. The lookup function accepts them directly.
              let lookup = '$', suffix = '(' + quoted + ')';
              if (locals.includes('$')) {
                // Capture the node outside the shadowing arrow. Its literal lookup remains editable.
                lookup = captures.get(name) ?? 'linkedNode' + captures.size;
                while (source.includes(lookup)) lookup += '_';
                captures.set(name, lookup);
                suffix = '';
              }
              patches.push({ start: offset + node.object.start, end: offset + node.object.end, text: lookup });
              patches.push({ start: offset + node.accessStart, end: offset + node.end, text: suffix });
            } else {
              patches.push({ start: offset + node.accessStart, end: offset + node.end, text: '[' + quoted + ']' });
            }
          }
        }
        child(node.object);
        if (node.computed) child(node.property);
        break;
      }
      case 'Arrow': visit(node.body, offset, [...locals, ...node.params]); break;
      case 'Unary': child(node.argument); break;
      case 'Logical': case 'Binary': child(node.left); child(node.right); break;
      case 'Conditional': child(node.test); child(node.consequent); child(node.alternate); break;
      case 'Array': node.elements.forEach(child); break;
      case 'Object': node.properties.forEach(property => child(property.value)); break;
    }
  }
  try {
    for (const part of compileTemplate(source).segments) {
      if (part.type !== 'expression') continue;
      captures.clear();
      const offset = 1 + part.start;
      visit(parseExpressionSource(part.value), offset, []);
      if (captures.size) {
        const params = [...captures.values()].join(', ');
        const args = [...captures.keys()].map(name => '$(' + JSON.stringify(name) + ')').join(', ');
        patches.push({ start: offset, end: offset, text: '((' + params + ') => (' });
        const end = offset + part.value.length;
        patches.push({ start: end, end, text: '\n))(' + args + ')' });
      }
    }
  } catch {
    return source; // Preserve unfinished or unsupported expressions verbatim.
  }
  for (const patch of patches.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, patch.start) + patch.text + source.slice(patch.end);
  }
  return source;
}

function memberName(node: Extract<Expr, { type: 'Member' }>) {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.property.type === 'Literal' && typeof node.property.value === 'string') return node.property.value;
  return undefined;
}

export function remapReferences(node: WorkflowNode, names: ReadonlyMap<string, string>, lookups = names): WorkflowNode {
  function rewrite(value: ParamValue): ParamValue {
    if (typeof value === 'string' && value.startsWith('=')) return rewriteExpression(value, names, lookups);
    if (Array.isArray(value)) return value.map(entry => rewrite(entry)!);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry)!]));
    }
    return value;
  }
  return { ...node, parameters: Object.fromEntries(Object.entries(node.parameters).map(([k, v]) => [k, rewrite(v)])) };
}
