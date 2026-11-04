import { describe, expect, it } from 'vitest';
import { extractCallout, renderInlineMarkdown, renderMarkdown, splitDetails } from '../lib/markdown.ts';

describe('renderMarkdown · 日程章节（段级接管）', () => {
  const AGENDA = `## 日程

### Day 1 · 11 月 5 日

#### 09:45–10:10 · 从模型到企业工作流
- 形式: 演讲
- 会场: 主会场
- 讲者: Marco Casalaina | 微软 | assets/speakers/marco.webp | 微软副总裁
- 时长: 25 分钟
- 看点: 看点正文
- 摘要: 摘要正文
- 出处: https://example.org/x
`;

  it('日程卡片的 class 在白名单里（消毒不剥样式钩子）', () => {
    const html = renderMarkdown(AGENDA).html;
    for (const cls of [
      'agenda-day', 'agenda-day-block', 'agenda-day-summary', 'agenda-slots', 'agenda-slot',
      'agenda-slot-head', 'agenda-time', 'agenda-cards', 'agenda-card',
      'agenda-speakers', 'agenda-speaker', 'speaker-name', 'speaker-org', 'agenda-duration',
      'agenda-tags', 'agenda-highlight', 'agenda-abstract-text',
    ]) {
      expect(html, `class="${cls}" 应当活过消毒`).toContain(`class="${cls}"`);
    }
    // 出处是一个图标链接，不是「官方本页」那一行文字
    expect(html).toContain('<a class="agenda-source"');
    expect(html).not.toContain('官方本页');
  });

  it('讲者简介与「看这场之前要知道的事」分得开（两个钩子都在）', () => {
    const html = renderMarkdown(
      '## 日程\n\n### Day 1\n\n#### 09:45 · 一场\n- 形式: 演讲\n- 会场: 主会场\n- 讲者: 张三 | 机构 | | | 某公司的基础设施负责人。\n- 备注: 先搞懂 KV-Cache。\n',
    ).html;
    // ⚠️ 这两个钩子不在消毒白名单里的话，class 属性在、值被剥掉：
    //    页面不报错、暖色也永远不生效——很难自己发现。
    for (const cls of [
      'class="agenda-tip agenda-tip-bio"',
      'class="agenda-tip agenda-tip-remark"',
      'class="agenda-tip-toggle"',
      'class="agenda-tip-btn"',
      'class="agenda-tip-body"',
    ]) {
      expect(html, `${cls} 应当活过消毒`).toContain(cls);
    }
  });

  it('短摘要直接摊开，长摘要收进点开式条目', () => {
    const short = renderMarkdown(
      '## 日程\n\n### Day 1\n\n#### 09:45 · 一场\n- 形式: 演讲\n- 会场: 主会场\n- 摘要: 短摘要。\n',
    ).html;
    expect(short).toContain('class="agenda-abstract-text"');
    expect(short).not.toContain('agenda-abstract"');

    const long = renderMarkdown(
      `## 日程\n\n### Day 1\n\n#### 09:45 · 一场\n- 形式: 演讲\n- 会场: 主会场\n- 摘要: ${'长'.repeat(300)}\n`,
    ).html;
    expect(long).toContain('class="agenda-abstract"');
    expect(long).not.toContain('agenda-abstract-text');
  });

  it('讲者的完整介绍变成图标 tip，且只在第一次出现处挂', () => {
    const html = renderMarkdown(
      '## 日程\n\n### Day 1\n\n#### 09:45 · 甲场\n- 形式: 演讲\n- 会场: 主会场\n- 讲者: 张三 | 机构 | | | 某公司的基础设施负责人。\n\n#### 10:00 · 乙场\n- 形式: 演讲\n- 会场: 主会场\n- 讲者: 张三 | 机构 | | | 某公司的基础设施负责人。\n',
    ).html;
    // 两场都有张三，但只有第一次出现的地方挂图标
    expect(html.match(/class="agenda-tip-btn"/g)).toHaveLength(1);
    expect(html).toContain('某公司的基础设施负责人。');
  });

  it('⚠️ 卡片不能变成代码块：议程章节整段接管，不该再被 Markdown 解析一遍', () => {
    const html = renderMarkdown(AGENDA).html;
    expect(html).not.toContain('<pre><code>');
    expect(html).not.toContain('&lt;li');
    expect(html).not.toContain('&lt;h4');
  });

  it('读者自己的笔记：入口与输入框都活过消毒（存本机浏览器）', () => {
    const html = renderMarkdown(AGENDA).html;
    for (const cls of ['agenda-note', 'agenda-note-btn', 'agenda-note-editor', 'agenda-note-input']) {
      expect(html, `class="${cls}" 应当活过消毒`).toContain(`class="${cls}"`);
    }
    expect(html).toContain('data-note-key=');
    expect(html).toContain('agenda-note-hint');
  });

  it('二级标题仍进目录（标题留给 Markdown，目录要它）', () => {
    const { html, toc } = renderMarkdown(AGENDA);
    expect(html).toContain('id="日程"');
    expect(toc.some((t) => t.text === '日程')).toBe(true);
  });

  it('日程章节里的 `###`/`####` 不再当普通标题渲染', () => {
    const { html, toc } = renderMarkdown(AGENDA);
    expect(html).not.toContain('id="day-1');
    expect(html).not.toContain('<h3');
    expect(html).not.toContain('<h4 id=');
    expect(toc.map((t) => t.text)).toEqual(['日程']);
  });

  it('别的章节照旧：一个 `###` 子节仍然是普通小标题', () => {
    const { toc } = renderMarkdown('## 速览\n\n### 子节\n\n正文\n');
    expect(toc.map((t) => t.text)).toEqual(['速览', '子节']);
  });
});

describe('renderMarkdown · 注记的警示升级', () => {
  it('还没定下来的注记都升级成警示（含写作细则举的「主题待嘉宾确认」）', () => {
    // ⚠️ 判据认「待……确认 / 待……公布」，不是只认三个字连写：
    //    writing-guide.md 的示例就是 `主题待嘉宾确认`，紧串匹配的话
    //    细则教人这么写、页面上却不变色。
    for (const text of ['主题待确认', '主题待嘉宾确认', '主题待嘉宾最终确认', '讲题待公布', '讲者待定']) {
      expect(renderMarkdown(`正文 <span class="note">${text}</span>`).html, text).toContain('note note-warn');
    }
    const plain = renderMarkdown('正文 <span class="note">微软副总裁</span>').html;
    expect(plain).toContain('class="note"');
    expect(plain).not.toContain('note-warn');
  });
});

describe('renderMarkdown · 标题与目录', () => {
  it('二级、三级标题进目录并带 id', () => {
    const { html, toc } = renderMarkdown('## 速览\n\n正文\n\n### 子节\n\n更多\n');
    expect(html).toContain('<h2 id="速览">');
    expect(html).toContain('<h3 id="子节">');
    expect(toc.map((t) => t.text)).toEqual(['速览', '子节']);
    expect(toc.map((t) => t.depth)).toEqual([2, 3]);
  });

  it('一级标题不进目录（目录只收主要章节）', () => {
    const { toc } = renderMarkdown('# 一级\n\n## 二级\n');
    expect(toc.map((t) => t.text)).toEqual(['二级']);
  });

  it('重名标题的 id 不打架', () => {
    const { html, toc } = renderMarkdown('## 速览\n\n## 速览\n');
    expect(toc[0]?.id).toBe('速览');
    expect(toc[1]?.id).toBe('速览-2');
    expect(html).toContain('id="速览-2"');
  });
});

describe('renderMarkdown · details', () => {
  it('<details markdown="1"> 里的 Markdown 会被解析', () => {
    const src = '## 时间表\n\n<details markdown="1" open>\n<summary>第一天</summary>\n\n| 时间 | 主题 |\n| --- | --- |\n| 09:00 | 开场 |\n\n</details>\n';
    const { html } = renderMarkdown(src);
    expect(html).toContain('<details open>');
    expect(html).toContain('<summary>第一天</summary>');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>时间</th>');
    // 关键：表格不能被当成原始 HTML 文本透传
    expect(html).not.toContain('| --- |');
  });

  it('details 里的标题不进目录', () => {
    const src = '## 时间表\n\n<details markdown="1">\n<summary>第一天</summary>\n\n### 藏在里面的\n\n内容\n\n</details>\n';
    const { toc } = renderMarkdown(src);
    expect(toc.map((t) => t.text)).toEqual(['时间表']);
  });

  it('嵌套 details 也能配上对', () => {
    const src = '<details markdown="1">\n<summary>外</summary>\n\n<details markdown="1">\n<summary>内</summary>\n\n内容\n\n</details>\n\n</details>\n';
    const { html } = renderMarkdown(src);
    expect(html.match(/<details/g)?.length).toBe(2);
    expect(html.match(/<\/details>/g)?.length).toBe(2);
  });

  it('splitDetails 能认出段与段', () => {
    const segments = splitDetails('前面\n\n<details>\n内\n</details>\n\n后面\n');
    expect(segments.map((s) => s.type)).toEqual(['text', 'details', 'text']);
  });
});

describe('renderMarkdown · 安全', () => {
  it('脚本标签被去掉', () => {
    const { html } = renderMarkdown('正常文本\n\n<script>alert(1)</script>\n');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
  });

  it('事件属性被去掉', () => {
    const { html } = renderMarkdown('<img src="https://example.org/a.png" onerror="alert(1)">\n');
    expect(html).not.toContain('onerror');
  });

  it('javascript: 链接被去掉', () => {
    const { html } = renderMarkdown('[点我](javascript:alert(1))\n');
    expect(html).not.toContain('javascript:');
  });

  it('data: 图片地址被去掉', () => {
    const { html } = renderMarkdown('![x](data:text/html;base64,PHNjcmlwdD4=)\n');
    expect(html).not.toContain('data:text/html');
  });

  it('外链自动补 target 与 rel', () => {
    const { html } = renderMarkdown('[官网](https://example.org/)\n');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('站内相对链接不乱加 target', () => {
    const { html } = renderMarkdown('[另一个活动](../2026-11-other/)\n');
    expect(html).not.toContain('target="_blank"');
  });

  it('样式属性不被放行', () => {
    const { html } = renderMarkdown('<div style="position:fixed;top:0">x</div>\n');
    expect(html).not.toContain('position:fixed');
  });
});

describe('renderMarkdown · 清单', () => {
  it('复选框是可交互的，带稳定 id', () => {
    const { html } = renderMarkdown('- [ ] 买票\n- [ ] 订酒店\n');
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('disabled');
    const ids = [...html.matchAll(/data-check-id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('同样的内容给出同样的 id（刷新后勾还在）', () => {
    const a = renderMarkdown('- [ ] 买票\n- [ ] 订酒店\n').html;
    const b = renderMarkdown('- [ ] 买票\n- [ ] 订酒店\n').html;
    const idsOf = (h: string) => [...h.matchAll(/data-check-id="([^"]+)"/g)].map((m) => m[1]);
    expect(idsOf(a)).toEqual(idsOf(b));
  });

  it('已勾选的项保留 checked', () => {
    const { html } = renderMarkdown('- [x] 已经办了\n');
    expect(html).toContain('checked');
  });

  it('普通列表项不受影响', () => {
    const { html } = renderMarkdown('- 普通项\n');
    expect(html).toContain('<li>普通项</li>');
    expect(html).not.toContain('checkbox');
  });
});

describe('extractCallout', () => {
  it('取出正文开头的引用块', () => {
    const { callout, rest } = extractCallout('> **最重要的 3 件事**：甲、乙、丙\n\n## 速览\n');
    expect(callout).toBe('甲、乙、丙');
    expect(rest).toContain('## 速览');
  });

  it('剥掉重复的标签（模板已经起了标题）', () => {
    const { callout } = extractCallout('> **最重要的 3 件事**：内容在这里\n');
    expect(callout).toBe('内容在这里');
  });

  it('多行引用块也认', () => {
    const { callout } = extractCallout('> 第一条\n> 第二条\n\n正文\n');
    expect(callout).toBe('第一条\n第二条');
  });

  it('正文第一段不是引用块就不提取', () => {
    const { callout, rest } = extractCallout('## 速览\n\n> 中间的引用\n');
    expect(callout).toBeNull();
    expect(rest).toContain('中间的引用');
  });
});

describe('renderInlineMarkdown', () => {
  it('渲染一小段并做安全处理', () => {
    expect(renderInlineMarkdown('**粗**')).toContain('<strong>粗</strong>');
    expect(renderInlineMarkdown('<script>alert(1)</script>')).not.toContain('script');
  });

  it('breaks:true 时换行是硬换行（「最重要的 3 件事」一行一件，不许折成一坨）', () => {
    const src = '第一条；\n第二条。';
    expect(renderInlineMarkdown(src)).not.toMatch(/<br\b/);
    expect(renderInlineMarkdown(src, { breaks: true })).toMatch(/<br\b/);
  });
});

describe('renderMarkdown · 说明性内容收成点开式条目', () => {
  it('「机构与嘉宾」下的三级标题收成机构条目', () => {
    const { html } = renderMarkdown(
      '## 机构与嘉宾\n\n### 某某科技\n\n一家做 AI 基础设施的公司，公开资料显示其产品线覆盖推理服务与向量存储，核心客户包括两家头部电商。\n\n### 张某某\n\n某某科技基础设施负责人。\n',
    );
    expect(html).toContain('<details class="collapse entity"');
    expect(html).toContain('class="collapse-icon"');
    expect(html).toContain('class="collapse-name"');
    // 原标题不再以 h3 的样子摊开
    expect(html).not.toContain('<h3 id="某某科技">');
  });

  it('「前置知识」下的三级标题收成术语条目', () => {
    const { html } = renderMarkdown(
      '## 前置知识\n\n### KV-Cache\n\n大模型推理时缓存注意力键值的机制，直接影响首字延迟与并发成本。\n',
    );
    expect(html).toContain('<details class="collapse term"');
    expect(html).toContain('KV-Cache');
  });

  it('别的章节的三级标题照常平铺，不收成条目', () => {
    const { html } = renderMarkdown('## 社交与提问\n\n### 展台位置\n\n在展区右侧。\n');
    expect(html).not.toContain('class="collapse"');
    expect(html).toContain('<h3 id="展台位置">');
  });

  it('收成条目后不进目录（目录不该列一串嘉宾名）', () => {
    const { toc } = renderMarkdown(
      '## 机构与嘉宾\n\n### 某某科技\n\n说明文字。\n\n### 张某某\n\n说明文字。\n',
    );
    expect(toc.map((t) => t.text)).toEqual(['机构与嘉宾']);
  });

  it('图标取名称第一个字；emoji 开头就用那个 emoji', () => {
    const { html } = renderMarkdown(
      '## 机构与嘉宾\n\n### 某某科技\n\n说明文字说明文字说明文字说明文字说明文字说明文字说明文字。\n\n### 🏢 某某研究院\n\n说明文字说明文字说明文字说明文字说明文字说明文字说明文字。\n',
    );
    // 图标是装饰性的（名字就在旁边），标上 aria-hidden 让读屏软件跳过它
    expect(html).toContain('<span class="collapse-icon" aria-hidden="true">某</span>');
    expect(html).toContain('<span class="collapse-icon" aria-hidden="true">🏢</span>');
    // emoji 不留在名字里
    expect(html).toContain('>某某研究院<');
  });

  it('正文本来就短时不显示摘要（摘要会和正文重复）', () => {
    const short = renderMarkdown('## 机构与嘉宾\n\n### 某某科技\n\n很短的说明。\n').html;
    expect(short).not.toContain('collapse-teaser');
    const long = renderMarkdown(
      '## 机构与嘉宾\n\n### 某某科技\n\n' + '很长的一段背景说明。'.repeat(12) + '\n',
    ).html;
    expect(long).toContain('collapse-teaser');
  });

  it('章节名跨折叠块边界仍然认得出来', () => {
    const src =
      '## 机构与嘉宾\n\n### 某某科技\n\n说明一。\n\n<details markdown="1">\n<summary>插一段</summary>\n\n正文。\n\n</details>\n\n### 张某某\n\n说明二。\n';
    const { html } = renderMarkdown(src);
    // 两个实体都收成条目
    expect(html.match(/<details class="collapse entity"/g)?.length).toBe(2);
  });

  it('同名实体的 id 不撞（目录锚点会跳错）', () => {
    const { html } = renderMarkdown(
      '## 机构与嘉宾\n\n### Acme Corp\n\n说明文字说明文字说明文字说明文字说明文字说明文字说明文字。\n\n### Acme Corp\n\n另一段说明文字说明文字说明文字说明文字说明文字说明文字说明。\n',
    );
    const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('acme-corp');
    expect(ids).toContain('acme-corp-2');
  });

  it('收成条目后正文还在（点开能看到）', () => {
    const { html } = renderMarkdown(
      '## 机构与嘉宾\n\n### 某某科技\n\n' + '具体背景说明。'.repeat(8) + '\n',
    );
    expect(html).toContain('collapse-body');
    expect(html).toContain('具体背景说明。');
  });

  it('代码块里的 ### 不会被当成标题收成条目', () => {
    const src = '## 机构与嘉宾\n\n```markdown\n### 这是代码示例\n```\n\n正文。\n';
    const { html } = renderMarkdown(src);
    expect(html).not.toContain('class="collapse"');
    expect(html).toContain('<pre>');
  });

  it('没闭合的 details 退回正文，不会吞掉后面的内容', () => {
    const src = '## 速览\n\n<details markdown="1">\n<summary>没闭合\n\n后面的正文。\n';
    const { html } = renderMarkdown(src);
    expect(html).toContain('后面的正文。');
  });

  it('正文里的链接带 tabindex="0"（Safari 默认不把链接放进 Tab 序列）', () => {
    const { html } = renderMarkdown('看 [官方页面](https://example.org/) 和 [站内](../other/)\n');
    const links = [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
    expect(links.length).toBe(2);
    for (const link of links) expect(link).toContain('tabindex="0"');
    // 站内相对链接不加 target，外链才加
    expect(links[1]).not.toContain('target=');
    expect(links[0]).toContain('rel="noopener noreferrer"');
  });
});
