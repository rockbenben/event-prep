/** 针对清单恢复、并发笔记和旧数据迁移的真实浏览器回归。 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium, firefox, webkit } from 'playwright';
import { buildSite } from '../src/lib/build.ts';
const root = await mkdtemp(path.join(tmpdir(), 'eventprep-browser-'));
const content = path.join(root, 'content');
const out = path.join(root, 'dist');
const dir = path.join(content, 'demo');
let server;
try {
  await mkdir(dir, { recursive: true });
  const talk = '#### 09:00–10:00 · Workshop\n- 形式: 演讲\n- 会场: Main\n';
  await writeFile(path.join(dir, 'event.md'), '---\ntitle: 回归活动\n---\n## 日程\n### Day 1\n' + talk + '#### 10:00–11:00 · Unique\n- 形式: 演讲\n- 会场: Main\n### Day 2\n' + talk + '\n## 行前清单\n- [ ] A\n- [ ] B\n- [x] Default\n\n## 信息来源与待确认\n' + '内容\n\n'.repeat(80));
  await writeFile(path.join(dir, 'summary.md'), '合法的无目录总结。');
  await writeFile(path.join(dir, '20261105-raw.md'), 'first\r\nsecond');
  assert.equal((await buildSite({ contentDir: content, outDir: out })).ok, true);
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const file = path.join(out, url.pathname, url.pathname.endsWith('/') ? 'index.html' : '');
      const body = await readFile(file);
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
      res.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const requested = process.argv[2];
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    if (requested && requested !== name) continue;
    const browser = await engine.launch();
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(base + '/demo/');
      const boxes = page.locator('[data-check-id]');
      const click = async i => boxes.nth(i).evaluate(el => el.click());
      await click(0); await page.reload(); await click(1); await click(2); await page.reload();
      assert.equal(await boxes.nth(0).isChecked(), true);
      assert.equal(await boxes.nth(1).isChecked(), true);
      assert.equal(await boxes.nth(2).isChecked(), false);
      const buttons = page.locator('[data-note-key]');
      const oldKeys = await buttons.evaluateAll(els => els.map(el => el.dataset.legacyNoteKey));
      await page.evaluate(keys => localStorage.setItem('eventprep:notes:demo', JSON.stringify({ [keys[0]]: 'ambiguous', [keys[1]]: 'legacy unique' })), oldKeys);
      await page.reload();
      assert.equal(await page.locator('.agenda-note-input').nth(0).inputValue(), '');
      assert.equal(await page.locator('.agenda-note-input').nth(1).inputValue(), 'legacy unique');
      assert.equal(await page.locator('.agenda-note details').count(), 2);
      const other = await ctx.newPage(); await other.goto(base + '/demo/');
      const edit = async (p, index, text) => p.locator('.agenda-note-input').nth(index).evaluate((el, text) => {
        el.value = text; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('blur'));
      }, text);
      await edit(page, 0, 'first'); await edit(other, 2, 'second'); await page.reload();
      assert.equal(await page.locator('.agenda-note-input').nth(0).inputValue(), 'first');
      assert.equal(await page.locator('.agenda-note-input').nth(2).inputValue(), 'second');
      await edit(page, 1, ''); await page.reload();
      assert.equal(await page.locator('.agenda-note-input').nth(1).inputValue(), '');
      await page.evaluate(() => { window.scrollTo({ top: 1000, behavior: 'instant' }); window.dispatchEvent(new Event('pagehide')); });
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('eventprep:scroll:demo')));
      assert.equal(saved.y, 1000);
      await page.goto(base + '/demo/summary/');
      assert.equal(await page.locator('#toc-open').count(), 0);
      await page.goto(base + '/demo/raw/20261105/#L1');
      assert.equal(await page.locator('.raw-line').count(), 2);
      await ctx.close();
      console.log(`${name}: 清单续写、默认取消、跨天笔记、并发保存、旧笔记与删除、立即离页全部通过`);
    } finally { await browser.close(); }
  }
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
