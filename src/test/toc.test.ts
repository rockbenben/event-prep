/**
 * 目录侧栏的渲染。
 *
 * ⚠️ 这里量的是**目录的形状**：三级标题要收进二级标题下面，
 *    孤立的标题不能被丢掉——丢掉等于读者在目录里找不到那一节。
 */

import { describe, expect, it } from 'vitest';
import { renderToc } from '../templates/event.ts';
import type { TocEntry } from '../lib/markdown.ts';

function entry(id: string, text: string, depth: number): TocEntry {
  return { id, text, depth };
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
});
