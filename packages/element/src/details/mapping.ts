export type FieldPath = (string | number)[];
export interface Mapping {
  path: FieldPath;
  ancestor?: string;
  input?: { port: string; slot: number };
}

function quoted(text: string) {
  return "'" + JSON.stringify(text).slice(1, -1).replaceAll("'", "\\'") + "'";
}

export function fieldPath(path: FieldPath) {
  return path.map((key, i) => {
    if (typeof key === 'number') return '[' + key + ']';
    if (/^[A-Za-z_$][\w$]*$/.test(key)) return (i ? '.' : '') + key;
    return '[' + quoted(key) + ']';
  }).join('');
}

export function itemAccessor(input?: Mapping['input']) {
  return input ? '.itemFrom(' + quoted(input.port) + ', ' + input.slot + ', $itemIndex).json' : '.item.json';
}

export function mappingRoot(ancestor?: string, input?: Mapping['input']) {
  if (ancestor !== undefined) return '$(' + quoted(ancestor) + ')' + itemAccessor(input);
  return input ? '$input' + itemAccessor(input) : '$json';
}

export function insertMapping(mapping: Mapping, original: string, range?: [number, number], dataPath?: 'single' | 'multiple') {
  const path = fieldPath(mapping.path);
  if (dataPath) return dataPath === 'multiple' && original && range ? original + ', ' + path : path;
  const root = mappingRoot(mapping.ancestor, mapping.input);
  const token = '{{ ' + root + (path.startsWith('[') ? '' : '.') + path + ' }}';
  if (!range) return '=' + token;
  const [start, end] = range;
  const prefix = original.startsWith('=') ? 1 : 0;
  return '=' + original.slice(prefix, Math.max(prefix, start)) + token + original.slice(Math.max(prefix, end));
}
