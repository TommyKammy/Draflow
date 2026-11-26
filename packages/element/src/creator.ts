import type { NodeType } from '@draflow/core';
import { creatorPorts, type Placement } from './store/edit.js';

const words = {
  en: { title: 'Add node', next: 'Connect next node', insert: 'Insert node', close: 'Close', search: 'Search nodes',
    all: 'All categories', recent: 'Recently used', empty: 'No matching nodes',
    trigger: 'Triggers', core: 'Core', transform: 'Transform', flow: 'Flow', network: 'Network', human: 'Human' },
  ja: { title: 'ノードを追加', next: '次のノードを接続', insert: '接続にノードを挿入', close: '閉じる', search: 'ノードを検索',
    all: 'すべてのカテゴリ', recent: '最近使ったノード', empty: '該当するノードがありません',
    trigger: 'トリガー', core: '基本', transform: '変換', flow: 'フロー', network: 'ネットワーク', human: '手動操作' },
};

export function createNodeCreator(types: NodeType[], choose: (type: NodeType, placement?: Placement) => void) {
  const catalog = types.filter(t => !t.meta.hidden);
  const dialog = document.createElement('dialog');
  dialog.className = 'node-creator';
  const heading = document.createElement('h2');
  heading.id = 'creator-heading';
  dialog.setAttribute('aria-labelledby', heading.id);
  const close = document.createElement('button');
  close.type = 'button';
  close.onclick = () => dialog.close();
  const header = document.createElement('header');
  header.append(heading, close);
  const search = document.createElement('input');
  search.type = 'search';
  search.autofocus = true;
  const category = document.createElement('select');
  const results = document.createElement('div');
  dialog.append(header, search, category, results);
  let recent: NodeType[] = [];
  let labels = words.en;
  let placement: Placement | undefined;
  let candidates: NodeType[] = [];
  function render() {
    results.replaceChildren();
    const query = search.value.trim().toLowerCase();
    const matches = candidates.filter(t => (!category.value || category.value === t.meta.category) &&
      [t.meta.label, t.type, t.meta.description, ...(t.meta.tags ?? [])].some(s => s?.toLowerCase().includes(query)));
    function group(name: string, nodes: NodeType[]) {
      if (!nodes.length) return;
      const title = document.createElement('h3');
      title.textContent = name;
      results.append(title);
      for (const type of nodes) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = type.meta.label;
        button.title = type.meta.description ?? '';
        button.onclick = () => {
          recent = [type, ...recent.filter(t => t !== type)].slice(0, 5);
          dialog.close();
          choose(type, placement);
        };
        results.append(button);
      }
    }
    group(labels.recent, recent.filter(t => matches.includes(t)));
    const rest = matches.filter(t => !recent.includes(t));
    for (const key of new Set(rest.map(t => t.meta.category))) {
      group(labels[key], rest.filter(t => t.meta.category === key));
    }
    if (!matches.length) results.textContent = labels.empty;
  }
  search.oninput = category.onchange = render;
  return {
    dialog,
    open(locale: 'en' | 'ja', context?: Placement) {
      placement = context;
      labels = words[locale];
      candidates = catalog.filter(t => !context || creatorPorts(t, context));
      heading.textContent = context?.edge ? labels.insert : context ? labels.next : labels.title;
      close.textContent = labels.close;
      search.value = '';
      search.placeholder = labels.search;
      search.setAttribute('aria-label', labels.search);
      category.setAttribute('aria-label', labels.all);
      category.replaceChildren(new Option(labels.all, ''));
      for (const key of new Set(candidates.map(t => t.meta.category))) category.add(new Option(labels[key], key));
      render();
      dialog.showModal();
    },
  };
}
