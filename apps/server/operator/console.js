const $ = (id) => document.getElementById(id);
const node = (tag, text) => {
  const el = document.createElement(tag);
  if (text != null) el.textContent = String(text);
  return el;
};
const labels = {
  queued: '待機列',
  running: '実行中',
  waiting: '待機中',
  throttled: '429・再試行待ち',
  review: '照合待ち',
  interrupted: '中断',
  compensating: '補償中',
  manual: '要手動対応',
  finished: '終了',
  compensated: '補償完了',
  idle: '未開始',
  success: '成功',
  error: '失敗',
  canceled: '取消済み',
};
const name = (v) => labels[v] ?? v;
const actions = {
  resume: '待機を再開',
  cancel: '取消',
  redrive: '失敗位置から再実行',
  compensate: '補償を開始',
  retryCompensation: '補償を再試行',
  reconcile: '配送結果を照合',
};
const explanations = {
  awaitingEvent: '外部イベントの到着を待っています。',
  awaitingTime: '指定した再開時刻を待っています。',
  eventExpired: 'イベントの受付期限を過ぎました。タイムアウトの処理を待っています。',
  publicationUnavailable: 'このホストでは実行時のワークフロー版を復元できません。必要なノード版を確認してください。',
  review: '外部操作の結果が不明です。受信先の記録を確認してください。',
  throttled: '受信先の制限により再試行時刻を待っています。',
  waiting: '実行の続きが処理されるのを待っています。',
  cancelRequested: '取消要求を受け付けました。',
  manual: '補償に失敗しました。補償の試行を確認してください。',
  error: '実行が失敗しました。',
  recoverableFailure: '実行が失敗しました。失敗位置から再開するためのデータが保存されています。',
};
const attention = {
  heartbeat: 'ワーカーのハートビート停止',
  queue: 'キュー待ち時間が閾値を超過',
  review: '長時間の照合待ち',
  compensation: '補償失敗',
};
const filter = $('filters');
filter.elements.status.add(new Option('すべて', ''));
for (const key of [
  'review',
  'manual',
  'queued',
  'running',
  'waiting',
  'throttled',
  'interrupted',
  'compensating',
  'finished',
])
  filter.elements.status.add(new Option(name(key), key));
let session,
  timer,
  cursor,
  sequence = 0,
  selected = 0,
  lastAlerts = '';
const announce = (s) => {
  $('message').textContent = s;
};
function clear() {
  session = undefined;
  clearTimeout(timer);
  sequence++;
  selected++;
  lastAlerts = '';
  cursor = null;
  $('monitorError').hidden = true;
  for (const id of ['rows', 'record', 'metrics', 'alerts', 'audit', 'who']) $(id).replaceChildren();
  $('detail').hidden = $('work').hidden = $('logout').hidden = true;
  $('login').hidden = false;
  $('token').value = '';
  resetPreview();
  $('previewForm').reset();
  $('previewPanel').open = false;
  $('previewPanel').hidden = true;
  filter.reset();
  $('auditPanel').open = false;
  $('auditFilter').reset();
  $('olderAudit').hidden = true;
}
function report(e) {
  if (e.name !== 'AbortError') announce(e.message);
}
async function api(params, write = false) {
  const current = session;
  if (!current) throw new DOMException('', 'AbortError');
  const url =
    '/operator/' +
    encodeURIComponent(current.org) +
    '/api' +
    (write ? '' : '?' + new URLSearchParams(params));
  const res = await fetch(url, {
    method: write ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer ' + current.token,
      ...(write && { 'Content-Type': 'application/json' }),
    },
    ...(write && { body: JSON.stringify(params) }),
  });
  const data = await res.json();
  if (current !== session) throw new DOMException('', 'AbortError');
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      clear();
      $('org').focus();
    }
    const err = Error(
      {
        401: '認証情報を確認してください。',
        403: '操作権限がありません。再ログインしてください。',
        404: '対象の実行が見つかりません。',
        409: '他の操作により状態が変わりました。最新の状態を表示しました。',
      }[res.status] ?? '要求を処理できませんでした。',
    );
    err.status = res.status;
    throw err;
  }
  return data;
}
function link(id, text = id) {
  const a = node('a', text);
  a.href = '#detail';
  a.onclick = (e) => {
    e.preventDefault();
    detail(id).catch(report);
  };
  return a;
}
function line(parent, title, value) {
  const p = node('p');
  p.append(
    node('strong', title + '　'),
    value instanceof Node ? value : document.createTextNode(String(value)),
  );
  parent.append(p);
}
function entries(parent, title, items, render) {
  if (!items.length) return;
  parent.append(node('h3', title));
  const ul = node('ul');
  for (const item of items) {
    const li = node('li');
    render(li, item);
    ul.append(li);
  }
  parent.append(ul);
}
async function list(next = false) {
  const seq = ++sequence;
  const params = { op: 'list' };
  for (const [k, v] of new FormData(filter))
    if (v) params[k] = ['from', 'to'].includes(k) ? String(new Date(v).getTime()) : v;
  if (next && cursor) Object.assign(params, cursor);
  const runs = await api(params);
  if (seq !== sequence) return;
  $('rows').replaceChildren();
  for (const r of runs) {
    const tr = node('tr'),
      th = node('th');
    th.scope = 'row';
    th.append(link(r.runId, r.workflowId), node('small', r.runId));
    tr.append(
      th,
      node('td', r.revision),
      node('td', name(r.status) + (r.outcome ? ' · ' + name(r.outcome) : '')),
      node('td', new Date(r.acceptedAt).toLocaleString('ja-JP')),
    );
    $('rows').append(tr);
  }
  if (!runs.length) {
    const td = node('td', '該当する実行はありません。');
    td.colSpan = 4;
    const tr = node('tr');
    tr.append(td);
    $('rows').append(tr);
  }
  const last = runs.at(-1);
  cursor = last ? { before: last.acceptedAt, afterId: last.runId } : null;
  $('next').hidden = runs.length !== 50;
}
async function monitor() {
  const m = await api({ op: 'metrics' });
  const age = (n) => Math.floor(n / 1000) + ' 秒';
  $('metrics').replaceChildren(
    ...[
      ['最長キュー待ち', age(m.queueAgeMs)],
      [
        '最終ハートビート',
        m.lastHeartbeat ? new Date(m.lastHeartbeat).toLocaleTimeString('ja-JP') : '未受信',
      ],
      ['最長照合待ち', age(m.reviewAgeMs)],
      ['補償失敗', m.compensationFailures + ' 件'],
    ].map(([label, value]) => {
      const d = node('div', label);
      d.append(node('strong', value));
      return d;
    }),
  );
  const signature = JSON.stringify([m.alerts, m.recovered]);
  if (lastAlerts === signature) return m.thresholdMs;
  lastAlerts = signature;
  $('alerts').replaceChildren(
    ...m.alerts.map((a) => {
      const p = node('p', attention[a.kind] + '　');
      if (a.run) p.append(link(a.run, '対象の実行'));
      return p;
    }),
    ...m.recovered.map((a) => {
      const p = node('p', '復旧 · ' + attention[a.kind] + '　');
      if (a.run) p.append(link(a.run, '復旧後の実行'));
      return p;
    }),
  );
  return m.thresholdMs;
}
async function pollMetrics(current) {
  let delay = 1000;
  try {
    delay = Math.max(250, Math.min(2000, (await monitor()) / 4));
    $('monitorError').hidden = true;
  } catch (e) {
    if (current === session) {
      $('monitorError').hidden = false;
      $('monitorError').textContent = '監視情報を取得できません。再試行中です。';
    } else report(e);
  } finally {
    if (current === session) timer = setTimeout(() => pollMetrics(current), delay);
  }
}
function control(form, caption, el) {
  const l = node('label', caption);
  l.append(el);
  form.append(l);
  return el;
}
function action(parent, d, candidate) {
  const { op, key, failure, decisions } = candidate;
  const form = node('form');
  let decision, result;
  if (op === 'reconcile') {
    decision = control(form, '受信先の確認結果', node('select'));
    const labels = { applied: '適用済み', notApplied: '未適用', retryKeyed: '同じキーで再試行' };
    for (const value of decisions) decision.add(new Option(labels[value], value));
    result = control(form, '受信先の結果（任意の JSON）', node('input'));
  }
  const reason = control(form, '操作理由', node('select'));
  const choices =
    op === 'reconcile'
      ? [
          ['receiver-confirmed', '受信記録を確認'],
          ['receiver-absent', '未適用を確認'],
          ...(decision.options.length === 3 ? [['incident-recovery', '障害対応']] : []),
        ]
      : [
          ['incident-recovery', '障害対応'],
          ['operator-request', '運用上の依頼'],
        ];
  choices.forEach(([v, label]) => reason.add(new Option(label, v)));
  if (decision)
    decision.onchange = () => {
      reason.selectedIndex = decision.selectedIndex;
    };
  const button = node('button', actions[op]);
  form.append(button);
  parent.append(form);
  const request = crypto.randomUUID();
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    try {
      const body = { op, target: d.run.runId, request, version: d.version, reason: reason.value, key, failure };
      if (decision) {
        body.decision = decision.value;
        if (result.value) body.result = JSON.parse(result.value);
      }
      await api(body, true);
      await detail(d.run.runId);
      await list();
      announce('操作を記録しました。');
    } catch (err) {
      if (err.status === 409) await detail(d.run.runId).catch(report);
      report(err);
    } finally {
      button.disabled = false;
    }
  };
}
async function detail(id) {
  const seq = ++selected;
  const d = await api({ op: 'detail', id });
  if (selected !== seq) return;
  const r = d.run,
    box = $('record');
  box.replaceChildren();
  $('detail').hidden = false;
  line(box, r.workflowId + ' · v' + r.revision, r.runId);
  line(box, '現在の状態', name(r.status));
  const guidance = d.guidance;
  if (explanations[guidance.reason]) line(box, '状況', explanations[guidance.reason]);
  entries(box, '現在できる操作', guidance.actions, (li, candidate) => {
    if (candidate.node) li.append(node('span', candidate.node));
    if (candidate.key || candidate.failure) li.append(node('small', candidate.key ?? candidate.failure));
    action(li, d, candidate);
  });
  if (d.history)
    line(
      box,
      '実行履歴',
      name(d.history.status) + ' · ' + new Date(d.history.startedAt).toLocaleString('ja-JP'),
    );
  if (r.outcome) line(box, '元の実行結果', name(r.outcome));
  line(box, '補償', name(d.compensation.state));
  entries(box, '親子の実行', d.calls, (li, c) =>
    li.append(
      link(
        c.child === r.runId ? c.parent : c.child,
        c.child === r.runId ? '親 ' + c.parent : '子 ' + c.child,
      ),
    ),
  );
  entries(box, '外部操作', d.effects, (li, x) => {
    li.append(node('strong', x.nodeId + ' · ' + x.state), node('small', x.key));
  });
  entries(box, '再実行', d.recovery, (li, p) => {
    li.append(node('span', p.node + ' · ' + p.failure));
    if (p.attempt) li.append(' ', link(p.attempt));
  });
  entries(box, '補償の試行', d.compensation.steps, (li, s) => {
    li.append(node('span', s.priority + ' · ' + s.status));
    if (s.child) li.append(' ', link(s.child));
  });
  if (d.compensation.id) line(box, '補償 ID', link(d.compensation.id));
  entries(box, '補償の再試行', d.compensation.retries, (li, s) =>
    li.append(s.failure + ' · ', link(s.attempt)),
  );
  entries(
    box,
    '状態の変更',
    d.transitions,
    (li, x) => (li.textContent = new Date(x.at).toLocaleString('ja-JP') + ' · ' + x.reason),
  );
  const refresh = node('button', '詳細を更新');
  refresh.onclick = () => detail(id).catch(report);
  box.append(refresh);
  $('detailTitle').focus();
}
$('login').onsubmit = async (e) => {
  e.preventDefault();
  clearTimeout(timer);
  const org = $('org').value.trim();
  session = { org, token: $('token').value };
  try {
    const me = await api({ op: 'session' });
    $('token').value = '';
    $('login').hidden = true;
    $('work').hidden = $('logout').hidden = false;
    $('previewPanel').hidden = !me.allowed.includes('publish');
    $('who').textContent = me.organization + ' / ' + me.actor + ' · ' + me.role;
    announce('');
    filter.elements.status.focus();
    void pollMetrics(session);
    await list();
  } catch (e) {
    report(e);
  }
};
$('logout').onclick = () => {
  clear();
  announce('ログアウトしました。');
  $('org').focus();
};
filter.onsubmit = (e) => {
  e.preventDefault();
  $('rows').replaceChildren();
  list().catch(report);
};
$('next').onclick = () => list(true).catch(report);
let auditCursor;
async function audit(next = false) {
  if (!$('auditPanel').open) return;
  try {
    const target = $('auditFilter').elements.target.value;
    const rows = await api({ op: 'audit', ...(target && { target }), ...(next && auditCursor) });
    const last = rows.at(-1);
    auditCursor = last ? { before: last.stamp, afterRequest: last.request } : undefined;
    $('olderAudit').hidden = rows.length !== 100;
    $('audit').replaceChildren(
      ...rows.map((x) =>
        node(
          'li',
          [
            new Date(x.stamp).toLocaleString('ja-JP'),
            x.actor,
            x.action,
            x.target,
            x.reason,
            x.result,
            x.changeinfo === '{}' ? '' : x.changeinfo,
          ].join(' · '),
        ),
      ),
    );
  } catch (e) {
    report(e);
  }
}
$('auditPanel').ontoggle = () => audit();
$('olderAudit').onclick = () => audit(true);
$('auditFilter').onsubmit = (e) => {
  e.preventDefault();
  audit();
};

let previewRequest = 0;
function resetPreview() {
  previewRequest++;
  $('previewResult').replaceChildren();
}
$('draftFile').onchange = resetPreview;
$('previewForm').onsubmit = async (event) => {
  event.preventDefault();
  resetPreview();
  const request = previewRequest;
  const file = $('draftFile').files[0];
  try {
    if (!file || file.size > 1024 * 1024) throw Error('1 MiB 以下のフロー定義を選んでください。');
    const source = await file.text();
    if (request !== previewRequest) return;
    let workflow;
    try {
      workflow = JSON.parse(source);
    } catch {
      throw Error('JSON 形式を確認してください。');
    }
    const preview = await api({ op: 'preview', workflow }, true);
    if (request !== previewRequest) return;
    const box = $('previewResult');
    box.append(node('h3', preview.workflowName));
    if (!preview.triggers.length) box.append(node('p', '有効な起動ノードはありません。'));
    for (const trigger of preview.triggers) {
      const schedule = trigger.schedule;
      const condition = schedule
        ? schedule.intervalMs ? (schedule.intervalMs / 1000) + ' 秒ごと'
          : [schedule.minute, schedule.hour, schedule.day, schedule.month, schedule.weekday]
              .map((value) => value ?? '*').join(' ') + ' ' + schedule.timezone
        : trigger.path ?? trigger.type;
      line(box, trigger.nodeName, condition);
      if (!trigger.effects.length) box.append(node('p', '外部操作はありません。'));
      const kinds = { read: '読み取り', write: '書き込み', unknown: '操作は実行時に決定', undeclared: '影響未宣言' };
      for (const effect of trigger.effects) {
        const owner = effect.revision === null ? effect.nodeName : effect.workflowId + ' v' + effect.revision + ' / ' + effect.nodeName;
        const fields = [kinds[effect.kind], effect.method, effect.destination];
        if (effect.destination === null) fields.push('送信先は実行時に確認');
        if (effect.credentialRefs.length) fields.push('資格情報 ' + effect.credentialRefs.join(', '));
        line(box, (effect.phase === 'compensation' ? '補償 · ' : '') + owner, fields.filter(Boolean).join(' · '));
      }
    }
    announce('公開前の影響を表示しました。');
  } catch (error) {
    if (request === previewRequest) report(error);
    else if (error.status === 401 || error.status === 403) report(error);
  }
};
