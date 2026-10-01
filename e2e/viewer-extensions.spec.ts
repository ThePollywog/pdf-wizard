/**
 * Core viewer extension points for features: registerPageLayer (always-on, per page, whatever the
 * active tool) and registerViewerOverlay (once per viewer, not scrolled, with page geometry helpers).
 * The test registers throwaway layers from the page through the app's own module instances.
 */
import { expect, openFixture, test, waitForPagesRendered } from './helpers';

/** Registers a test layer + overlay using the app's React and registry modules. */
async function registerTestExtensions(page: import('@playwright/test').Page) {
  await page.evaluate(async () => {
    // Import React through the exact URL the app uses so hooks share its instance.
    const src = await (await fetch('/client/src/core/viewer/DocumentViewer.tsx')).text();
    const reactUrl = src.match(/from\s+["'](\/node_modules\/[^"']*\/react\.js[^"']*)["']/)?.[1];
    if (!reactUrl) throw new Error('React module URL not found');
    const React = (await import(/* @vite-ignore */ reactUrl)).default;
    const registryUrl = '/client/src/core/registry.ts';
    const registry = await import(/* @vite-ignore */ registryUrl);
    const h = React.createElement;
    type LayerProps = { pageIndex: number; rectToView(r: object): { left: number; top: number; width: number; height: number } };
    registry.registerPageLayer({
      id: 'e2e-under',
      order: 1,
      placement: 'under-objects',
      Component: ({ pageIndex }: LayerProps) => h('div', { 'data-testid': `e2e-under-${pageIndex}` }),
    });
    registry.registerPageLayer({
      id: 'e2e-over',
      order: 1,
      Component: ({ pageIndex, rectToView }: LayerProps) => {
        const box = rectToView({ x: 0, y: 0, width: 72, height: 72 });
        return h('div', {
          'data-testid': `e2e-over-${pageIndex}`,
          style: { position: 'absolute', left: box.left, top: box.top, width: box.width, height: box.height, background: 'rgb(255 0 0 / 0.2)' },
        });
      },
    });
    registry.registerPageLayer({
      id: 'e2e-broken',
      order: 2,
      Component: ({ pageIndex }: LayerProps) => {
        if (pageIndex === 0) throw new Error('broken layer');
        return null;
      },
    });
    type OverlayProps = {
      scroller: HTMLElement | null;
      pageAt(x: number, y: number): { pageIndex: number; point: { x: number; y: number } } | null;
      pageClientRect(i: number): DOMRect | null;
    };
    registry.registerViewerOverlay({
      id: 'e2e-overlay',
      order: 1,
      Component: ({ scroller, pageAt, pageClientRect }: OverlayProps) => {
        const [info, setInfo] = React.useState('');
        return h(
          'button',
          {
            'data-testid': 'e2e-overlay',
            'data-has-scroller': String(!!scroller),
            style: { position: 'absolute', right: 8, bottom: 8, pointerEvents: 'auto' },
            onClick: () => {
              const r = pageClientRect(0);
              if (!r) return setInfo('no rect');
              const hit = pageAt(r.left + 10, r.bottom - 10);
              setInfo(hit ? `${hit.pageIndex}:${Math.round(hit.point.x)}:${Math.round(hit.point.y)}` : 'miss');
            },
          },
          info || 'probe',
        );
      },
    });
  });
}

test('page layers render on every page under and over objects; a viewer overlay gets page geometry', async ({ page, consoleErrors }) => {
  await openFixture(page, 'sample.pdf');
  await waitForPagesRendered(page);
  await registerTestExtensions(page);

  const first = page.getByTestId('page').first();
  await expect(first.getByTestId('e2e-under-0')).toBeAttached();
  await expect(first.getByTestId('e2e-over-0')).toBeAttached();
  // Placement (the other layers only mount when they have content): under-objects paints above
  // decorations (z 2, later in the DOM) and below objects (z 3); over-objects above objects and the
  // tool overlay (z 4, later in the DOM) and below the selection (z 5).
  const order = await first.evaluate((el) =>
    [...el.children].map((c) => (c as HTMLElement).dataset.layer ?? c.className.split(' ')[0]),
  );
  expect(order.indexOf('e2e-under')).toBeGreaterThan(order.indexOf('pdfwizard-page-base'));
  expect(order.indexOf('e2e-over')).toBeGreaterThan(order.indexOf('e2e-under'));
  const z = (layer: string) => first.locator(`[data-layer="${layer}"]`).evaluate((el) => getComputedStyle(el).zIndex);
  expect(await z('e2e-under')).toBe('2');
  expect(await z('e2e-over')).toBe('4');
  // Containers let the pointer through.
  expect(await first.locator('[data-layer="e2e-over"]').evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');

  // rectToView: a 1-inch square at the PDF origin sits at the bottom-left of an unrotated page.
  const [pageBox, square] = await Promise.all([first.boundingBox(), first.getByTestId('e2e-over-0').boundingBox()]);
  expect(Math.abs(square!.x - pageBox!.x)).toBeLessThan(2);
  expect(Math.abs(square!.y + square!.height - (pageBox!.y + pageBox!.height))).toBeLessThan(2);

  // Layers stay mounted when another tool is active.
  await page.evaluate(() => window.__app.actions.setTool('hand'));
  await expect(first.getByTestId('e2e-over-0')).toBeAttached();

  // A layer that throws is dropped quietly (logged), the others keep rendering.
  expect(await first.locator('[data-layer="e2e-broken"]').evaluate((el) => el.childElementCount)).toBe(0);
  expect(consoleErrors.some((e) => e.includes('page layer "e2e-broken" failed to render'))).toBe(true);

  // Viewer overlay: mounted once, clickable, geometry helpers work (10pt in from the bottom-left).
  await expect(page.getByTestId('e2e-overlay')).toHaveCount(1);
  await expect(page.getByTestId('e2e-overlay')).toHaveAttribute('data-has-scroller', 'true');
  await page.getByTestId('e2e-overlay').click();
  const zoom = await page.evaluate(() => window.__app.getActiveDoc().view.zoom);
  const [idx, x, y] = (await page.getByTestId('e2e-overlay').textContent())!.split(':').map(Number);
  expect(idx).toBe(0);
  expect(Math.abs(x - 10 / zoom)).toBeLessThan(2);
  expect(Math.abs(y - 10 / zoom)).toBeLessThan(2);

  // The expected errors of the broken layer; anything else still fails the test.
  const expected = (e: string) => e.includes('broken layer');
  consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((e) => !expected(e)));
});
