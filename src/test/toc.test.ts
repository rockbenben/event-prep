/**
 * 目录侧栏的渲染。
 *
 * ⚠️ 这里量的是**目录的形状**：三级标题要收进二级标题下面，
 *    孤立的标题不能被丢掉——丢掉等于读者在目录里找不到那一节。
 */

import { describe, expect, it } from 'vitest';
import { renderToc } from '../templates/event.ts';
import type { TocEntry } from '../lib/markdown.ts';

function entry(id: string, text: string, depth: number, kind?: 'agenda-day' | 'route'): TocEntry {
  return { id, text, depth, ...(kind ? { kind } : {}) };
}

describe('renderToc', () => {
  it('没有目录就不渲染', () => {
    expect(renderToc([])).toBe('');
  });

  it('二级标题平铺出来', () => {
    const html = renderToc([entry('a', '速览', 2), entry('b', '日程', 2)]);
    expect(html).toContain('本页目录');
    expect(html).toContain('href="#a"');
    expect(html).toContain('href="#b"');
    expect(html).not.toContain('展开');
  });

  it('三级标题收进二级标题下面的子列表，默认不展开', () => {
    const html = renderToc([
      entry('a', '速览', 2),
      entry('r', '推荐路线', 2),
      entry('r1', '路线一', 3),
      entry('r2', '路线二', 3),
      entry('c', '行前清单', 2),
    ]);
    // 子项在折叠块里
    expect(html).toContain('toc-sub');
    expect(html).toContain('展开 2 项');
    expect(html).toContain('href="#r1"');
    expect(html).toContain('href="#r2"');
    // 顶层章节仍在
    expect(html).toContain('href="#a"');
    expect(html).toContain('href="#c"');
    // 子列表默认收起：details 上不能有 open
    expect(html).not.toMatch(/<details class="toc-sub" open/);
  });

  it('孤立的三级标题照样列出来，不能丢', () => {
    const html = renderToc([entry('x', '没有上级的三级', 3)]);
    expect(html).toContain('href="#x"');
    expect(html).not.toContain('toc-sub');
  });

  it('多个二级标题各自带子列表，展开项数各算各的', () => {
    const html = renderToc([
      entry('a', '甲', 2),
      entry('a1', '甲一', 3),
      entry('b', '乙', 2),
      entry('b1', '乙一', 3),
      entry('b2', '乙二', 3),
    ]);
    expect(html).toContain('展开 1 项');
    expect(html).toContain('展开 2 项');
  });

  it('日程各天直接摊开在「日程」下面（不用先点「展开 N 项」），带可点的锚点', () => {
    const html = renderToc([
      entry('s', '速览', 2),
      entry('agenda', '日程', 2),
      entry('day-1', 'Day 1 · 11 月 5 日', 3, 'agenda-day'),
      entry('day-2', 'Day 2 · 11 月 6 日', 3, 'agenda-day'),
      entry('c', '行前清单', 2),
    ]);
    expect(html).toContain('href="#day-1"');
    expect(html).toContain('href="#day-2"');
    expect(html).toContain('toc-agenda-day');
    // ⚠️ 各天**不能**藏在折叠的「展开 N 项」里：用户要的就是「看到日期 → 点一下跳过去」
    expect(html).not.toContain('展开 2 项');
    expect(html).not.toContain('toc-sub');
    // 顶层章节仍在
    expect(html).toContain('href="#s"');
    expect(html).toContain('href="#c"');
  });

  it('日程各天与普通三级标题混在一起时：各天摊开，其它照旧收着', () => {
    const html = renderToc([
      entry('agenda', '日程', 2),
      entry('day-1', 'Day 1 · 11 月 5 日', 3, 'agenda-day'),
      entry('r', '推荐路线', 2),
      entry('r1', '路线一', 3),
      entry('r2', '路线二', 3),
    ]);
    // 各天在常开的列表里
    expect(html).toContain('toc-flat-list');
    expect(html).toContain('href="#day-1"');
    // 别的三级标题仍然收着
    expect(html).toContain('展开 2 项');
    expect(html).toContain('toc-sub');
    expect(html).toContain('href="#r1"');
  });

  it('推荐路线的每条也摊开（读者按角色找路，不用先点「展开 N 项」）', () => {
    const html = renderToc([
      entry('r', '推荐路线', 2),
      entry('r1', '路线一', 3, 'route'),
      entry('r2', '路线二', 3, 'route'),
    ]);
    expect(html).toContain('href="#r1"');
    expect(html).toContain('href="#r2"');
    expect(html).toContain('toc-route');
    expect(html).not.toContain('展开 2 项');
    expect(html).not.toContain('toc-sub');
  });
});
