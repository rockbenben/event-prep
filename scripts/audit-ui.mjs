/**
 * 浏览器验收：把构建产物在真实浏览器里跑一遍。
 *
 * 查的是源码看不出来的东西：
 *   · 整页横向溢出（手机上最常见的问题）
 *   · 宽表格是不是在自己的盒子里横向滚动（而不是把整页撑开）
 *   · 行前清单勾选后刷新还在不在
 *   · 深浅色切换有没有真的换
 *   · 键盘能不能走到折叠块和复选框
 *   · 页面引用的资源是不是真的拿到了（4xx/5xx 与请求失败都算没过）
 *
 * 用法：node scripts/audit-ui.mjs [--dist dist] [--out .audit] [--engine chromium]
 *   --dist   要审的产物目录（默认 dist/；`npm run audit:ui` 审的是 dist-examples/）
 *   --out    截图与 report.json 的落点
 *   --engine 只跑一个引擎（CI 用矩阵并行跑三个）
 */

import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 三个引擎都跑一遍。
 * 手写 CSS / 原生 JS 最容易在别的引擎上出问题（细节标记、focus 轮廓、表格滚动），
 * 只跑 Chromium 等于把风险留到线上。
 */
const ENGINES = { chromium, firefox, webkit };

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = path.resolve(ROOT, outIdx >= 0 ? args[outIdx + 1] : '.audit');
const distIdx = args.indexOf('--dist');
const DIST = path.resolve(ROOT, distIdx >= 0 ? args[distIdx + 1] : 'dist');
// 只跑一个引擎（CI 用矩阵并行跑），不传就三个都跑
const engineIdx = args.indexOf('--engine');
const ONLY_ENGINE = engineIdx >= 0 ? args[engineIdx + 1] : null;
const ENGINES_TO_RUN = ONLY_ENGINE
  ? { [ONLY_ENGINE]: ENGINES[ONLY_ENGINE] }
  : ENGINES;
if (ONLY_ENGINE && !ENGINES[ONLY_ENGINE]) {
  console.error(`没有这个引擎：${ONLY_ENGINE}（可用：${Object.keys(ENGINES).join(', ')}）`);
  process.exit(1);
}

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
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
        // 畸形 URL 不能把服务器带崩
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
      // 缺就如实 404：以前不管缺什么都回 200 + 首页，
      // 坏掉的资源链接在验收里看起来是好的（验收自己也量不到 404）
      if (!existsSync(file)) {
        res.writeHead(404).end('not found');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    });
    // 只绑回环：默认 listen 会绑所有网卡
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/**
 * 找出所有横向溢出视口的元素。
 * 注意：传给 page.evaluate 的字符串必须是个**求值结果**，所以要写成 IIFE，
 * 直接写 `() => {...}` 会被当成函数对象，返回 undefined。
 */
const OVERFLOW_PROBE = `(() => {
  const docWidth = document.documentElement.clientWidth;
  const offenders = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    // 只看**右边**越界：往左越界的是「跳到正文」这类故意藏在屏幕外的元素，
    // 不会造成横向滚动条
    if (r.right > docWidth + 1) {
      const style = getComputedStyle(el);
      // 元素自己在滚动的（宽表格）不算整页溢出
      const scrollable = style.overflowX === 'auto' || style.overflowX === 'scroll';
      const inScrollable = el.closest('.content table');
      if (scrollable || inScrollable) continue;
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: el.className && String(el.className).slice(0, 60),
        left: Math.round(r.left),
        right: Math.round(r.right),
      });
    }
  }
  return { docWidth, scrollWidth: document.documentElement.scrollWidth, offenders: offenders.slice(0, 10) };
})()`;

const results = [];
let failures = 0;
/** 当前引擎名，写进每条检查的名字里，免得三个引擎的结果混在一起看不懂。 */
let currentEngine = '';

function record(name, ok, detail) {
  const label = currentEngine ? `${currentEngine} · ${name}` : name;
  results.push({ name: label, ok, detail });
  if (!ok) failures += 1;
  const mark = ok ? '✓' : '✗';
  console.log(`  ${mark} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  if (!existsSync(DIST)) {
    console.error('没有 dist/，先跑 npm run build。');
    process.exit(1);
  }
  await mkdir(OUT, { recursive: true });

  const { server, port } = await startServer(DIST);
  const base = `http://localhost:${port}`;

  try {
    for (const [name, launcher] of Object.entries(ENGINES_TO_RUN)) {
      console.log(`\n========== ${name} ==========`);
      currentEngine = name;
      const browser = await launcher.launch();
      try {
        await runChecks(browser, base);
      } finally {
        await browser.close();
      }
    }
  } finally {
    server.close();
  }

  await writeFile(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2), 'utf8');

  console.log(`\n${results.length - failures}/${results.length} 项通过。截图在 ${OUT}`);
  if (failures > 0) {
    console.error(`\n有 ${failures} 项没过。`);
    process.exit(1);
  }
}

/** 一个浏览器引擎上的全部检查。 */
async function runChecks(browser, base) {
  // 首页与每个活动页都过一遍
  const pages = [];
  pages.push({ name: 'home', path: '/' });

  const homeHtml = await readFile(path.join(DIST, 'index.html'), 'utf8');
  const slugs = [...homeHtml.matchAll(/data-event-slug="([^"]+)"/g)].map((m) => m[1]);
  for (const slug of slugs) pages.push({ name: slug, path: `/${slug}/` });

  for (const vp of VIEWPORTS) {
    console.log(`\n${vp.name} ${vp.width}×${vp.height}`);
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      colorScheme: 'light',
    });
    const page = await context.newPage();

    for (const target of pages) {
      await page.goto(`${base}${target.path}`, { waitUntil: 'networkidle' });

      // 1. 整页横向溢出
      const probe = await page.evaluate(OVERFLOW_PROBE);
      record(
        `${target.name} · 整页无横向溢出`,
        probe.scrollWidth <= probe.docWidth + 1 && probe.offenders.length === 0,
        probe.offenders.length
          ? `scrollWidth=${probe.scrollWidth} docWidth=${probe.docWidth} 越界元素=${JSON.stringify(probe.offenders)}`
          : `scrollWidth=${probe.scrollWidth} docWidth=${probe.docWidth}`,
      );

      // 2. 宽表格在自己的盒子里滚，不撑破整页
      const tableInfo = await page.evaluate(`(() => {
        const tables = [...document.querySelectorAll('.content table')];
        return tables.map((t) => ({
          scrollW: t.scrollWidth,
          clientW: t.clientWidth,
          overflowX: getComputedStyle(t).overflowX,
        }));
      })()`);
      const badTable = tableInfo.find((t) => t.overflowX !== 'auto' && t.overflowX !== 'scroll');
        record(`${target.name} · 宽表格自带横向滚动`, !badTable, badTable ? JSON.stringify(badTable) : '');

      // 3.5 日程卡片：窄屏不许横向滚；展开简介不能打乱别的卡片
      //
      // ⚠️ 「卡片位置」量的是**横向布局**（left/width）与**同一行内**的上下位置，
      //    不是「下一张卡的 top 一动不动」：
      //    日程是一列一行，展开必然把下面那张卡往下推——那是内容变高，不是布局被打乱。
      //    真正要防的是表格时代那个毛病：展开单元格里的 details 让整表内容宽 +112px，
      //    列宽重新分配，读者刚建立的横向位置失效。
      //    展开的对象优先选讲者简介的 tip 图标（那是现在唯一的点开式元素）。
      {
        const probeAgenda = `(() => {
          // ⚠️ **只量展开着的那几天里的卡片**：过了的日程会自动收起，
          //    收起那天的卡片在 DOM 里但不可见（高宽为 0），
          //    点它会超时（实测「element is not visible」）。
          //    所以先按「所在的 <details> 是开着的」过滤。
          const all = [...document.querySelectorAll('.agenda-card')];
          const cards = all.filter((c) => {
            const day = c.closest('.agenda-day-block');
            return !day || day.open;
          });
          if (!cards.length) return null;
          const docWidth = document.documentElement.clientWidth;
          const over = cards.filter((c) => c.getBoundingClientRect().right > docWidth + 1).length;
          const withTip = cards.findIndex((c) => c.querySelector('.agenda-tip-btn'));
          const withAbstract = cards.findIndex((c) => c.querySelector('details.agenda-abstract'));
          // ⚠️ scrollY **一次读，全部卡片共用**：滚动着的页面里，
          //    每张卡各读一次 scrollY，量到的位置会互相对不上。
          //    页面停下来的时候（下面会等它停稳），两种读法一样。
          const scrollY = window.scrollY;
          return {
            cards: cards.length,
            total: all.length,
            overflowing: over,
            withTip,
            withAbstract,
            scrollY: Math.round(scrollY),
            boxes: cards.map((c) => {
              const r = c.getBoundingClientRect();
              return {
                left: Math.round(r.left),
                width: Math.round(r.width),
                top: Math.round(r.top + scrollY),
              };
            }),
          };
        })()`;
        const before = await page.evaluate(probeAgenda);
        if (before) {
          record(
            `${target.name} · 日程 · 窄屏无横向溢出`,
            before.overflowing === 0,
            `卡片 ${before.cards} 张，越界 ${before.overflowing} 张`,
          );
          const useTip = before.withTip >= 0;
          const index = useTip ? before.withTip : before.withAbstract;
          if (index >= 0) {
            // ⚠️ **定位要按卡片来，别按 `.agenda-tip-btn` 的全局序号**：
            //    提示图标有两类（讲者简介 / 看这一场之前要知道的事），
            //    一张卡上可能挂两个。全局第 N 个图标跟「第 N 张卡」根本不是一回事——
            //    实测：卡片 #1 同时有备注图标和简介图标时，
            //    全局 nth(1) 恰好是它的简介图标，序号对上了纯属运气；
            //    换个内容就点开**另一张卡**的图标，量出来的位移当然对不上。
            //    所以：先定位到卡片，再在**这张卡里**找图标。
            // ⚠️ 卡片要按「展开着的那几天」过滤后的集合数——
            //    过了的日程自动收起了，`.agenda-card` 的全局序号会数到看不见的卡。
            const VISIBLE_CARDS = '.agenda-day-block[open] .agenda-card';
            const card = page.locator(VISIBLE_CARDS).nth(index);
            const bioBtn = card.locator('.agenda-tip-bio .agenda-tip-btn');
            const hasBio = (await bioBtn.count()) > 0;
            const target = hasBio
              ? bioBtn.first()
              : useTip
                ? card.locator('.agenda-tip-btn').first()
                : card.locator('details.agenda-abstract summary').first();
            const openSelector = useTip ? '.agenda-tip-toggle[open]' : 'details.agenda-abstract[open]';

            // ⚠️ **先把要点的那张卡滚到可视区，并等滚动停稳**，再量「之前」。
            //    正文有 scroll-behavior: smooth，Playwright 的 click 会先滚动到元素；
            //    动画还没停就量位置，量到的是动画中间的一帧——
            //    探针里 `r.top` 和 `window.scrollY` 是先后读的，动画中两者对不上，
            //    算出来的文档位置能差好几像素（实测 9px）。
            //    停稳之后再点，点击就不会再触发滚动，前后两次量的是同一个静止状态。
            await page.evaluate(`(() => {
              const cards = [...document.querySelectorAll('.agenda-day-block[open] .agenda-card')];
              const el = cards[${index}];
              if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' });
            })()`);
            await page.evaluate(`(() => new Promise((resolve) => {
              let last = window.scrollY;
              let stable = 0;
              const tick = () => {
                if (window.scrollY === last) stable += 1;
                else { stable = 0; last = window.scrollY; }
                if (stable >= 3) resolve(true);
                else requestAnimationFrame(tick);
              };
              requestAnimationFrame(tick);
            }))()`);

            const settled = await page.evaluate(probeAgenda);
            await target.click();
            // 等它真的展开，而不是「睡 150ms 说不定好了」
            await page.waitForFunction(`(() => {
              const cards = [...document.querySelectorAll('.agenda-day-block[open] .agenda-card')];
              const card = cards[${index}];
              return !!card && !!card.querySelector(${JSON.stringify(openSelector)});
            })()`);
            const after = await page.evaluate(probeAgenda);
            const rowTop = settled.boxes[index].top;
            const moved = [];
            for (let i = 0; i < settled.boxes.length; i += 1) {
              const b = settled.boxes[i];
              const a = after.boxes[i];
              const sameRow = b.top === rowTop;
              if (a.left !== b.left || a.width !== b.width || (sameRow && a.top !== b.top)) {
                moved.push(
                  `#${i} 左${b.left}宽${b.width}上${b.top} → 左${a.left}宽${a.width}上${a.top}` +
                    `（滚动 ${settled.scrollY} → ${after.scrollY}）`,
                );
              }
            }
            record(
              `${target.name} · 日程 · 展开简介不改变卡片位置`,
              moved.length === 0,
              moved.length
                ? moved.join('；')
                : `展开第 ${index + 1} 张的${useTip ? (hasBio ? '讲者简介' : '备注') : '摘要'}，其余卡片未动`,
            );
          } else {
            // ⚠️ 前提不满足时也要记一条，不能什么都不记：
            //    悄悄不执行 = 闸门是装饰（这条检查要能真的抓住「展开打乱了别的卡片」）。
            record(
              `${target.name} · 日程 · 展开简介不改变卡片位置`,
              false,
              '没有一张卡片带可展开的简介或摘要，这条检查没法执行（内容要保证至少有一场写了讲者简介或摘要）',
            );
          }
        }
      }

      // 3.6 开始时刻：倒计时锚在议程第一场，页面上写明几点开始
      //
      // ⚠️ 判据是「site-data 里的 startISO 换算到活动时区」==「议程第一场的时间」：
      //    这两件事以前差着一整个上午——倒计时指向当天 00:00，议程从 09:30 才开始。
      //    只验其中一个都不够（页面写对了、倒计时没锚过去，照样错）。
      {
        const probe = await page.evaluate(`(() => {
          const dataEl = document.getElementById('site-data');
          if (!dataEl) return { skipped: '没有 site-data' };
          let data = null;
          try { data = JSON.parse(dataEl.textContent || '{}'); } catch (e) { return { skipped: 'site-data 解析失败' }; }
          const events = data.events || [];

          // startISO 换算到活动时区的 HH:MM
          const clockOf = (ev) => {
            const tz = ev.timezone || 'UTC';
            const parts = new Intl.DateTimeFormat('en-US', {
              timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
            }).formatToParts(new Date(ev.startISO));
            const map = {};
            for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
            return map.hour + ':' + map.minute;
          };

          const isHome = !!document.querySelector('.home');
          const findings = [];

          if (isHome) {
            // 首页：每张卡片都要写对「开始」
            for (const card of document.querySelectorAll('.event-card[data-event-slug]')) {
              const slug = card.getAttribute('data-event-slug');
              const ev = events.find((e) => e.slug === slug);
              if (!ev || !ev.startISO) { findings.push({ slug, skipped: 'site-data 里没有这个活动' }); continue; }
              const cell = [...card.querySelectorAll('.card-meta > div')]
                .filter((d) => (d.querySelector('dt') || {}).textContent === '开始')
                .map((d) => (d.querySelector('dd') || {}).textContent)[0] || null;
              findings.push({ slug, hhmm: clockOf(ev), cell, firstSlot: null });
            }
          } else {
            const slugEl = document.querySelector('[data-event-slug]');
            if (!slugEl) return { skipped: '这一页不是活动页' };
            const ev = events.find((e) => e.slug === slugEl.getAttribute('data-event-slug'));
            if (!ev || !ev.startISO) return { skipped: 'site-data 里没有这个活动' };
            const cell = [...document.querySelectorAll('.meta-row')]
              .filter((r) => (r.querySelector('dt') || {}).textContent === '开始')
              .map((r) => (r.querySelector('dd') || {}).textContent)[0] || null;
            const first = document.querySelector('.agenda-time');
            findings.push({
              slug: ev.slug,
              hhmm: clockOf(ev),
              cell,
              firstSlot: first ? first.textContent.trim() : null,
            });
          }
          return { findings };
        })()`);

        if (probe.skipped) {
          record(`${target.name} · 开始时刻 · 锚在议程第一场`, true, `不适用：${probe.skipped}`);
        } else {
          const problems = [];
          const notes = [];
          for (const f of probe.findings) {
            if (f.skipped) { notes.push(`${f.slug}：${f.skipped}`); continue; }
            const firstTime = f.firstSlot ? f.firstSlot.split(/[–—]/)[0].trim() : null;
            if (f.cell === null && f.hhmm === '00:00') {
              // 没有议程信息 → 按当天 00:00 算，页面上就不该出现「开始」这一行
              if (firstTime !== null) problems.push(`${f.slug}：议程第一场=${firstTime}，但没有议程时刻可用`);
              else notes.push(`${f.slug}：没有议程，按 00:00 算，不显示「开始」`);
              continue;
            }
            if (f.cell !== f.hhmm) {
              problems.push(`${f.slug}：页面「开始」=${f.cell ?? '没有'}，应为 ${f.hhmm}`);
            } else if (firstTime !== null && firstTime !== f.hhmm) {
              problems.push(`${f.slug}：议程第一场=${firstTime}，倒计时却锚在 ${f.hhmm}`);
            }
          }
          record(
            `${target.name} · 开始时刻 · 锚在议程第一场`,
            problems.length === 0,
            problems.length ? problems.join('；') : [...notes, ...probe.findings.map((f) => `${f.slug} ${f.hhmm}`)].join('，'),
          );
        }
      }

      // 3.7 整张卡片都能点进活动（首页）
      //
      // ⚠️ 用真实的鼠标点击，不用 locator.click()：
      //    整卡可点靠的是标题链接的 ::after 伪元素撑满整卡，
      //    Playwright 的可点性检查会把这个伪元素判成「拦截了点击」而报错——
      //    但读者点得到的恰恰就是它。
      if (target.name === 'home') {
        const cardCount = await page.locator('.event-card').count();
        if (cardCount === 0) {
          record('首页 · 点卡片任意处都能进活动', true, '这一页没有卡片（不适用）');
        } else {
          const card = page.locator('.event-card').first();
          const slug = await card.getAttribute('data-event-slug');
          const box = await card.boundingBox();
          if (!box) {
            record('首页 · 点卡片任意处都能进活动', false, '量不到卡片的位置');
          } else {
            // 点卡片右下角：那里既不是标题链接，也不是任何按钮
            await page.mouse.click(box.x + box.width - 10, box.y + box.height - 10);
            let landed = '';
            try {
              await page.waitForURL(new RegExp(`/${slug}/?$`), { timeout: 5000 });
            } catch (e) {
              /* 没跳过去，下面照实记 */
            }
            landed = page.url();
            record(
              '首页 · 点卡片任意处都能进活动',
              new RegExp(`/${slug}/?$`).test(landed),
              `点到卡片角落 → ${landed}`,
            );
            await page.goto(`${base}/`, { waitUntil: 'networkidle' });
          }
        }
      }

        // 3. 截图
        await page.screenshot({
          path: path.join(OUT, `${target.name}-${vp.name}.png`),
          fullPage: false,
        });
        // 活动页再存一张整页的，方便事后一眼看完一整页的节奏
        if (target.name !== 'home') {
          try {
            await page.screenshot({
              path: path.join(OUT, `${target.name}-${vp.name}-full.png`),
              fullPage: true,
            });
          } catch (e) {
            // Firefox 等引擎限制单张位图高度不得超过 32767px，超长页面静默跳过整页大图
          }
        }
      }

      await context.close();
    }

    // 4. 清单勾选后刷新还在（只在桌面尺寸测一次）
    console.log('\n交互');
    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      await page.goto(`${base}/`, { waitUntil: 'networkidle' });
      const slug = await page.evaluate(
        `(() => { const el = document.querySelector('[data-event-slug]'); return el ? el.getAttribute('data-event-slug') : null; })()`,
      );
      if (slug) {
        await page.goto(`${base}/${slug}/`, { waitUntil: 'networkidle' });
        // ⚠️ 行前清单现在默认收在 <details class="checklist-fold"> 里：
        //    收起时复选框不可见，Playwright 的 .check() 会判成「元素被隐藏」而超时。
        //    先展开再勾（这一步也顺带验了「点得开」）。
        await page.evaluate(`(() => {
          const f = document.querySelector('.checklist-fold');
          if (f) f.open = true;
        })()`);
        const box = page.locator('input[type="checkbox"][data-check-id]').first();
        const count = await page.locator('input[type="checkbox"][data-check-id]').count();
        if (count > 0) {
          await box.check();
          await page.reload({ waitUntil: 'networkidle' });
          const stillChecked = await page
            .locator('input[type="checkbox"][data-check-id]')
            .first()
            .isChecked();
          record('行前清单 · 刷新后勾选还在', stillChecked);

          // 换个活动不能串号
          if (slugs.length > 1) {
            const other = slugs.find((s) => s !== slug);
            await page.goto(`${base}/${other}/`, { waitUntil: 'networkidle' });
            const otherChecked = await page
              .locator('input[type="checkbox"][data-check-id]')
              .first()
              .isChecked()
              .catch(() => false);
            record('行前清单 · 活动之间互不干扰', !otherChecked);
          }
        } else {
          record('行前清单 · 找到复选框', false, '页面上没有复选框');
        }
      }

      // 5. 深浅色切换
      await page.goto(`${base}/`, { waitUntil: 'networkidle' });
      const before = await page.evaluate(`(() => document.documentElement.getAttribute('data-theme'))()`);
      await page.locator('#theme-toggle').click();
      const after = await page.evaluate(`(() => document.documentElement.getAttribute('data-theme'))()`);
      record('深浅色 · 手动切换生效', before !== after && Boolean(after), `${before} → ${after}`);

      // 5.5 说明性内容收成点开式条目：默认收起，点一下能展开
      // 「机构与嘉宾」「前置知识」都取消成独立章节了，现在唯一的点开式元素是
      // 日程卡片里的提示图标（讲者简介 / 看这场之前要知道的事）。
      await page.goto(`${base}/${slug}/`, { waitUntil: 'networkidle' });
      // ⚠️ **只认展开着的那几天里的提示图标**：过了的日程自动收起，
      //    收起那天的图标在 DOM 里但不可见（点它会超时）。
      const VISIBLE_TIP = '.agenda-day-block[open] .agenda-tip-btn';
      const tipCount = await page.locator(VISIBLE_TIP).count();
      if (tipCount > 0) {
        const first = page.locator(VISIBLE_TIP).first();
        const openBefore = await first.evaluate((el) => el.closest('details')?.open);
        // 收起时占多高（点开之前量）——正文是按钮的相邻兄弟，取紧跟自己的那个
        const collapsedHeight = await first.evaluate((el) => {
          const body = el.closest('.agenda-tip')?.querySelector('.agenda-tip-body');
          return body ? body.getBoundingClientRect().height : 0;
        });
        await first.click();
        const openAfter = await first.evaluate((el) => el.closest('details')?.open);
        const expandedHeight = await first.evaluate((el) => {
          const body = el.closest('.agenda-tip')?.querySelector('.agenda-tip-body');
          return body ? body.getBoundingClientRect().height : 0;
        });
        record('提示图标 · 默认收起且点得开', openBefore === false && openAfter === true, `收起=${openBefore} 展开=${openAfter}`);
        record('提示图标 · 收起时不占地方', collapsedHeight < expandedHeight, `${Math.round(collapsedHeight)}px → ${Math.round(expandedHeight)}px`);
        record('提示图标 · 点开后正文出现', expandedHeight > 0, `正文高 ${Math.round(expandedHeight)}px`);
        // 点一个只开一个：别的提示不该跟着冒出来
        // ⚠️ 只数**展开着的那几天**里的正文：收起那天的正文本来就看不见，
        //    数进去会把「本来就收着」误判成「跟着冒出来了」。
        const openedBodies = await page.locator('.agenda-day-block[open] .agenda-tip-body:visible').count();
        const totalTips = await page.locator(VISIBLE_TIP).count();
        record('提示图标 · 点一个只开一个', openedBodies <= 1, `点开后可见正文 ${openedBodies} 段（展开的日程里共 ${totalTips} 个提示）`);
      } else {
        record('提示图标 · 页面上有提示图标', false, '没有找到 .agenda-tip-btn');
      }

      // 5.5b 头像点开放大
      // ⚠️ 同样只认展开着的那几天里的头像（收起那天的不可见，点它会超时）
      const VISIBLE_AVATAR = '.agenda-day-block[open] .agenda-avatar-btn';
      const avatarCount = await page.locator(VISIBLE_AVATAR).count();
      if (avatarCount > 0) {
        await page.locator(VISIBLE_AVATAR).first().click();
        await page.waitForTimeout(200);
        const opened = await page.evaluate(`(() => {
          const d = document.getElementById('avatar-viewer');
          const img = document.getElementById('avatar-viewer-img');
          return { open: Boolean(d && d.open), src: img ? img.getAttribute('src') : '' };
        })()`);
        record('头像 · 点开能放大', opened.open && opened.src !== '', JSON.stringify(opened));
        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
        const closed = await page.evaluate(`(() => Boolean(document.getElementById('avatar-viewer')?.open))()`);
        record('头像 · Esc 能关掉', closed === false, `open=${closed}`);
      } else {
        record('头像 · 点开能放大', false, '没有找到 .agenda-avatar-btn');
      }

      // 5.6 活动页头部基本信息：桌面摊开，手机收成一行
      {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(`${base}/${slug}/`, { waitUntil: 'networkidle' });
        const wideOpen = await page.evaluate(`(() => { const d = document.querySelector('[data-event-meta]'); return d ? d.open : null; })()`);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(200);
        const narrowOpen = await page.evaluate(`(() => { const d = document.querySelector('[data-event-meta]'); return d ? d.open : null; })()`);
        record('头部信息 · 桌面摊开 / 手机收起', wideOpen === true && narrowOpen === false, `宽屏=${wideOpen} 窄屏=${narrowOpen}`);
        await page.setViewportSize({ width: 1280, height: 900 });
      }

      // 5.7 导出 Markdown：活动页底部有个下载链接，点开真的能拿到内容源文件
      //
      // ⚠️ 这里量的是**文件本身**，不是链接长什么样：
      //    链接指向的 .md 必须能拿到（200），而且得是能塞回 content/ 的源文件
      //    （带 front matter、有 title），不然「下载下来改一改」这条闭环是断的。
      {
        await page.goto(`${base}/${slug}/`, { waitUntil: 'networkidle' });
        const links = page.locator('a.export-link');
        const count = await links.count();
        if (count === 0) {
          record('导出 Markdown · 活动页有下载链接', false, '没有找到 a.export-link');
        } else {
          const href = await links.first().getAttribute('href');
          record('导出 Markdown · 活动页有下载链接', href === 'event.md', `href=${href}`);
          const res = await page.request.get(`${base}/${slug}/${href}`);
          const text = await res.text();
          const looksLikeSource = text.startsWith('---') && /(^|\n)title:/.test(text);
          record(
            '导出 Markdown · 拿到的就是内容源文件',
            res.ok() && looksLikeSource,
            `HTTP ${res.status()}，${text.length} 字节${looksLikeSource ? '' : '，不是带 front matter 的源文件'}`,
          );

          // 5.8 front matter 里声明了 venue_url，页面上就要能点到那个地址
          //
          // ⚠️ 判据取自**源文件自己**（就是刚拿到的 .md）：
          //    活动没写 venue_url 时不能判失败（那是没有，不是坏），
          //    写了却点不到才是回归。
          const declared = text.match(/^venue_url:\s*(\S+)\s*$/m);
          const pageLinks = await page.evaluate(`(() => {
            const out = [];
            const meta = document.querySelector('.meta-row .meta-link');
            if (meta) out.push(meta.getAttribute('href'));
            for (const a of document.querySelectorAll('.actions a')) {
              if (a.textContent.trim() === '场地') out.push(a.getAttribute('href'));
            }
            return out;
          })()`);
          if (!declared) {
            record('场地 · 声明了就点得到', true, '这个活动没有 venue_url（不适用）');
          } else {
            const url = declared[1];
            record(
              '场地 · 声明了就点得到',
              pageLinks.includes(url),
              `front matter 写了 ${url}，页面上可点的地址：${pageLinks.join('、') || '（一个都没有）'}`,
            );
          }
        }
      }

      // 5.9 目录：顶栏按钮点开就是侧边目录，并且标出「现在读到哪一节」
      //
      // ⚠️ 目录住在抽屉里，所以「看得见」的前提是**先把抽屉打开**——
      //    不开就量，量到的是关着的抽屉（尺寸为 0），测出来的是假象。
      {
        await page.goto(`${base}/${slug}/`, { waitUntil: 'networkidle' });
        const tocInfo = await page.evaluate(`(() => {
          const toc = document.querySelector('.toc');
          if (!toc) return null;
          const links = [...toc.querySelectorAll('a[href^="#"]')];
          return { count: links.length, texts: links.map((a) => a.textContent.trim()) };
        })()`);
        const openBtn = page.locator('#toc-open');
        const hasBtn = (await openBtn.count()) > 0;
        record('目录 · 顶栏有入口', hasBtn && tocInfo !== null && tocInfo.count > 0, `按钮=${hasBtn} 条目=${tocInfo ? tocInfo.count : 0}`);
        if (hasBtn && tocInfo && tocInfo.count > 0) {
          await openBtn.click();
          await page.waitForTimeout(350);
          const drawer = await page.evaluate(`(() => {
            const d = document.getElementById('toc-drawer');
            if (!d) return null;
            const r = d.getBoundingClientRect();
            return {
              open: d.open,
              left: Math.round(r.left),
              width: Math.round(r.width),
              height: Math.round(r.height),
              links: d.querySelectorAll('a[href^="#"]').length,
            };
          })()`);
          record(
            '目录 · 点开是侧边目录',
            Boolean(drawer && drawer.open && drawer.links > 0 && drawer.left <= 1 && drawer.width > 200),
            JSON.stringify(drawer),
          );

          // 挑中间那一节：第一节贴着页顶、最后一节贴着页尾，都测不出粘性
          const targetText = tocInfo.texts[Math.min(2, tocInfo.texts.length - 1)];
          await page.evaluate(`(() => {
            const toc = document.querySelector('.toc');
            const link = [...toc.querySelectorAll('a[href^="#"]')].find((a) => a.textContent.trim() === ${JSON.stringify(
              targetText,
            )});
            if (!link) return;
            const el = document.getElementById(decodeURIComponent(link.getAttribute('href').slice(1)));
            if (!el) return;
            // ⚠️ 偏移要跟正文的 scroll-margin-top 一致（头部高 + 18）：
            //    点目录时浏览器就是这样落的，偏移不一致的话
            //    「当前章节」的判定跟真实使用对不上，测出来的是假象。
            const header = document.querySelector('.site-header');
            const offset = (header ? header.getBoundingClientRect().height : 58) + 18;
            // ⚠️ 必须用 instant：正文有 scroll-behavior: smooth，scrollTo 是**动画**。
            //    动画跑到哪儿算哪儿，CI 机器慢时还没滚到位就断言，量到的是上一节
            //    （实测「当前=日程，期望=推荐路线」）——那测的是动画进度，
            //    不是「目录标出当前章节」这件事本身。
            window.scrollTo({
              top: el.getBoundingClientRect().top + window.scrollY - offset,
              behavior: 'instant',
            });
          })()`);
          // 目录高亮是在 rAF 里跟出来的：等它落定，别拿固定时长去猜
          await page
            .waitForFunction(
              (want) => {
                const cur = document.querySelector('.toc a[aria-current]');
                return Boolean(cur) && cur.textContent.trim() === want;
              },
              targetText,
              { timeout: 5000 },
            )
            .catch(() => {});
          const current = await page.evaluate(`(() => {
            const cur = document.querySelector('.toc a[aria-current]');
            return cur ? cur.textContent.trim() : null;
          })()`);
          record('目录 · 标出当前章节', current === targetText, `当前=${current} 期望=${targetText}`);

          await page.keyboard.press('Escape');
          await page.waitForTimeout(250);
          const closed = await page.evaluate(`(() => { const d = document.getElementById('toc-drawer'); return d ? !d.open : false; })()`);
          record('目录 · Esc 能关掉', closed);
        }
      }

      // 5.10 回到顶部：滚动后出现，点一下真的回到顶部
      {
        await page.goto(`${base}/${slug}/`, { waitUntil: 'networkidle' });
        // ⚠️ 同样用 instant：按钮的出现取决于 scrollY > 300，
        //    平滑滚动没走到那儿就量，量到的是动画中途（实测 CI 上时有时无）。
        await page.evaluate(`window.scrollTo({ top: 1500, behavior: 'instant' })`);
        await page.waitForTimeout(150);
        const btn = page.locator('#back-to-top');
        const count = await btn.count();
        if (count === 0) {
          record('回到顶部 · 滚动后出现', false, '页面上没有回到顶部按钮');
        } else {
          // 按钮的显隐在 scroll 事件后的 rAF 里更新：等它真的出现，别猜
          await page
            .waitForFunction(
              () => {
                const el = document.getElementById('back-to-top');
                return Boolean(el) && el.className.includes('visible');
              },
              undefined,
              { timeout: 5000 },
            )
            .catch(() => {});
          const shown = await btn.evaluate(
            (el) => el.className.includes('visible') && getComputedStyle(el).visibility === 'visible',
          );
          record('回到顶部 · 滚动后出现', shown === true);
          if (shown) {
            await btn.click();
            // 平滑滚动要等它走完
            let y = 1500;
            for (let i = 0; i < 30 && y >= 40; i += 1) {
              await page.waitForTimeout(100);
              y = await page.evaluate('Math.round(window.scrollY)');
            }
            record('回到顶部 · 点一下回到顶部', y < 40, `scrollY=${y}`);
          }
        }
      }

      // 5.11 读者自己的笔记：每场都有入口，写进去刷新后还在
      //
      // ⚠️ 这是**本机个人数据**：不、不同步、不会被清理。
      //    所以验收要验的是「刷新后还在」——不是「刷新后没了」。
      {
        await page.goto(`${base}/${slug}/`, { waitUntil: 'networkidle' });
        // ⚠️ 只认展开着的那几天里的入口（收起那天的按钮不可见，点它会超时）
        const VISIBLE_NOTE = '.agenda-day-block[open] .agenda-note-btn';
        const count = await page.locator(VISIBLE_NOTE).count();
        if (count === 0) {
          record('笔记 · 每场都有入口', false, '没有找到 .agenda-note-btn');
        } else {
          record('笔记 · 每场都有入口', true, `${count} 场`);
          const marker = `验收笔记 ${Date.now()}`;
          await page.locator(VISIBLE_NOTE).first().click();
          await page.waitForTimeout(150);
          await page.locator('.agenda-day-block[open] .agenda-note-input').first().fill(marker);
          await page.waitForTimeout(500);
          await page.reload({ waitUntil: 'networkidle' });
          const kept = await page.evaluate(`(() => {
            const input = document.querySelector('.agenda-day-block[open] .agenda-note-input');
            const block = input ? input.closest('.agenda-note') : null;
            return { value: input ? input.value : '', marked: block ? block.className : '' };
          })()`);
          record('笔记 · 写进去刷新后还在', kept.value === marker, kept.value);
          record('笔记 · 有笔记的场次有标记', kept.marked.includes('has-note'), kept.marked);
          // 清掉验收数据，别留在读者机器上
          await page.evaluate(`(() => {
            const el = document.querySelector('[data-event-slug]');
            if (!el) return;
            try { localStorage.removeItem('eventprep:notes:' + el.getAttribute('data-event-slug')); } catch (e) {}
          })()`);
        }
      }

      // 5.11b 行前清单默认折叠，折叠状态本机记住
      {
        await page.goto(`${base}/${slug}/`, { waitUntil: 'networkidle' });
        const fold = page.locator('.checklist-fold');
        if ((await fold.count()) === 0) {
          record('行前清单折叠 · 有折叠块', false, '页面上没有 .checklist-fold');
        } else {
          // 先清掉可能存在的旧记录，从默认状态开始
          await page.evaluate(`(() => {
            const el = document.querySelector('.event[data-event-slug]');
            if (el) { try { localStorage.removeItem('eventprep:fold:' + el.getAttribute('data-event-slug') + ':checklist'); } catch (e) {} }
          })()`);
          await page.reload({ waitUntil: 'networkidle' });
          const closedDefault = await fold.evaluate((el) => el.open === false);
          record('行前清单折叠 · 默认收起', closedDefault);

          await fold.evaluate((el) => { el.open = true; });
          await page.waitForTimeout(150);
          await page.reload({ waitUntil: 'networkidle' });
          const keptOpen = await fold.evaluate((el) => el.open === true);
          record('行前清单折叠 · 展开状态刷新后还在（按活动存本机）', keptOpen);

          // 收回去，刷新后仍然是收着的
          await fold.evaluate((el) => { el.open = false; });
          await page.waitForTimeout(150);
          await page.reload({ waitUntil: 'networkidle' });
          const backClosed = await fold.evaluate((el) => el.open === false);
          record('行前清单折叠 · 收起状态刷新后还在', backClosed === true);

          // 清掉验收数据，别留在读者机器上
          await page.evaluate(`(() => {
            const el = document.querySelector('.event[data-event-slug]');
            if (el) { try { localStorage.removeItem('eventprep:fold:' + el.getAttribute('data-event-slug') + ':checklist'); } catch (e) {} }
          })()`);
        }
      }

      // 5.11c 日程各天进目录：点「Day N」能跳过去，而且那一块是展开的
      {
        await page.goto(`${base}/${slug}/`, { waitUntil: 'networkidle' });
        const dayLinks = await page.evaluate(`(() => {
          const toc = document.querySelector('.toc');
          if (!toc) return [];
          return [...toc.querySelectorAll('a[href^="#"]')]
            .map((a) => ({ href: a.getAttribute('href'), text: a.textContent.trim(), cls: a.closest('li') ? a.closest('li').className : '' }))
            .filter((x) => x.cls.includes('toc-agenda-day'));
        })()`);
        if (dayLinks.length === 0) {
          record('日程进目录 · 各天都在目录里', true, '这个活动没有多天日程（不适用）');
        } else {
          record('日程进目录 · 各天都在目录里', true, `${dayLinks.length} 天：${dayLinks.map((d) => d.text).join('、')}`);
          const href = dayLinks[0].href.slice(1);
          // 把目录抽屉打开再点（真实用法），点完检查目标 details 是展开的
          await page.locator('#toc-open').click();
          await page.waitForTimeout(200);
          await page.locator(`.toc a[href="${dayLinks[0].href}"]`).first().click();
          await page.waitForTimeout(200);
          const opened = await page.evaluate(`(() => {
            const el = document.getElementById(${JSON.stringify(href)});
            return { exists: !!el, tag: el ? el.tagName : null, open: el ? el.open : null };
          })()`);
          record(
            '日程进目录 · 点某天后那一块是展开的',
            Boolean(opened.exists && opened.tag === 'DETAILS' && opened.open === true),
            JSON.stringify(opened),
          );
        }
      }

      // 5.11d 过了的日程自动收缩：把访问时刻拨到活动第二天，
      //     第一天应该自己收起来，今天那天的保持展开
      //
      // ⚠️ 用页面自己的数据算「活动所在地的今天」：
      //     判据跟浏览器端一致（按活动时区，不是本机时区）。
      // ⚠️ **先清掉本机记的折叠状态**：读者手动改过的日子以读者为准，
      //     不再走自动规则（见 site.js 的 initAgendaDays）。
      //     而上一条 5.11c 正好点过目录里的「Day 1」——那一跳把它展开了，
      //     于是本机记着「展开」，自动收缩就不会生效了。
      //     这不是产品缺陷（读者点目录就是想看那天），是验收各条之间会互相污染。
      {
        await page.goto(`${base}/${slug}/`, { waitUntil: 'networkidle' });
        await page.evaluate(`(() => {
          const el = document.querySelector('.event[data-event-slug]');
          const slug = el ? el.getAttribute('data-event-slug') : '';
          try {
            for (const k of Object.keys(localStorage)) {
              if (k.startsWith('eventprep:fold:' + slug + ':day-')) localStorage.removeItem(k);
            }
          } catch (e) {}
        })()`);
        const info = await page.evaluate(`(() => {
          const data = JSON.parse(document.getElementById('site-data').textContent);
          const el = document.querySelector('.event[data-event-slug]');
          const ev = data.events.find((e) => e.slug === el.getAttribute('data-event-slug'));
          const blocks = [...document.querySelectorAll('.agenda-day-block[data-day-date]')];
          return {
            start: ev ? ev.start : null,
            timezone: ev ? ev.timezone : 'UTC',
            days: blocks.map((b) => ({ date: b.getAttribute('data-day-date'), open: b.open })),
          };
        })()`);

        if (!info.days.length || !info.start) {
          record('日程自动收缩 · 活动有可判的日程', true, '这个活动的日程判不出日期（不适用）');
        } else {
          // 活动所在地的「第二天」= 起始日 + 1 天
          const p = info.start.split('-');
          const nextDay = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + 1));
          const m = String(nextDay.getUTCMonth() + 1).padStart(2, '0');
          const d = String(nextDay.getUTCDate()).padStart(2, '0');
          const target = `${nextDay.getUTCFullYear()}-${m}-${d}`;
          const pastDay = info.days.find((x) => x.date && x.date < target);
          const todayDay = info.days.find((x) => x.date === target);

          if (!pastDay) {
            record('日程自动收缩 · 过了的自动收起', true, '没有早于第二天的日程（不适用）');
          } else {
            // 拨快时钟：活动第二天的上午（上海时间）
            const clock = await page.evaluate(`(() => {
              const d = new Date(${JSON.stringify(target)} + 'T01:00:00Z');
              return d.getTime();
            })()`);
            const page2 = await context.newPage();
            await page2.clock.install({ time: new Date(clock) });
            await page2.goto(`${base}/${slug}/`, { waitUntil: 'networkidle' });
            await page2.waitForTimeout(200);
            const after = await page2.evaluate(`(() => {
              const blocks = [...document.querySelectorAll('.agenda-day-block[data-day-date]')];
              return blocks.map((b) => ({ date: b.getAttribute('data-day-date'), open: b.open }));
            })()`);
            const pastAfter = after.find((x) => x.date === pastDay.date);
            const todayAfter = after.find((x) => x.date === target);
            record(
              '日程自动收缩 · 过了的自动收起',
              Boolean(pastAfter) && pastAfter.open === false,
              `${pastDay.date} 在活动第二天应收起，实测 open=${pastAfter ? pastAfter.open : '没有这一天'}`,
            );
            record(
              '日程自动收缩 · 今天那天的保持展开',
              !todayAfter || todayAfter.open === true,
              todayAfter ? `${todayAfter.date} open=${todayAfter.open}` : '今天没有日程（不适用）',
            );
            await page2.close();
          }
        }
      }

      // 5.11e 打印版：展开全部折叠内容、藏掉交互组件、退出后还原
      {
        await page.goto(`${base}/${slug}/`, { waitUntil: 'networkidle' });
        const openBtn = page.locator('#print-open');
        if ((await openBtn.count()) === 0) {
          record('打印版 · 活动页有入口', false, '没有 #print-open');
        } else {
          // ⚠️ 「原本收着的」只量正文里的 details：抽屉里的 toc-sub 会被 scrollspy
          //    顺手展开、event-meta-wrap 由 initEventMeta 管，它们不在这次对比范围里。
          const contentClosed = `(() => [...document.querySelectorAll('.content details')].filter((d) => !d.open).length)()`;
          const before = await page.evaluate(contentClosed);
          await openBtn.click();
          await page.waitForTimeout(150);
          const inMode = await page.evaluate(`(() => ({
            mode: document.documentElement.classList.contains('print-mode'),
            closedAfter: [...document.querySelectorAll('details')].filter((d) => !d.open).length,
            barVisible: (() => { const b = document.getElementById('print-bar'); return b ? getComputedStyle(b).display !== 'none' : false; })(),
            noteHidden: (() => { const b = document.querySelector('.agenda-note-btn'); return b ? getComputedStyle(b).display === 'none' : true; })(),
            tipHidden: (() => { const b = document.querySelector('.agenda-tip-btn'); return b ? getComputedStyle(b).display === 'none' : true; })(),
          }))()`);
          record('打印版 · 进入后挂上 print-mode 标记', inMode.mode === true);
          record('打印版 · 所有折叠内容都展开', inMode.closedAfter === 0, `进入前正文收着 ${before} 个，进入后全页 ${inMode.closedAfter} 个还收着`);
          record('打印版 · 工具条可见', inMode.barVisible === true);
          record('打印版 · 交互组件（笔记/提示入口）藏掉', inMode.noteHidden && inMode.tipHidden, JSON.stringify(inMode));

          await page.keyboard.press('Escape');
          await page.waitForTimeout(150);
          const after = await page.evaluate(`(() => ({
            mode: document.documentElement.classList.contains('print-mode'),
            closed: [...document.querySelectorAll('.content details')].filter((d) => !d.open).length,
          }))()`);
          record('打印版 · Esc 退出后回到正常版', after.mode === false);
          record('打印版 · 退出后原本收着的仍是收着的', after.closed === before, `退出前正文收着 ${before} 个，退出后 ${after.closed} 个`);
        }
      }

      // 5.11f 折叠状态本机记住：日程的每一天、推荐路线的每一条
      //
      // ⚠️ 折叠状态是**本机个人数据**：不上传、不同步、不会被清理。
      //    验的是「刷新后还在」——不是「刷新后没了」。
      {
        await page.goto(`${base}/${slug}/`, { waitUntil: 'networkidle' });

        // ---- 日程的每一天 ----
        const days = await page.evaluate(`(() => {
          const el = document.querySelector('.event[data-event-slug]');
          const slug = el ? el.getAttribute('data-event-slug') : '';
          // 清掉旧记录，从默认状态开始
          try {
            for (const k of Object.keys(localStorage)) {
              if (k.startsWith('eventprep:fold:' + slug + ':day-')) localStorage.removeItem(k);
            }
          } catch (e) {}
          return [...document.querySelectorAll('.agenda-day-block[data-fold-key]')].map((d) => ({
            key: d.getAttribute('data-fold-key'),
            open: d.open,
          }));
        })()`);

        if (days.length === 0) {
          record('日程折叠状态 · 有可记的日程天', true, '这个活动没有多天日程（不适用）');
        } else {
          // 手动收起第一天（点 summary 是真实读者的动作）
          const first = days[0];
          await page.evaluate(`(() => {
            const d = document.querySelector('.agenda-day-block[data-fold-key="' + ${JSON.stringify(first.key)} + '"]');
            if (d) d.open = false;
          })()`);
          await page.waitForTimeout(150);
          await page.reload({ waitUntil: 'networkidle' });
          const keptClosed = await page.evaluate(`(() => {
            const d = document.querySelector('.agenda-day-block[data-fold-key="' + ${JSON.stringify(first.key)} + '"]');
            return d ? d.open : null;
          })()`);
          record(
            '日程折叠状态 · 收起某一天后刷新仍是收着的',
            keptClosed === false,
            `${first.key} 收起后刷新 open=${keptClosed}`,
          );

          // 再展开回来，同样要记住
          await page.evaluate(`(() => {
            const d = document.querySelector('.agenda-day-block[data-fold-key="' + ${JSON.stringify(first.key)} + '"]');
            if (d) d.open = true;
          })()`);
          await page.waitForTimeout(150);
          await page.reload({ waitUntil: 'networkidle' });
          const keptOpen = await page.evaluate(`(() => {
            const d = document.querySelector('.agenda-day-block[data-fold-key="' + ${JSON.stringify(first.key)} + '"]');
            return d ? d.open : null;
          })()`);
          record(
            '日程折叠状态 · 展开某一天后刷新仍是展开的',
            keptOpen === true,
            `${first.key} 展开后刷新 open=${keptOpen}`,
          );

          // 清掉验收数据
          await page.evaluate(`(() => {
            const el = document.querySelector('.event[data-event-slug]');
            const slug = el ? el.getAttribute('data-event-slug') : '';
            try {
              for (const k of Object.keys(localStorage)) {
                if (k.startsWith('eventprep:fold:' + slug + ':day-')) localStorage.removeItem(k);
              }
            } catch (e) {}
          })()`);
        }

        // ---- 推荐路线的每一条 ----
        const routes = await page.evaluate(`(() => {
          const el = document.querySelector('.event[data-event-slug]');
          const slug = el ? el.getAttribute('data-event-slug') : '';
          try {
            for (const k of Object.keys(localStorage)) {
              if (k.startsWith('eventprep:fold:' + slug + ':route-')) localStorage.removeItem(k);
            }
          } catch (e) {}
          return [...document.querySelectorAll('.collapse.route[data-fold-key]')].map((d) => ({
            key: d.getAttribute('data-fold-key'),
            open: d.open,
          }));
        })()`);

        if (routes.length === 0) {
          record('推荐路线折叠 · 有可折叠的路线', true, '这个活动没有推荐路线小节（不适用）');
        } else {
          const first = routes[0];
          // 默认展开（推荐路线是全篇的产出）
          record(
            '推荐路线折叠 · 默认展开',
            first.open === true,
            `${first.key} 默认 open=${first.open}`,
          );
          // 手动收起 → 刷新后仍是收着的
          await page.evaluate(`(() => {
            const d = document.querySelector('.collapse.route[data-fold-key="' + ${JSON.stringify(first.key)} + '"]');
            if (d) d.open = false;
          })()`);
          await page.waitForTimeout(150);
          await page.reload({ waitUntil: 'networkidle' });
          const keptClosed = await page.evaluate(`(() => {
            const d = document.querySelector('.collapse.route[data-fold-key="' + ${JSON.stringify(first.key)} + '"]');
            return d ? d.open : null;
          })()`);
          record(
            '推荐路线折叠 · 收起某条后刷新仍是收着的',
            keptClosed === false,
            `${first.key} 收起后刷新 open=${keptClosed}`,
          );

          // 清掉验收数据
          await page.evaluate(`(() => {
            const el = document.querySelector('.event[data-event-slug]');
            const slug = el ? el.getAttribute('data-event-slug') : '';
            try {
              for (const k of Object.keys(localStorage)) {
                if (k.startsWith('eventprep:fold:' + slug + ':route-')) localStorage.removeItem(k);
              }
            } catch (e) {}
          })()`);
        }
      }

      // 5.11g 打印版是**临时模式**：进出一遍不能改掉本机记的折叠状态
      //
      // ⚠️ 打印版会把所有 details 展开——那会触发一堆 toggle 事件。
      //    如果不管，读者只是打印了一次，他手动收起的日程天就被记成「展开了」。
      {
        await page.goto(`${base}/${slug}/`, { waitUntil: 'networkidle' });
        const target = await page.evaluate(`(() => {
          const el = document.querySelector('.event[data-event-slug]');
          const slug = el ? el.getAttribute('data-event-slug') : '';
          try {
            for (const k of Object.keys(localStorage)) {
              if (k.startsWith('eventprep:fold:' + slug + ':')) localStorage.removeItem(k);
            }
          } catch (e) {}
          const d = document.querySelector('.agenda-day-block[data-fold-key]');
          return d ? d.getAttribute('data-fold-key') : null;
        })()`);

        if (!target) {
          record('打印版 · 不改本机记的折叠状态', true, '没有多天日程（不适用）');
        } else {
          // 先手动收起某一天
          await page.evaluate(`(() => {
            const d = document.querySelector('.agenda-day-block[data-fold-key="' + ${JSON.stringify(target)} + '"]');
            if (d) d.open = false;
          })()`);
          await page.waitForTimeout(150);
          // 进打印版 → 退出
          await page.locator('#print-open').click();
          await page.waitForTimeout(150);
          await page.keyboard.press('Escape');
          await page.waitForTimeout(150);
          // 刷新后仍然是收着的（打印版没把它记成「展开了」）
          await page.reload({ waitUntil: 'networkidle' });
          const after = await page.evaluate(`(() => {
            const d = document.querySelector('.agenda-day-block[data-fold-key="' + ${JSON.stringify(target)} + '"]');
            return d ? d.open : null;
          })()`);
          record(
            '打印版 · 不改本机记的折叠状态',
            after === false,
            `${target} 打印前后刷新 open=${after}`,
          );

          // 清掉验收数据
          await page.evaluate(`(() => {
            const el = document.querySelector('.event[data-event-slug]');
            const slug = el ? el.getAttribute('data-event-slug') : '';
            try {
              for (const k of Object.keys(localStorage)) {
                if (k.startsWith('eventprep:fold:' + slug + ':')) localStorage.removeItem(k);
              }
            } catch (e) {}
          })()`);
        }
      }

      // 5.12 记住读到哪儿了：滚到某节，离开再打开，回到同一节
      //
      // ⚠️ 这是**本机个人数据**：不上传、不同步。
      //    验的是「下次打开还在同一节」——不是「下次打开就没了」。
      {
        await page.goto(`${base}/${slug}/`, { waitUntil: 'networkidle' });
        // 先清掉可能存在的旧记录，从零开始
        await page.evaluate(`(() => {
          try {
            const el = document.querySelector('.event[data-event-slug]');
            if (el) localStorage.removeItem('eventprep:scroll:' + el.getAttribute('data-event-slug'));
          } catch (e) {}
        })()`);

        // 滚到「推荐路线」那一节（往下滚一点，让它停在视口里）
        const before = await page.evaluate(`(() => {
          const head = document.getElementById('推荐路线');
          if (!head) return null;
          window.scrollTo({ top: head.getBoundingClientRect().top + window.scrollY - 80, behavior: 'instant' });
          return { id: head.id, top: Math.round(head.getBoundingClientRect().top) };
        })()`);
        if (!before) {
          record('记住位置 · 滚到某节再打开回到同一节', false, '页面里没有「推荐路线」这一节');
        } else {
          // 等防抖的 remember 落盘
          await page.waitForTimeout(700);
          const stored = await page.evaluate(`(() => {
            const el = document.querySelector('.event[data-event-slug]');
            if (!el) return null;
            const raw = localStorage.getItem('eventprep:scroll:' + el.getAttribute('data-event-slug'));
            return raw ? JSON.parse(raw) : null;
          })()`);
          record('记住位置 · 滚过之后有记录', Boolean(stored && stored.id), stored ? stored.id : '没有记录');

          // 离开页面再打开（重新加载 = 重新走一遍加载流程）
          await page.reload({ waitUntil: 'networkidle' });
          await page.waitForTimeout(600);
          const after = await page.evaluate(`(() => {
            const head = document.getElementById('推荐路线');
            return { top: head ? Math.round(head.getBoundingClientRect().top) : null, y: Math.round(window.scrollY) };
          })()`);
          record(
            '记住位置 · 滚到某节再打开回到同一节',
            after.top !== null && Math.abs(after.top - before.top) <= 40,
            `离开前该节在视口 top=${before.top}px，回来后 top=${after.top}px（scrollY=${after.y}）`,
          );

          // 回到顶部 = 这次读完了，记录该清掉
          await page.evaluate(`window.scrollTo({ top: 0, behavior: 'instant' })`);
          await page.waitForTimeout(700);
          const cleared = await page.evaluate(`(() => {
            const el = document.querySelector('.event[data-event-slug]');
            if (!el) return true;
            return !localStorage.getItem('eventprep:scroll:' + el.getAttribute('data-event-slug'));
          })()`);
          record('记住位置 · 回到顶部就清掉记录', cleared === true);
          // 清掉验收数据，别留在读者机器上
          await page.evaluate(`(() => {
            try {
              const el = document.querySelector('.event[data-event-slug]');
              if (el) localStorage.removeItem('eventprep:scroll:' + el.getAttribute('data-event-slug'));
            } catch (e) {}
          })()`);
        }
      }

      // 6. 键盘能走到目录和复选框
      await page.goto(`${base}/${slug}/`, { waitUntil: 'networkidle' });
      const focusables = await page.evaluate(`(() => {
        const sel = 'a[href], button, input, summary, [tabindex]:not([tabindex="-1"])';
        return document.querySelectorAll(sel).length;
      })()`);
      record('键盘 · 页面有可聚焦元素', focusables > 0, `${focusables} 个`);

      // 真按 Tab：焦点要真的移动，而且移动到的元素要有可见轮廓
      // ⚠️ 回顶用 instant：这里要的是「回到顶部这个状态」，不是滚动动画好不好看
      await page.evaluate(`(() => { document.body.focus(); window.scrollTo({ top: 0, behavior: 'instant' }); })()`);
      const tabStops = [];
      let outlineOk = false;
      for (let i = 0; i < 6; i += 1) {
        await page.keyboard.press('Tab');
        const info = await page.evaluate(`(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          const s = getComputedStyle(el);
          return {
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || '').trim().slice(0, 24),
            outlineStyle: s.outlineStyle,
            outlineWidth: s.outlineWidth,
            boxShadow: s.boxShadow,
          };
        })()`);
        if (!info) continue;
        tabStops.push(info);
        const visible =
          (info.outlineStyle && info.outlineStyle !== 'none' && parseFloat(info.outlineWidth) > 0) ||
          (info.boxShadow && info.boxShadow !== 'none');
        if (visible) outlineOk = true;
      }
      record('键盘 · Tab 能逐个走过去', tabStops.length > 0, tabStops.map((t) => t.tag).join(' → '));
      record('键盘 · 焦点有可见轮廓', outlineOk, JSON.stringify(tabStops[0] ?? {}));

      // 6.1 链接必须 Tab 得到
      //     ⚠️ Safari 默认不把链接放进 Tab 序列（要手动开「按 Tab 键高亮网页上的每一项」），
      //        所以站内链接一律带 tabindex="0"（见 templates/layout.ts 的 LINK_TABINDEX）。
      //        这里守住它——去掉就会静默退化。
      {
        const linkStops = tabStops.filter((t) => t.tag === 'a').length;
        record('键盘 · 链接 Tab 得到', linkStops > 0, `前 6 次 Tab 里有 ${linkStops} 次落在链接上`);
      }

      // 6.2 「状态在访问时刻算」是整个站点的核心承诺：把访问时刻拨到活动结束之后，
      //     首页的卡片必须自己挪到「已结束」分组去。
      //     用页面自己的数据找「有日期的那个活动」，这样正式内容和占位数据都能测。
      {
        const page2 = await context.newPage();
        await page2.clock.install({ time: new Date('2027-01-01T00:00:00.000Z') });
        await page2.goto(`${base}/`, { waitUntil: 'networkidle' });
        const placed = await page2.evaluate(`(() => {
          const data = JSON.parse(document.getElementById('site-data').textContent);
          const target = data.events.find((e) => e.startISO);
          if (!target) return null;
          const card = document.querySelector('[data-event-slug="' + target.slug + '"]');
          if (!card) return null;
          const badge = card.querySelector('[data-status-badge]');
          return {
            slug: target.slug,
            group: card.closest('[data-group]') ? card.closest('[data-group]').id : null,
            badge: badge ? badge.textContent : null,
          };
        })()`);
        record(
          '首页分组 · 按访问时刻重新分组',
          placed !== null && placed.group === 'group-ended' && placed.badge === '已结束',
          JSON.stringify(placed),
        );
        await page2.close();
      }

      // 6.3 深浅色切换要活过刷新（首屏套用那一环）
      {
        await page.goto(`${base}/`, { waitUntil: 'networkidle' });
        await page.locator('#theme-toggle').click();
        const theme = await page.evaluate(`(() => document.documentElement.getAttribute('data-theme'))()`);
        await page.reload({ waitUntil: 'networkidle' });
        const after = await page.evaluate(`(() => document.documentElement.getAttribute('data-theme'))()`);
        record('深浅色 · 刷新后仍然是选中的那个', theme !== null && theme === after, `${theme} → ${after}`);
      }

      // 6.4 窄屏上目录入口照样在（抽屉宽度要跟着视口走，不能超出屏幕）
      {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${base}/${slug}/`, { waitUntil: 'networkidle' });
        const narrow = await page.evaluate(`(() => {
          const btn = document.getElementById('toc-open');
          const d = document.getElementById('toc-drawer');
          if (!btn || !d) return null;
          d.showModal();
          const r = d.getBoundingClientRect();
          const out = { width: Math.round(r.width), right: Math.round(r.right), vw: window.innerHeight ? window.innerWidth : 0 };
          d.close();
          return out;
        })()`);
        record(
          '目录 · 窄屏也打得开、且不超出屏幕',
          Boolean(narrow && narrow.width > 200 && narrow.right <= narrow.vw + 1),
          JSON.stringify(narrow),
        );
        await page.setViewportSize({ width: 1280, height: 900 });
      }

      await context.close();
    }

    // 7. 控制台没有报错，而且每个请求都真的拿到了东西
    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      const badResponses = [];
      // 浏览器会自己去要 favicon.ico / apple-touch-icon，产物里没有是正常的，不算坏请求
      const isIconProbe = (url) => /\/(favicon\.ico|apple-touch-icon[^/]*)$/.test(url);
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text());
      });
      page.on('response', (r) => {
        if (!isIconProbe(r.url()) && r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`);
      });
      page.on('requestfailed', (r) => {
        if (!isIconProbe(r.url())) badResponses.push(`失败 ${r.url()}`);
      });
      for (const target of pages) {
        await page.goto(`${base}${target.path}`, { waitUntil: 'networkidle' });
      }
      record(
        '网络 · 每个请求都拿到 2xx/3xx',
        badResponses.length === 0,
        badResponses.slice(0, 3).join(' | '),
      );
      record('控制台 · 没有报错', errors.length === 0, errors.slice(0, 3).join(' | '));
      await context.close();
    }
}

await main();
