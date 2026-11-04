import { describe, expect, it } from 'vitest';
import { parseFrontMatter, splitFrontMatter } from '../lib/frontmatter.ts';

describe('splitFrontMatter', () => {
  it('切出 front matter 与正文', () => {
    const src = '---\ntitle: 示例\n---\n\n正文内容\n';
    const result = splitFrontMatter(src);
    expect(result.error).toBeNull();
    expect(result.yaml).toBe('title: 示例');
    expect(result.body).toBe('\n正文内容\n');
  });

  it('没有 front matter 是错误', () => {
    const result = splitFrontMatter('# 直接是正文\n');
    expect(result.error).toContain('front matter');
  });

  it('没闭合是错误', () => {
    const result = splitFrontMatter('---\ntitle: 示例\n\n正文\n');
    expect(result.error).toContain('没有闭合');
  });

  it('容忍 BOM 和 CRLF', () => {
    const result = splitFrontMatter('\uFEFF---\r\ntitle: 示例\r\n---\r\n正文\r\n');
    expect(result.error).toBeNull();
    expect(result.yaml).toContain('title');
  });
});

describe('parseFrontMatter', () => {
  it('解析出字段', () => {
    const result = parseFrontMatter('---\ntitle: 示例\ntags: [a, b]\n---\n正文');
    expect(result.error).toBeNull();
    expect(result.data.title).toBe('示例');
    expect(result.data.tags).toEqual(['a', 'b']);
  });

  it('YAML 语法错要报清楚行号', () => {
    const result = parseFrontMatter('---\ntitle: "没闭合\n---\n正文');
    expect(result.error).toContain('YAML 解析失败');
  });

  it('front matter 不是映射是错误', () => {
    const result = parseFrontMatter('---\n- 一\n- 二\n---\n正文');
    expect(result.error).toContain('映射');
  });

  it('空的 front matter 是错误', () => {
    const result = parseFrontMatter('---\n---\n正文');
    expect(result.error).toContain('空');
  });

  it('日期按字符串读，不会变成 Date 对象', () => {
    const result = parseFrontMatter('---\ntitle: x\nstart: 2026-11-05\n---\n正文');
    expect(result.data.start).toBe('2026-11-05');
    expect(typeof result.data.start).toBe('string');
  });
});
