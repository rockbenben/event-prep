/**
 * 生成 README 用的截图，外加一张社交分享卡。
 *
 * 产出三张：
 *   docs/images/home.png    首页（浅色，1280×720）
 *   docs/images/event.png   活动页（浅色，1280×720）
 *   docs/images/og-image.png 分享卡（浅色，1200×630）
 *
 * 浅色而不是深色：README 是浅色底，深色截图放上去像贴了个补丁；
 * 分享卡同理（微信/Reddit/Slack 多数场景下分享卡跟浅色界面更搭）。
 *
 * ⚠️ 分享卡的**尺寸**是刻意的：og:image 的标准比例约 1.91:1（1200×630）。
 *    直接把 1280×720 的 README 截图拿来当分享卡，比例是 16:9，
 *    微信/Reddit 会**裁切**而不是等比缩放——精心截的首页顶部会被切掉。
 *    所以这里单独拍一张，视口就设成 1200×630，deviceScaleFactor 用 1，
 *    保证文件正好 1200×630（跟 og:image:width/height 对得上）。
 */

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 截图拍的是**正式内容**（content/ → dist/），不是 examples/ 里的占位数据
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'docs', 'images');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
};

function startServer(root) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        res.writeHead(400).end('bad request');
        return;
      }
      let file = path.join(root, pathname);
      // 路径守卫用相对路径判断：字符串前缀会放行 …/dist-evil/x（它仍以 …/dist 开头）
      const relative = path.relative(root, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      // 目录式路径（无扩展名）补 index.html
      if (!path.extname(file)) {
        const indexed = path.join(file, 'index.html');
        if (existsSync(indexed)) file = indexed;
      }
      // 缺就如实 404（跟验收服务器同一口径，两边都不要再拿首页冒充资源）
      if (!existsSync(file)) {
        res.writeHead(404).end('not found');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    });
    server.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

if (!existsSync(DIST)) {
  console.error('没有 dist/，先跑：npm run build');
  process.exit(1);
}
await mkdir(OUT, { recursive: true });

const { server, port } = await startServer(DIST);
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
});
const page = await context.newPage();

await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, 'home.png') });

const slug = await page.evaluate(
  `(() => { const el = document.querySelector('[data-event-slug]'); return el ? el.getAttribute('data-event-slug') : null; })()`,
);
if (slug) {
  await page.goto(`http://localhost:${port}/${slug}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'event.png') });
}

// 分享卡：单独一个上下文（尺寸跟上面两张不一样）
// ⚠️ deviceScaleFactor 用 1，不是 2：og:image:width/height 写死 1200×630，
//    那么产出的 PNG 就必须**正好**是 1200×630 个像素。2× 拍出来的是 2400×1260，
//    meta 说的和文件实际是的两码事——爬虫按 meta 的比例裁，微信按文件的实际尺寸裁，
//    两边一对不上就会裁出意外结果。1× 下首页大字仍然清楚（分享卡本来也没多少小字）。
{
  const ogContext = await browser.newContext({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  });
  const ogPage = await ogContext.newPage();
  await ogPage.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle' });
  await ogPage.waitForTimeout(400);
  await ogPage.screenshot({ path: path.join(OUT, 'og-image.png') });
  await ogContext.close();
}

await context.close();
await browser.close();
server.close();

console.log(`截图已写入 ${path.relative(ROOT, OUT)}/`);
