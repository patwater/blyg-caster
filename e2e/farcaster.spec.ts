import { test, expect, type Page } from './fixture';

// blygcaster's Farcaster flow in the browser, on desktop and phone (the mobile
// project). The e2e server runs with FARCASTER_FAKE=1, so the reader reads the
// in-memory demo casts (src/farcaster/fake.ts) and casting goes to a fake sink:
// nothing here reaches Farcaster.
async function login(page: Page) {
  await page.goto('/studio/login');
  await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(
    async ([m, p, b]) => {
      const r = await fetch('/api' + p, { method: m as string, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      return { status: r.status, json: await r.json().catch(() => null) };
    },
    [method, path, body] as const,
  );
async function publishInEditor(page: Page) {
  await page.locator('#publish-btn').click();
  const confirm = page.locator('#note-confirm-ok');
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
}

test('read casts, stub a passage, and cross-post, without metrics', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);

  // Settings → Farcaster: add an account and turn on the reader tools.
  await page.goto('/studio/settings#farcaster');
  const section = page.locator('#farcaster');
  await expect(section).toContainText('accounts and channels you read');
  await section.locator('#farcaster-sources input').first().fill('@riverkeeper');
  await section.locator('#fc-add-source').click();
  await expect(section.locator('.fc-sources')).toContainText('River Keeper (@riverkeeper) on Farcaster');
  const sub = (await api(page, 'GET', '/subscriptions')).json.items.find((s: { kind: string }) => s.kind === 'farcaster');
  if (await section.locator('#fc-enable-tools').isVisible()) await section.locator('#fc-enable-tools').click();
  await expect(section.locator('#fc-enable-tools')).toHaveCount(0);
  // The section's own save does not submit the Studio's settings form.
  await section.locator('#fc-ai_note').fill('Includes AI-generated text.');
  await section.locator('#fc-save').click();
  await expect(section.getByRole('status')).toHaveText('saved');

  // Reading: the casts are entries, with author, time and an inline image, and no counts.
  await expect.poll(async () => (await api(page, 'GET', `/reading?sub=${sub.id}`)).json.items.length).toBeGreaterThan(1);
  await page.goto(`/studio/reading?sub=${sub.id}`);
  const cast = page.locator('.reading-entry').filter({ hasText: 'The Colorado once reached the sea' });
  await expect(cast).toBeVisible();
  await expect(cast).toContainText('River Keeper (@riverkeeper)');
  await expect(cast.locator('img[src*="picsum.photos"]')).toHaveCount(1);
  await expect(cast.locator('.byline')).toContainText(/farcaster.*River Keeper \(@riverkeeper\) on Farcaster\s*· \w+ \d+, \d{4}/);
  const markdowny = page.locator('.reading-entry').filter({ hasText: '# Not a heading, *not emphasis*' });
  await expect(markdowny.locator('h1, em')).toHaveCount(0);
  expect((await page.locator('.reading-entry').allInnerTexts()).join('\n')).not.toMatch(/\blikes?\b|recasts?|followers/i);
  // The page fits the screen: no sideways scroll at phone width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

  // The thread sheet.
  await markdowny.locator('[data-extension=farcaster] button', { hasText: 'thread' }).click();
  const sheet = page.getByRole('dialog', { name: 'thread' });
  await expect(sheet).toContainText('Replying to myself.');
  await page.keyboard.press('Escape');

  // Select a passage in the cast, then stub it.
  await cast.evaluate((entry) => {
    const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf('Now most years it does not.');
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 'Now most years it does not.'.length);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    throw new Error('passage not found');
  });
  await cast.locator('[data-action="stub"]').first().click();
  await expect(page.locator('#md-input')).toHaveValue('> Now most years it does not.\n\n');
  await expect(page.locator('.stub-head')).toContainText('farcaster.xyz/riverkeeper/');

  // A stub with no words of the owner's own is blocked, with the reason.
  await publishInEditor(page);
  await expect(page.locator('#error-banner-slot')).toContainText('no words of your own');
  await page.locator('#md-input').fill('> Now most years it does not.\n\nThe delta remembers the river.');
  await publishInEditor(page);
  await expect(page.locator('#published-banner')).toBeVisible();
  const stubId = new URL(page.url()).pathname.split('/').pop()!;
  const doc = await (await page.request.get(`/items/${stubId}.json`)).json();
  expect(doc.stub_of).toMatchObject({ url: expect.stringContaining('farcaster.xyz/riverkeeper/'), cited: { source: expect.stringMatching(/^River Keeper \(@riverkeeper\) on Farcaster, cast 0x[0-9a-f]{8}, fid 900001$/) } });

  // The reply offer, on the owner's own action only.
  const panel = page.locator('#farcaster-panel');
  await expect(panel.locator('#fc-reply')).toBeVisible();
  await panel.locator('#fc-reply').click();
  await expect(panel.locator('.fc-records')).toContainText('reply · cast');

  // The reader marks the cast as stubbed.
  await page.goto(`/studio/reading?sub=${sub.id}`);
  await expect(cast.locator('.fc-stubbed')).toHaveText('stubbed ↗');

  // Cross-posting: off by default, on by the item's toggle, status shown.
  const created = await api(page, 'POST', '/items', { content_md: 'A fragment for the canyon.' });
  await page.goto(`/studio/edit/${created.json.id}`);
  await expect(page.locator('#fc-crosspost')).not.toBeChecked();
  await page.locator('#fc-crosspost').check();
  await expect(page.locator('#fc-crosspost')).toBeChecked();
  await publishInEditor(page);
  await expect(page.locator('#farcaster-panel .fc-records')).toContainText('v1 · cast');

  // Leave the shared fixture database as other specs expect it.
  await api(page, 'DELETE', `/subscriptions/${sub.id}`);
  await api(page, 'PATCH', '/settings', { extensions: [] });
  expect(errors).toEqual([]);
});
