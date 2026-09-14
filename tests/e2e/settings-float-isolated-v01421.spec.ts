import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';

test.use({ deviceScaleFactor: 1.5, viewport: { width: 1707, height: 950 } });

for (const theme of ['dark', 'light'] as const)
  test(`built floating settings: ${theme}, close choices, validation and scrolling`, async ({
    page,
  }) => {
    test.setTimeout(30000);
    page.setDefaultTimeout(5000);
    const root = path.resolve('.output/chrome-mv3');
    const origin = 'https://settings-float.test';
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/controller')
        return route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><title>Controller fixture</title><body style="background:#30323a"></body>',
        });
      if (url.pathname === '/')
        return route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><style>body{background:#30323a;margin:0}iframe{position:absolute;top:24px;left:24px;width:410px;height:700px;border:1px solid #555;border-radius:20px;overflow:hidden}</style><iframe title="设置" src="/settings-float.html?token=fixture"></iframe>',
        });
      const file = path.resolve(root, `.${url.pathname}`);
      if (!file.startsWith(root + path.sep)) return route.abort();
      try {
        await route.fulfill({
          body: await readFile(file),
          contentType: file.endsWith('.html')
            ? 'text/html'
            : file.endsWith('.js')
              ? 'application/javascript'
              : file.endsWith('.css')
                ? 'text/css'
                : 'image/svg+xml',
        });
      } catch {
        await route.abort();
      }
    });
    await page.addInitScript(
      ({ initial }) => {
        let settings = initial;
        const event = () => ({ addListener: () => {}, removeListener: () => {} });
        const listeners: Array<
          (m: unknown, sender: unknown, reply: (value: unknown) => void) => void
        > = [];
        Reflect.set(window, '__agentListeners', listeners);
        Object.assign(window, {
          savedCount: 0,
          closeCount: 0,
          failSave: false,
          chrome: {
            runtime: {
              id: 'fixture',
              getURL: (p: string) => new URL(p, location.origin).href,
              getManifest: () => ({ version: '0.14.21' }),
              onMessage: {
                addListener: (fn: (typeof listeners)[number]) => listeners.push(fn),
                removeListener: () => {},
              },
              sendMessage: async (m: { type: string; patch?: typeof initial }) => {
                if (m.type === 'VERIFY_SETTINGS_FRAME') return { ok: true, data: true };
                if (m.type === 'GET_SETTINGS') return { ok: true, data: settings };
                if (m.type === 'SAVE_SETTINGS') {
                  if (Reflect.get(window, 'failSave'))
                    return { ok: false, error: '无法保存设置，请重试。' };
                  settings = m.patch!;
                  Reflect.set(window, 'savedCount', Reflect.get(window, 'savedCount') + 1);
                  return { ok: true, data: settings };
                }
                return { ok: true, data: null };
              },
            },
            storage: {
              sync: { get: async () => ({ 'foxfetch:settings': settings }) },
              local: { get: async () => ({}), set: async () => {} },
              onChanged: event(),
            },
            permissions: {
              getAll: async () => ({
                origins: ['https://*.youtube.com/*', 'https://*.bilibili.com/*'],
              }),
              contains: async () => false,
              onAdded: event(),
              onRemoved: event(),
            },
            tabs: { create: async () => ({}) },
          },
        });
        window.addEventListener('message', (e) => {
          if (e.data?.type === 'FOXF_SETTINGS_CLOSED')
            Reflect.set(window, 'closeCount', Reflect.get(window, 'closeCount') + 1);
          if (e.data?.type === 'FOXF_SETTINGS_DRAG') {
            const frame = document.querySelector('iframe');
            if (frame) {
              const r = frame.getBoundingClientRect();
              frame.style.left = `${r.left + e.data.dx}px`;
              frame.style.top = `${r.top + e.data.dy}px`;
            }
          }
        });
      },
      { initial: { ...DEFAULT_SETTINGS, themeMode: theme } },
    );
    await page.setViewportSize({ width: 780, height: 820 });
    await page.goto(origin);
    const frame = page.frameLocator('iframe');
    await expect(frame.getByRole('heading', { name: '外观与播放' })).toBeVisible();
    await mkdir('.output/acceptance-v01421', { recursive: true });
    await page.screenshot({ path: `.output/acceptance-v01421/settings-${theme}.png` });
    await frame.getByText('固定播放速度', { exact: true }).click();
    await frame.getByRole('button', { name: '关闭设置' }).click();
    await expect(frame.getByRole('dialog').getByRole('button')).toHaveText([
      '保存',
      '不保存',
      '取消',
    ]);
    await expect(frame.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await page.screenshot({ path: `.output/acceptance-v01421/settings-confirm-${theme}.png` });
    await page.keyboard.press('Tab');
    await expect(frame.getByRole('button', { name: '保存', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(frame.getByRole('dialog')).toHaveCount(0);
    await expect(frame.getByRole('checkbox', { name: '固定播放速度' })).toBeChecked();
    expect(await page.evaluate(() => Reflect.get(window, 'closeCount'))).toBe(0);

    // Save failure keeps both the frame and draft; no close notification is sent.
    await page.frames()[1]!.evaluate(() => Reflect.set(window, 'failSave', true));
    await frame.getByRole('button', { name: '关闭设置' }).click();
    await frame.getByRole('button', { name: '保存', exact: true }).click();
    await expect(frame.getByText('无法保存设置，请重试。', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => Reflect.get(window, 'closeCount'))).toBe(0);
    await page.frames()[1]!.evaluate(() => Reflect.set(window, 'failSave', false));
    await frame.getByRole('button', { name: '关闭设置' }).click();
    await frame.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'closeCount'))).toBe(1);
    expect(await page.frames()[1]!.evaluate(() => Reflect.get(window, 'savedCount'))).toBe(1);

    // This fixture counts close messages rather than disposing the frame, so reset its dialog.
    await page.keyboard.press('Escape');

    await frame.getByText('固定播放速度', { exact: true }).click();
    await frame.getByRole('button', { name: '关闭设置' }).click();
    await frame.getByRole('button', { name: '不保存' }).click();
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'closeCount'))).toBe(2);
    await page.keyboard.press('Escape');
    expect(await page.frames()[1]!.evaluate(() => Reflect.get(window, 'savedCount'))).toBe(1);
    await frame.getByText('Copyright © 2026 IKITheFox', { exact: true }).scrollIntoViewIfNeeded();
    await expect(frame.getByText('Copyright © 2026 IKITheFox', { exact: true })).toBeInViewport();
    await page.screenshot({ path: `.output/acceptance-v01421/settings-footer-${theme}.png` });
    expect(
      await page
        .frames()[1]!
        .evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1),
    ).toBe(true);
    await page.locator('iframe').evaluate((el) => {
      el.style.width = '330px';
      el.style.height = '540px';
    });
    await page
      .frames()[1]!
      .locator('.settings-content')
      .evaluate((el) => {
        el.scrollTop = 0;
      });
    await frame.getByText('固定播放速度', { exact: true }).click();
    await expect(frame.getByRole('button', { name: '保存设置', exact: true })).toBeInViewport();
    expect(
      await page.frames()[1]!.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `.output/acceptance-v01421/settings-narrow-${theme}.png` });

    // Regression: dirty footer and focus scrolling must never move the frame document.
    for (const [width, height] of [
      [300, 360],
      [410, 460],
      [580, 700],
    ]) {
      await page.locator('iframe').evaluate(
        (el, size) => {
          el.style.width = `${size[0]}px`;
          el.style.height = `${size[1]}px`;
        },
        [width, height],
      );
      await frame.getByText('Copyright © 2026 IKITheFox', { exact: true }).scrollIntoViewIfNeeded();
      await expect(frame.getByRole('button', { name: '关闭设置' })).toBeInViewport();
      await expect(frame.getByRole('button', { name: '保存设置', exact: true })).toBeInViewport();
      const geometry = await page.frames()[1]!.evaluate(() => {
        const top = document.querySelector('.settings-top')!.getBoundingClientRect();
        const footer = document.querySelector('.settings-save')!.getBoundingClientRect();
        const content = document.querySelector('.settings-scroll')!.getBoundingClientRect();
        return {
          top: top.top,
          footer: footer.bottom,
          bottom: content.bottom,
          footerTop: footer.top,
          height: innerHeight,
          scroll: document.scrollingElement!.scrollTop,
        };
      });
      expect(geometry.top).toBeGreaterThanOrEqual(0);
      expect(geometry.footer).toBeLessThanOrEqual(geometry.height + 1);
      expect(Math.abs(geometry.bottom - geometry.footerTop)).toBeLessThanOrEqual(1);
      expect(geometry.scroll).toBe(0);
    }

    // Run the actual built controller host as well, with only browser APIs replaced.
    await page.goto(origin + '/controller');
    await page.addScriptTag({ content: await readFile(path.join(root, 'media-agent.js'), 'utf8') });
    const dispatch = (message: object) =>
      page.evaluate(
        (m) =>
          new Promise((resolve) => {
            Reflect.get(window, '__agentListeners')[0](
              m,
              { id: 'fixture', url: chrome.runtime.getURL('background.js') },
              resolve,
            );
          }),
        message,
      );
    expect(await dispatch({ type: 'AGENT_OPEN_SETTINGS', token: 'fixture' })).toMatchObject({
      ok: true,
    });
    const controllerFrame = page.frames().find((f) => f.url().includes('settings-float.html'))!;
    await expect(controllerFrame.getByRole('heading', { name: '外观与播放' })).toBeVisible();
    const measureSettings = () =>
      controllerFrame.evaluate(() => {
        const box = (selector: string) => {
          const r = document.querySelector(selector)!.getBoundingClientRect();
          return [r.top, r.height, r.bottom];
        };
        return {
          header: box('.settings-top'),
          content: box('.settings-scroll'),
          footer: box('.settings-save'),
          scroll: document.scrollingElement!.scrollTop,
        };
      });
    const cleanGeometry = await measureSettings();
    for (let repeat = 0; repeat < 3; repeat++) {
      await controllerFrame.getByText('固定播放速度', { exact: true }).click();
      await expect(
        controllerFrame.getByRole('button', { name: '保存设置', exact: true }),
      ).toBeVisible();
      expect(await measureSettings()).toEqual(cleanGeometry);
      await controllerFrame.getByRole('button', { name: '取消更改', exact: true }).click();
      expect(await measureSettings()).toEqual(cleanGeometry);
    }
    await page.locator('.panel').evaluate((panel) => {
      panel.scrollTop = 120;
    });
    expect(await page.locator('.panel').evaluate((panel) => panel.scrollTop)).toBe(0);
    await expect(controllerFrame.getByRole('button', { name: '关闭设置' })).toBeInViewport();
    await controllerFrame.getByText('固定播放速度', { exact: true }).click();
    expect(await dispatch({ type: 'AGENT_OPEN_SETTINGS', token: 'ignored' })).toMatchObject({
      ok: true,
    });
    expect(page.frames().filter((f) => f.url().includes('settings-float.html'))).toHaveLength(1);
    await expect(controllerFrame.getByText('有未保存的更改')).toBeVisible();
    const before = await page.locator('.panel').boundingBox();
    const heading = await controllerFrame.locator('.settings-top .brand').boundingBox();
    await page.mouse.move(heading!.x + 25, heading!.y + 10);
    await page.mouse.down();
    await page.mouse.move(heading!.x - 15, heading!.y - 15, { steps: 5 });
    await page.mouse.up();
    const after = await page.locator('.panel').boundingBox();
    expect(Math.abs(before!.x - after!.x) + Math.abs(before!.y - after!.y)).toBeGreaterThan(5);
    await dispatch({
      type: 'AGENT_APPLY_SETTINGS',
      settings: {
        ...DEFAULT_SETTINGS,
        playback: { ...DEFAULT_SETTINGS.playback, showController: false },
      },
    });
    await expect(controllerFrame.getByText('有未保存的更改')).toBeVisible();
    await page.setViewportSize({ width: 360, height: 650 });
    await expect
      .poll(
        async () => {
          const bounds = await page.locator('.panel').boundingBox();
          return !!bounds && bounds.x >= 0 && bounds.x + bounds.width <= 360;
        },
        { timeout: 5000 },
      )
      .toBe(true);
    await page.screenshot({ path: `.output/acceptance-v01421/controller-settings-${theme}.png` });
    await controllerFrame.getByRole('button', { name: '关闭设置' }).click();
    await controllerFrame.getByRole('button', { name: '不保存' }).click();
    await expect
      .poll(() => page.frames().filter((f) => f.url().includes('settings-float.html')).length, {
        timeout: 5000,
      })
      .toBe(0);
  });
