import { expect, test } from '@playwright/test';
import type {} from '@draflow/element/define';

test('canvas baseline on the production embed', async ({ page, browser }, info) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Manual → Set' })).toBeVisible();
  const rendering = await page.evaluate(async () => {
    const editor = document.querySelector('draflow-editor')!;
    const root = editor.shadowRoot!;
    const sample = editor.workflow!;
    const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
    function fixture(size: number) {
      const nodes = Array.from({ length: size }, (_, i) => ({
        ...sample.nodes[1]!, id: String(i), name: 'Set ' + i,
        position: { x: (i % 10) * 240, y: Math.floor(i / 10) * 112 },
      }));
      const connections = [];
      for (let stride = 1; connections.length < size * 2.5; stride++) {
        for (let i = 0; i + stride < size && connections.length < size * 2.5; i++) {
          connections.push({ id: i + '-' + stride, from: { node: String(i), port: 'main', index: 0 },
            to: { node: String(i + stride), port: 'main', index: 0 } });
        }
      }
      return { ...sample, nodes, connections };
    }
    const times: Record<string, number[]> = {};
    for (const size of [50, 200]) {
      const workflow = fixture(size);
      const samples: number[] = [];
      for (let i = 0; i < 8; i++) {
        editor.workflow = { ...sample, nodes: [], connections: [] };
        await frame();
        const start = performance.now();
        editor.workflow = workflow;
        await frame();
        await frame();
        if (i) samples.push(performance.now() - start);
      }
      times['render' + size] = samples;
    }
    return { times, nodes: root.querySelectorAll('.node-card').length, edges: root.querySelectorAll('path').length };
  });
  expect(rendering.nodes).toBe(200);
  expect(rendering.edges).toBe(500);
  const surface = page.locator('draflow-editor .canvas');
  await surface.focus();
  await page.keyboard.press('0');
  const box = (await surface.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  const pointer = page.evaluate(() => new Promise<number>(resolve => {
    document.addEventListener('pointerdown', e => resolve(e.pointerId), { once: true });
  }));
  const motion: Record<string, number[]> = {};
  for (const mode of ['pan', 'zoom'] as const) {
    // Use a real captured mouse for the pan; drive its moves once per browser frame.
    if (mode === 'pan') await page.mouse.down({ button: 'middle' });
    motion[mode] = await surface.evaluate(async (el, { mode, cx, cy, pointerId }) => {
      const canvas = el as HTMLElement;
      const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
      const world = canvas.querySelector<HTMLElement>('.world')!;
      const samples: number[] = [];
      let changes = 0, previous = await frame(), transform = world.style.transform;
      for (let i = 0; i < 120; i++) {
        const phase = (i % 40) < 20 ? i % 20 : 20 - i % 20;
        if (mode === 'pan') {
          canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId, clientX: cx + phase * 4, clientY: cy + phase * 2, buttons: 4 }));
        } else {
          canvas.dispatchEvent(new WheelEvent('wheel', { clientX: cx, clientY: cy, ctrlKey: true, cancelable: true, deltaY: i % 40 < 20 ? 8 : -8 }));
        }
        const now = await frame();
        if (i >= 20) samples.push(now - previous);
        if (world.style.transform !== transform) changes++;
        previous = now;
        transform = world.style.transform;
      }
      if (changes < 100) throw new Error('Viewport failed to update during ' + mode);
      return samples;
    }, { mode, cx, cy, pointerId: await pointer });
    if (mode === 'pan') await page.mouse.up({ button: 'middle' });
  }
  // Center an interior node. Measure the actual drag preview, including its incident edges.
  await surface.focus();
  await page.keyboard.press('0');
  const editor = page.locator('draflow-editor');
  await editor.evaluate(el => (el as HTMLElementTagNameMap['draflow-editor']).focusNode('55'));
  const card = surface.locator('[data-node-id="55"]');
  const originalX = await card.evaluate(el => (el as HTMLElement).offsetLeft);
  await card.hover();
  const cardBox = (await card.boundingBox())!;
  const start = { x: cardBox.x + cardBox.width / 2, y: cardBox.y + cardBox.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  motion.move = await surface.evaluate(async (surface, args) => {
    const card = surface.querySelector<HTMLElement>('[data-node-id="55"]')!;
    const path = surface.querySelector('[data-edge-id="54-1"]')!;
    const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
    let previous = await frame(), changes = 0;
    let transform = card.style.transform, route = path.getAttribute('d');
    const samples: number[] = [];
    for (let i = 0; i < 120; i++) {
      const step = i % 20 < 10 ? i % 10 : 10 - i % 10;
      surface.dispatchEvent(new PointerEvent('pointermove', {
        pointerId: args.pointerId, buttons: 1,
        clientX: args.start.x + step * 16, clientY: args.start.y + step * 16,
      }));
      const now = await frame();
      if (i >= 20) samples.push(now - previous);
      if (transform !== card.style.transform && route !== path.getAttribute('d')) changes++;
      transform = card.style.transform;
      route = path.getAttribute('d');
      previous = now;
    }
    if (changes < 110) throw new Error('Card and incident edge did not move together');
    return samples;
  }, { start, pointerId: await pointer });
  await page.mouse.move(start.x + 32, start.y + 16);
  await page.mouse.up();
  expect(await card.evaluate(el => (el as HTMLElement).offsetLeft)).toBe(originalX + 32);
  const measurements = Object.fromEntries(Object.entries({ ...rendering.times, ...motion }).map(([name, samples]) => {
    const sorted = [...samples].sort((a, b) => a - b);
    const percentile = (p: number) => +sorted[Math.ceil(p * sorted.length) - 1]!.toFixed(2);
    return [name, { samples: sorted.length, medianMs: percentile(0.5), p95Ms: percentile(0.95) }];
  }));
  const report = { chromium: browser.version(), viewport: page.viewportSize(), dpr: 1, measurements };
  console.log(JSON.stringify(report, null, 2));
  await info.attach('canvas-baseline.json', { body: JSON.stringify(report), contentType: 'application/json' });
});
