import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSite, makeRootRelative } from '../lib/build.ts';

let contentDir: string;
let outDir: string;

beforeEach(async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'event-prep-build-'));
  contentDir = path.join(base, 'content');
  outDir = path.join(base, 'dist');
  await mkdir(contentDir, { recursive: true });
});

afterEach(async () => {
  await rm(path.dirname(contentDir), { recursive: true, force: true });
});

async function writeEvent(slug: string, front: string, body = '## 速览\n\n正文\n'): Promise<void> {
  const d = path.join(contentDir, slug);
  await mkdir(d, { recursive: true });
  await writeFile(path.join(d, 'event.md'), `---\n${front}\n---\n\n${body}`, 'utf8');
}

describe('buildSite', () => {
  it('普通静态站和受管目录内新增文件均不会被删除', async () => {
    await mkdir(path.join(outDir, 'assets'), { recursive: true });
    await writeFile(path.join(outDir, 'index.html'), 'manual');
    await writeFile(path.join(outDir, 'assets', 'proof.txt'), 'keep');
    expect((await buildSite({ contentDir, outDir })).ok).toBe(false);
    expect(await readFile(path.join(outDir, 'assets', 'proof.txt'), 'utf8')).toBe('keep');
    await rm(outDir, { recursive: true });
    await buildSite({ contentDir, outDir });
    await writeFile(path.join(outDir, 'assets', 'proof.txt'), 'keep');
    expect((await buildSite({ contentDir, outDir })).ok).toBe(false);
    expect(await readFile(path.join(outDir, 'assets', 'proof.txt'), 'utf8')).toBe('keep');
  });
  it('非法附件与内容目录类型错误均保留完整旧站', async () => {
    await writeEvent('a', 'title: A');
    await buildSite({ contentDir, outDir });
    const previous = await readFile(path.join(outDir, 'index.html'));
    await mkdir(path.join(contentDir, 'a/assets'));
    await writeFile(path.join(contentDir, 'a/assets/map.html'), '<script>alert(1)</script>');
    expect((await buildSite({ contentDir, outDir })).ok).toBe(false);
    expect(await readFile(path.join(outDir, 'index.html'))).toEqual(previous);
    expect((await buildSite({ contentDir: path.join(contentDir, 'a/event.md'), outDir })).ok).toBe(false);
    expect(await readFile(path.join(outDir, 'index.html'))).toEqual(previous);
  });
  it('宽容模式跳过渲染失败活动，首页仅列成功活动', async () => {
    await writeEvent('bad', 'title: Bad');
    await writeEvent('good', 'title: Good');
    await writeFile(path.join(contentDir, 'bad/summary.md'), '[raw](20261105-raw.md#L1)');
    const result = await buildSite({ contentDir, outDir, tolerant: true });
    expect(result.ok).toBe(true);
    expect(result.built).toEqual(['good']);
    expect(result.skipped).toContain('bad');
    expect(await readFile(path.join(outDir, 'index.html'), 'utf8')).not.toContain('href="bad/"');
  });
  it('缺失总结场次锚点时严格失败', async () => {
    await writeEvent('a', 'title: A', '[summary](summary/#session-999)');
    expect((await buildSite({ contentDir, outDir })).ok).toBe(false);
  });
  it('第二天议程不会提供第一天开场时刻，非精确章节名也校验', async () => {
    await writeEvent('a', 'title: A\nstart: 2026-11-05\nend: 2026-11-06', '## 活动日程\n### 2026-11-06\n#### 14:00–15:00 · Talk\n- 形式: 演讲\n- 会场: Main');
    expect((await buildSite({ contentDir, outDir })).ok).toBe(true);
    const html = await readFile(path.join(outDir, 'a/index.html'), 'utf8');
    expect(html).toContain('2026-11-05T00:00:00.000Z');
    expect(html).not.toContain('<dt>开始</dt>');
    await writeEvent('a', 'title: A', '## 活动日程\n### Day 1\n#### 09:00 · Talk\n- 形式: 演讲\n- 会场: Main\n- 讲者: A | B | assets/missing.webp');
    expect((await buildSite({ contentDir, outDir })).ok).toBe(false);
  });

  it('可选会后资料独立发布，逐场目录与原文行号可追溯，下载保留原字节', async () => {
    await writeEvent('with-notes', 'title: 活动一');
    const dir = path.join(contentDir, 'with-notes');
    const raw = Buffer.from('\uFEFFHello\r\n<script>alert(1)</script>\r\n中文原文\r\n');
    await writeFile(path.join(dir, '20261105-raw.md'), raw);
    await writeFile(path.join(dir, 'private.md'), '不应被发布');
    await writeFile(path.join(dir, 'summary.md'), '# 总结\n\n## 嘉宾议程回顾\n\n#### 1. 讲者\n\n保留**细节**。\n\n[原文](20261105-raw.md#L3)\n');
    const result = await buildSite({ contentDir, outDir, siteUrl: 'https://example.org/project/' });
    expect(result.ok).toBe(true);
    const base = path.join(outDir, 'with-notes');
    const event = await readFile(path.join(base, 'index.html'), 'utf8');
    expect(event).toContain('href="summary/"');
    const summary = await readFile(path.join(base, 'summary/index.html'), 'utf8');
    expect(summary).toContain('id="session-1"');
    expect(summary).toContain('href="#session-1"');
    expect(summary).toContain('<strong>细节</strong>');
    expect(summary).not.toContain('agenda-card');
    expect(summary).toContain('href="../raw/20261105/#L3"');
    expect(summary).toContain('href="../../assets/');
    expect(summary).toContain('https://example.org/project/with-notes/summary/');
    const transcript = await readFile(path.join(base, 'raw/20261105/index.html'), 'utf8');
    expect(transcript).toContain('id="L3"');
    expect(transcript).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(transcript).not.toContain('<script>alert(1)</script>');
    expect(transcript).toContain('href="../../../assets/');
    expect(await readFile(path.join(base, '20261105-raw.md'))).toEqual(raw);
    expect(existsSync(path.join(base, 'private.md'))).toBe(false);
  });

  it('原文分段保留全局行号，总结引用在边界处直达正确段，全文与下载完整', async () => {
    await writeEvent('long-raw', 'title: 长原文');
    const dir = path.join(contentDir, 'long-raw');
    const raw = Buffer.from('\uFEFF' + Array.from({ length: 1001 }, (_, i) => i === 500 ? '<script>原文</script>' : `原文 ${i + 1}`).join('\r\n'));
    await writeFile(path.join(dir, '20261105-raw.md'), raw);
    await writeFile(path.join(dir, 'summary.md'), '#### 7. 场次回顾\n\n' + [1, 500, 501, 1000, 1001].map(n => `[L${n}](20261105-raw.md#L${n})`).join('\n\n'));
    expect((await buildSite({ contentDir, outDir })).ok).toBe(true);
    const base = path.join(outDir, 'long-raw');
    const summary = await readFile(path.join(base, 'summary/index.html'), 'utf8');
    for (const [n, part] of [[1, ''], [500, ''], [501, 'part-2/'], [1000, 'part-2/'], [1001, 'part-3/']] as const) {
      expect(summary).toContain(`href="../raw/20261105/${part}#L${n}"`);
    }
    const first = await readFile(path.join(base, 'raw/20261105/index.html'), 'utf8');
    const second = await readFile(path.join(base, 'raw/20261105/part-2/index.html'), 'utf8');
    const last = await readFile(path.join(base, 'raw/20261105/part-3/index.html'), 'utf8');
    expect((first.match(/class="raw-line"/g) ?? []).length).toBe(500);
    expect(first).toContain('id="L500"');
    expect(first).not.toContain('id="L501"');
    expect(second).toContain('id="L501"');
    expect(second).toContain('id="L1000"');
    expect(second).toContain('&lt;script&gt;原文&lt;/script&gt;');
    expect(second).toContain('href="../part-3/" tabindex="0" rel="next"');
    expect(second).toContain('href="../all/"');
    expect(second).toContain('href="../../../../assets/');
    expect(second).toContain('href="../../../summary/#session-7"');
    expect(last).toContain('id="L1001"');
    expect(last).not.toContain('rel="next"');
    const full = await readFile(path.join(base, 'raw/20261105/all/index.html'), 'utf8');
    expect((full.match(/class="raw-line"/g) ?? []).length).toBe(1001);
    expect(full).not.toContain('data-raw-page-size');
    expect((full.match(/class="raw-chunk"/g) ?? []).length).toBe(11);
    expect(full).toContain('href="../../../summary/#session-7"');
    expect(first).not.toContain('raw-chunk');
    expect(await readFile(path.join(base, '20261105-raw.md'))).toEqual(raw);
  });

  it('缺少总结所引用的原文时失败，保留上一次产物', async () => {
    await writeEvent('with-notes', 'title: 活动一');
    await buildSite({ contentDir, outDir });
    const previous = await readFile(path.join(outDir, 'index.html'), 'utf8');
    await writeFile(path.join(contentDir, 'with-notes', 'summary.md'), '[原文](20261105-raw.md#L1)');
    const result = await buildSite({ contentDir, outDir });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('总结引用的原始记录不存在');
    expect(await readFile(path.join(outDir, 'index.html'), 'utf8')).toBe(previous);
  });

  it('参考式原文链接也解析行号，代码示例不误当引用，拒绝越界行号', async () => {
    await writeEvent('with-notes', 'title: 活动一');
    const dir = path.join(contentDir, 'with-notes');
    await writeFile(path.join(dir, '20261105-raw.md'), '第一行\n第二行');
    await writeFile(path.join(dir, 'summary.md'), '代码示例：`[原文](20261106-raw.md#L1)`\n\n[原文][ref]\n\n[ref]: 20261105-raw.md#L2');
    expect((await buildSite({ contentDir, outDir })).ok).toBe(true);
    const page = await readFile(path.join(outDir, 'with-notes/summary/index.html'), 'utf8');
    expect(page).toContain('href="../raw/20261105/#L2"');
    expect(page).toContain('<code>[原文](20261106-raw.md#L1)</code>');
    expect(page).not.toContain('id="toc-open"');
    await writeFile(path.join(dir, 'summary.md'), '[原文](20261105-raw.md#L3)');
    const result = await buildSite({ contentDir, outDir });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('原文行号越界');
  });

  it('只有原文也有入口；移除资料后不留下旧页面或空入口', async () => {
    await writeEvent('with-notes', 'title: 活动一');
    const file = path.join(contentDir, 'with-notes', '20261105-raw.md');
    await writeFile(file, '原文');
    await buildSite({ contentDir, outDir });
    let event = await readFile(path.join(outDir, 'with-notes/index.html'), 'utf8');
    expect(event).toContain('href="raw/"');
    expect(event).not.toContain('href="summary/"');
    await rm(file);
    await buildSite({ contentDir, outDir });
    event = await readFile(path.join(outDir, 'with-notes/index.html'), 'utf8');
    expect(event).not.toContain('materials-links');
    expect(existsSync(path.join(outDir, 'with-notes/raw'))).toBe(false);
  });
  it('空站点也能构建，给出友好的空状态', async () => {
    const result = await buildSite({ contentDir, outDir });
    expect(result.ok).toBe(true);
    expect(result.built).toEqual([]);
    const home = await readFile(path.join(outDir, 'index.html'), 'utf8');
    expect(home).toContain('还没有收录任何活动');
    expect(home).toContain('rel="icon" type="image/svg+xml" href="assets/favicon.svg"');
    expect(home).toContain('class="site-logo"');
    // 样式与脚本按内容哈希命名（site.<hash>.css），所以按名字找不到——找带哈希的那个
    const assets = await readdir(path.join(outDir, 'assets'));
    expect(assets.some((f) => /^site\.[0-9a-f]{8}\.css$/.test(f))).toBe(true);
    expect(assets.some((f) => /^site\.[0-9a-f]{8}\.js$/.test(f))).toBe(true);
    expect(assets.includes('favicon.svg')).toBe(true);
  });

  it('多个活动都生成页面，首页能索引到', async () => {
    await writeEvent('a-one', 'title: 活动一\nstart: 2026-11-05\ntimezone: Asia/Shanghai');
    await writeEvent('b-two', 'title: 活动二\nstart: 2026-12-05\ntimezone: Asia/Shanghai');

    const result = await buildSite({ contentDir, outDir });
    expect(result.ok).toBe(true);
    expect(result.built.sort()).toEqual(['a-one', 'b-two']);
    expect(existsSync(path.join(outDir, 'a-one', 'index.html'))).toBe(true);
    expect(existsSync(path.join(outDir, 'b-two', 'index.html'))).toBe(true);

    const home = await readFile(path.join(outDir, 'index.html'), 'utf8');
    expect(home).toContain('活动一');
    expect(home).toContain('href="a-one/"');
  });

  it('活动自带的资源带到活动页下', async () => {
    await writeEvent('a-one', 'title: 活动一');
    await mkdir(path.join(contentDir, 'a-one', 'assets'), { recursive: true });
    await writeFile(path.join(contentDir, 'a-one', 'assets', 'map.png'), 'x', 'utf8');

    await buildSite({ contentDir, outDir });
    expect(existsSync(path.join(outDir, 'a-one', 'assets', 'map.png'))).toBe(true);
  });

  it('页面引用的资源名与产物里真实存在的文件名对得上', async () => {
    // ⚠️ 这是哈希命名最容易坏的地方：页面写的是 `site.<hash>.css`，
    //    产物里却叫别的名字 → 一条 404，而页面「看起来正常」（只是没样式）。
    //    所以拿页面上写的名字去产物里找，必须找得到。
    await writeEvent('a-one', 'title: 活动一');
    await buildSite({ contentDir, outDir });

    const event = await readFile(path.join(outDir, 'a-one', 'index.html'), 'utf8');
    const css = event.match(/href="\.\.\/assets\/([^"]+\.css)"/)?.[1];
    const js = event.match(/src="\.\.\/assets\/([^"]+\.js)"/)?.[1];
    expect(css).toBeTruthy();
    expect(js).toBeTruthy();
    expect(existsSync(path.join(outDir, 'assets', css!))).toBe(true);
    expect(existsSync(path.join(outDir, 'assets', js!))).toBe(true);
  });

  it('EdgeOne 的配置随产物进根目录', async () => {
    // ⚠️ EdgeOne 是从分支根目录读 edgeone.json 的：
    //    不在分支里就没有那套缓存与安全响应头（页面照样开，但每个请求都回源）。
    await writeEvent('a-one', 'title: 活动一');
    await buildSite({ contentDir, outDir });

    const config = await readFile(path.join(outDir, 'edgeone.json'), 'utf8');
    expect(config).toContain('"headers"');
    // 兜底规则必须在**前面**，具体规则在**后面**（后写的覆盖先写的）
    expect(config.indexOf('"/*"')).toBeLessThan(config.indexOf('"/assets/*"'));
  });

  it('活动页旁边放一份内容源文件（Markdown），内容与源文件一致', async () => {
    // ⚠️ 必须是**源文件原文**，不是渲染结果：
    //    「下载下来改一改，放回 content/」这条闭环靠的是它能原样塞回去。
    const source = '---\ntitle: 活动一\n---\n\n## 速览\n\n正文\n';
    await writeEvent('a-one', 'title: 活动一', '## 速览\n\n正文\n');

    await buildSite({ contentDir, outDir });
    const exported = await readFile(path.join(outDir, 'a-one', 'event.md'), 'utf8');
    expect(exported).toBe(source);

    // 活动页底部得有下载链接指到它
    const page = await readFile(path.join(outDir, 'a-one', 'index.html'), 'utf8');
    expect(page).toContain('href="event.md"');
  });

  it('源文件是 CRLF 时，导出的那份是 LF', async () => {
    const dir = path.join(contentDir, 'a-one');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'event.md'), '---\r\ntitle: 活动一\r\n---\r\n\r\n正文\r\n', 'utf8');

    await buildSite({ contentDir, outDir });
    const exported = await readFile(path.join(outDir, 'a-one', 'event.md'), 'utf8');
    expect(exported).not.toContain('\r');
    expect(exported).toContain('title: 活动一');
  });

  it('给了 siteUrl 且分享卡真在产物里才写 og:image', async () => {
    await writeEvent('a-one', 'title: 活动一\nstart: 2026-11-05');
    const ogFile = path.join(path.dirname(contentDir), 'og-image.png');
    await writeFile(ogFile, '\x89PNG-fake', 'utf8');
    await buildSite({ contentDir, outDir, siteUrl: 'https://example.org/site/', ogImageSource: ogFile });
    const home = await readFile(path.join(outDir, 'index.html'), 'utf8');
    const page = await readFile(path.join(outDir, 'a-one', 'index.html'), 'utf8');
    // 两个页面都要有，且必须是绝对地址
    for (const html of [home, page]) {
      expect(html).toContain('og:image');
      expect(html).toContain('https://example.org/site/og-image.png');
    }
    // meta 指的那张图必须真的在产物里
    expect(existsSync(path.join(outDir, 'og-image.png'))).toBe(true);
  });

  it('没给 siteUrl 就不写 og:image', async () => {
    await writeEvent('a-one', 'title: 活动一\nstart: 2026-11-05');
    await buildSite({ contentDir, outDir });
    const home = await readFile(path.join(outDir, 'index.html'), 'utf8');
    expect(home).not.toContain('og:image');
  });

  it('分享卡缺失：构建照样成功，但不写那条会 404 的 meta', async () => {
    await writeEvent('a-one', 'title: 活动一\nstart: 2026-11-05');
    const result = await buildSite({
      contentDir,
      outDir,
      siteUrl: 'https://example.org/',
      ogImageSource: path.join(path.dirname(contentDir), '没有这个文件.png'),
    });
    expect(result.ok).toBe(true);
    // ⚠️ 以前这里是「meta 照写、图静默不复制」——部署出去的页面就指着一条 404，
    //    而爬虫抓 og:image 浏览器不抓，任何验收都量不到。图不在就整条不写。
    const home = await readFile(path.join(outDir, 'index.html'), 'utf8');
    expect(home).not.toContain('og:image');
    expect(existsSync(path.join(outDir, 'og-image.png'))).toBe(false);
  });

  it('数据有错时严格模式让构建失败，不产出可发布的站点', async () => {
    await writeEvent('good', 'title: 好的活动\nstart: 2026-11-05');
    await writeEvent('bad', 'title: 坏的活动\nstart: 不是日期');

    const result = await buildSite({ contentDir, outDir });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.skipped).toEqual(['bad']);
  });

  it('tolerant 模式跳过坏活动，其余照常构建', async () => {
    await writeEvent('good', 'title: 好的活动\nstart: 2026-11-05');
    await writeEvent('bad', 'title: 坏的活动\nstart: 不是日期');

    const result = await buildSite({ contentDir, outDir, tolerant: true });
    expect(result.ok).toBe(true);
    expect(result.built).toEqual(['good']);
    expect(result.skipped).toEqual(['bad']);
    expect(existsSync(path.join(outDir, 'good', 'index.html'))).toBe(true);
  });

  it('删掉活动目录后重建，那个页面不再存在', async () => {
    await writeEvent('keep', 'title: 留下的');
    await writeEvent('drop', 'title: 要删的');
    await buildSite({ contentDir, outDir });
    expect(existsSync(path.join(outDir, 'drop', 'index.html'))).toBe(true);

    await rm(path.join(contentDir, 'drop'), { recursive: true, force: true });
    await buildSite({ contentDir, outDir });
    expect(existsSync(path.join(outDir, 'drop', 'index.html'))).toBe(false);
    expect(existsSync(path.join(outDir, 'keep', 'index.html'))).toBe(true);

    const home = await readFile(path.join(outDir, 'index.html'), 'utf8');
    expect(home).not.toContain('要删的');
  });

  it('首页与活动页用相对路径挂到子路径下也走得通', async () => {
    await writeEvent('a-one', 'title: 活动一', '## 速览\n\n看 [资料](/files/handbook.pdf)\n');
    await buildSite({ contentDir, outDir });

    const event = await readFile(path.join(outDir, 'a-one', 'index.html'), 'utf8');
    // 资源名带内容哈希，但**前缀仍是相对的**——挂在子路径下也要走得通
    expect(event).toMatch(/href="\.\.\/assets\/site\.[0-9a-f]{8}\.css"/);
    expect(event).toMatch(/src="\.\.\/assets\/site\.[0-9a-f]{8}\.js"/);
    expect(event).toContain('href="../"');
    // 正文里的站内绝对路径要改成相对路径
    expect(event).toContain('href="../files/handbook.pdf"');
    expect(event).not.toContain('href="/files/handbook.pdf"');
  });

  it('活动页把「最重要的 3 件事」提到正文前面', async () => {
    await writeEvent('a-one', 'title: 活动一', '> **最重要的 3 件事**：甲\n\n## 速览\n\n正文\n');
    await buildSite({ contentDir, outDir });
    const event = await readFile(path.join(outDir, 'a-one', 'index.html'), 'utf8');
    const calloutAt = event.indexOf('class="callout"');
    const quickLookAt = event.indexOf('id="速览"');
    expect(calloutAt).toBeGreaterThan(-1);
    expect(calloutAt).toBeLessThan(quickLookAt);
    // 标签不重复出现两遍
    expect(event.match(/最重要的 3 件事/g)?.length).toBe(1);
  });

  it('多行的「最重要的 3 件事」在页面上分行显示', async () => {
    await writeEvent(
      'a-one',
      'title: 活动一',
      '> **最重要的 3 件事**：第一条；\n> 第二条。\n\n## 速览\n\n正文\n',
    );
    await buildSite({ contentDir, outDir });
    const event = await readFile(path.join(outDir, 'a-one', 'index.html'), 'utf8');
    const callout = /class="callout-body">([\s\S]*?)<\/div>/.exec(event)?.[1] ?? '';
    // 标准 Markdown 会把两行折成一个段落，页面上就成了一坨连续文字
    expect(callout).toMatch(/<br\b/);
  });

  it('日程章节换成卡片结构，DOM 里不再出现表格', async () => {
    await writeEvent(
      'a-one',
      'title: 活动一',
      '## 日程\n\n### Day 1 · 11 月 5 日\n\n#### 09:45–10:10 · 从模型到企业工作流\n- 形式: 演讲\n- 会场: 主会场\n- 讲者: Marco Casalaina | 微软 | assets/speakers/marco.webp | 微软副总裁\n- 摘要: 中文摘要。\n- 出处: https://example.org/x\n\n## 行前清单\n\n- [ ] 买票\n',
    );
    await mkdir(path.join(contentDir, 'a-one', 'assets', 'speakers'), { recursive: true });
    await writeFile(path.join(contentDir, 'a-one', 'assets', 'speakers', 'marco.webp'), 'x', 'utf8');

    await buildSite({ contentDir, outDir });
    const event = await readFile(path.join(outDir, 'a-one', 'index.html'), 'utf8');

    expect(event).toContain('<section class="agenda-day">');
    expect(event).toContain('<li class="agenda-card">');
    expect(event).toContain('<span class="speaker-name">Marco Casalaina</span>');
    expect(event).toContain('<span class="note">微软副总裁</span>');
    expect(event).toContain('<img class="agenda-avatar" src="assets/speakers/marco.webp"');
    // 短摘要直接摊开，不带「非官方中文口径」那句标注
    expect(event).toContain('class="agenda-abstract-text"');
    expect(event).not.toContain('中文转述自官方英文摘要');
    // 出处是图标链接
    expect(event).toContain('<a class="agenda-source"');
    // 日程不再走表格；其它章节的表格不受影响
    expect(event).not.toContain('<table>');
    // 二级标题留着，目录才收得到
    expect(event).toContain('id="日程"');
  });

  it('非日程章节的表格照旧渲染', async () => {
    await writeEvent('a-one', 'title: 活动一', '## 对照\n\n| 时段 | 主会场 |\n| --- | --- |\n| 13:45 | 甲 |\n');
    await buildSite({ contentDir, outDir });
    const event = await readFile(path.join(outDir, 'a-one', 'index.html'), 'utf8');
    expect(event).toContain('<table>');
  });

  it('没有日期的活动标成日期待定，不编状态', async () => {
    await writeEvent('a-one', 'title: 活动一');
    await buildSite({ contentDir, outDir });
    const event = await readFile(path.join(outDir, 'a-one', 'index.html'), 'utf8');
    expect(event).toContain('badge-unknown');
    expect(event).toContain('日期待定');
  });

  it('议程首场决定开始时刻：页面给出真实时刻，倒计时锚在它上面', async () => {
    await writeEvent(
      'a-one',
      'title: 活动一\nstart: 2026-11-05\nend: 2026-11-06\ntimezone: Asia/Shanghai',
      `## 日程

### Day 1 · 11 月 5 日

#### 08:30–09:30 · 签到
- 形式: 签到

#### 09:30–17:50 · 主题演讲
- 形式: 演讲
- 会场: 主会场

### Day 2 · 11 月 6 日

#### 09:00–10:00 · 签到
- 形式: 签到

#### 10:00–17:50 · 主题演讲
- 形式: 演讲
- 会场: 主会场
`,
    );
    const result = await buildSite({ contentDir, outDir });
    expect(result.ok).toBe(true);

    const home = await readFile(path.join(outDir, 'index.html'), 'utf8');
    // 首页卡片上写明真实开始时刻（读者要的是「几点到场」）
    expect(home).toContain('<dt>开始</dt><dd>08:30</dd>');
    // site-data 里的 startISO 是真实开始瞬间（08:30 上海 = 00:30Z），不是当天午夜
    expect(home).toContain('2026-11-05T00:30:00.000Z');

    const event = await readFile(path.join(outDir, 'a-one', 'index.html'), 'utf8');
    expect(event).toContain('<dt>开始</dt><dd>08:30</dd>');
    expect(event).toContain('2026-11-05T00:30:00.000Z');
  });

  it('没有议程信息就不写开始时刻（不编「00:00 开始」）', async () => {
    await writeEvent('a-one', 'title: 活动一\nstart: 2026-11-05\ntimezone: Asia/Shanghai');
    await buildSite({ contentDir, outDir });
    const home = await readFile(path.join(outDir, 'index.html'), 'utf8');
    expect(home).not.toContain('<dt>开始</dt>');
  });

  it('构建失败时不碰产出目录（上一次的站点留在原处）', async () => {
    await writeEvent('good', 'title: 好的活动\nstart: 2026-11-05');
    await buildSite({ contentDir, outDir });
    expect(existsSync(path.join(outDir, 'good', 'index.html'))).toBe(true);

    // 加一个坏活动再构建
    await writeEvent('bad', 'title: 坏的活动\nstart: 不是日期');
    const result = await buildSite({ contentDir, outDir });
    expect(result.ok).toBe(false);
    expect(result.built).toEqual([]);
    // 上一次构建好的页面还在，没被清成半成品
    expect(existsSync(path.join(outDir, 'good', 'index.html'))).toBe(true);
    expect(existsSync(path.join(outDir, 'index.html'))).toBe(true);
  });

  it('dryRun 只校验不落盘', async () => {
    await writeEvent('good', 'title: 好的活动\nstart: 2026-11-05');
    const result = await buildSite({ contentDir, outDir, dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.built).toEqual(['good']);
    expect(existsSync(outDir)).toBe(false);
  });

  it('site-data 只带浏览器真正用到的字段', async () => {
    await writeEvent('a-one', 'title: 活动一\nstart: 2026-11-05\ntimezone: Asia/Shanghai\ncity: 上海');
    await buildSite({ contentDir, outDir });

    for (const [label, file] of [
      ['首页', path.join(outDir, 'index.html')],
      ['活动页', path.join(outDir, 'a-one', 'index.html')],
    ] as const) {
      const html = await readFile(file, 'utf8');
      const matched = /<script type="application\/json" id="site-data">(.*?)<\/script>/s.exec(html);
      expect(matched, `${label} 应该有 site-data`).toBeTruthy();
      const data = JSON.parse(matched?.[1] ?? '{}') as { events: Record<string, unknown>[] };
      expect(Object.keys(data.events[0] ?? {}).sort()).toEqual([
        'days',
        'endISO',
        'slug',
        'start',
        'startISO',
        'timezone',
      ]);
    }
  });

  it('canonical 与 og:url 指向本页，首页不出现双斜杠', async () => {
    await writeEvent('a-one', 'title: 活动一');
    await buildSite({ contentDir, outDir, siteUrl: 'https://example.org/prep/' });

    const home = await readFile(path.join(outDir, 'index.html'), 'utf8');
    expect(home).toContain('<link rel="canonical" href="https://example.org/prep/">');
    expect(home).not.toContain('prep//');

    const event = await readFile(path.join(outDir, 'a-one', 'index.html'), 'utf8');
    expect(event).toContain('<link rel="canonical" href="https://example.org/prep/a-one/">');
    expect(event).toContain('<meta property="og:url" content="https://example.org/prep/a-one/">');
  });

  it('结构化数据（JSON-LD）真的进了页面，地址和城市都在', async () => {
    await writeEvent(
      'a-one',
      'title: 活动一\ncity: 上海\nvenue: 会场\naddress: 某某路 1 号\nstart: 2026-11-05\ntimezone: Asia/Shanghai',
    );
    await buildSite({ contentDir, outDir });
    const event = await readFile(path.join(outDir, 'a-one', 'index.html'), 'utf8');

    const match = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(event);
    expect(match, '页面上应该有 JSON-LD').toBeTruthy();
    const ld = JSON.parse(match?.[1] ?? '{}') as Record<string, unknown>;
    expect(ld['@type']).toBe('Event');
    const location = ld['location'] as Record<string, unknown>;
    const address = location['address'] as Record<string, string>;
    expect(address['streetAddress']).toBe('某某路 1 号');
    expect(address['addressLocality']).toBe('上海');
  });

  it('没提供时区时如实说明按 UTC 算', async () => {
    await writeEvent('a-one', 'title: 活动一\nstart: 2026-11-05');
    await buildSite({ contentDir, outDir });
    const event = await readFile(path.join(outDir, 'a-one', 'index.html'), 'utf8');
    expect(event).toContain('按 UTC 计算');
  });
});

describe('产出目录守卫', () => {
  it('产出目录里装着别人的东西时拒绝动手，那些文件一个都不掉', async () => {
    await writeEvent('a-one', 'title: 活动一');
    // 就是 `npm run build -- --out .` 那一类写法：以前 rm(outDir) 会连源码一起删掉
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'package.json'), '{}', 'utf8');
    await mkdir(path.join(outDir, 'content'), { recursive: true });
    await writeFile(path.join(outDir, 'content', 'notes.md'), '我的笔记', 'utf8');

    const result = await buildSite({ contentDir, outDir });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('不属于构建产物');
    expect(existsSync(path.join(outDir, 'package.json'))).toBe(true);
    expect(existsSync(path.join(outDir, 'content', 'notes.md'))).toBe(true);
    // 也没写出半成品站点
    expect(existsSync(path.join(outDir, 'index.html'))).toBe(false);
  });

  it('上一次构建留下的活动目录不算外来文件（重建照常放行）', async () => {
    await writeEvent('a-one', 'title: 活动一');
    await buildSite({ contentDir, outDir });
    // outDir 顶层现在是 index.html / assets / a-one/，a-one 是 slug 命名的
    const again = await buildSite({ contentDir, outDir });
    expect(again.ok).toBe(true);
    expect(existsSync(path.join(outDir, 'a-one', 'index.html'))).toBe(true);
  });

  it('内容目录在产出目录里面时拒绝（清空它等于删内容）', async () => {
    const nested = path.join(outDir, 'content');
    await mkdir(nested, { recursive: true });
    const result = await buildSite({ contentDir: nested, outDir });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('在产出目录里面');
  });
});

describe('makeRootRelative', () => {
  it('把站内绝对路径改成相对路径，外链不动', () => {
    expect(makeRootRelative('<a href="/x">x</a>', '../')).toBe('<a href="../x">x</a>');
    expect(makeRootRelative('<a href="https://example.org/x">x</a>', '../')).toBe(
      '<a href="https://example.org/x">x</a>',
    );
  });

  it('协议相对地址不当成站内路径', () => {
    expect(makeRootRelative('<a href="//example.org/x">x</a>', '../')).toBe('<a href="//example.org/x">x</a>');
  });
});

it('活动附件中的外部目录联接不能发布', async () => {
  await writeEvent('demo', 'title: Demo');
  const outside = path.join(path.dirname(contentDir), 'private');
  await mkdir(outside);
  await writeFile(path.join(outside, 'proof.png'), 'external marker');
  await mkdir(path.join(contentDir, 'demo/assets'));
  await symlink(outside, path.join(contentDir, 'demo/assets/link'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await buildSite({ contentDir, outDir });
  expect(result.ok).toBe(false);
  expect(result.errors.join()).toContain('联接');
  expect(existsSync(path.join(outDir, 'demo/assets/link/proof.png'))).toBe(false);
});
