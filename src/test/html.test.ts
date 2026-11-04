import { describe, expect, it } from 'vitest';
import { escapeHtml, escapeJsonForScript, hashText, htmlToPlain, slugify } from '../lib/html.ts';

describe('escapeJsonForScript', () => {
  it('不留下裸的 < > &，免得 </script> 提前把脚本块收尾', () => {
    const out = escapeJsonForScript({ title: '</script><img src=x onerror=alert(1)>' });
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).not.toContain('&');
    // 解回来还是原值
    expect(JSON.parse(out).title).toBe('</script><img src=x onerror=alert(1)>');
  });

  it('普通内容原样保留', () => {
    expect(JSON.parse(escapeJsonForScript({ a: 1, b: '中文' }))).toEqual({ a: 1, b: '中文' });
  });
});

describe('escapeHtml', () => {
  it('把五个危险字符转义', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });
});

describe('slugify', () => {
  it('中文保留，空格变连字符', () => {
    expect(slugify('速览')).toBe('速览');
    expect(slugify('Day 1 · 11 月 5 日')).toBe('day-1-11-月-5-日');
  });

  it('标点被去掉，空的兜底成 section', () => {
    expect(slugify('!!!')).toBe('section');
    expect(slugify('  ')).toBe('section');
  });
});

describe('htmlToPlain', () => {
  it('去标签、反解实体、压空白', () => {
    expect(htmlToPlain('<p>甲 &amp; 乙</p>')).toBe('甲 & 乙');
    expect(htmlToPlain('<span>a</span>\n<span>b</span>')).toBe('a b');
  });
});

describe('hashText', () => {
  it('同样的文字得到同样的哈希（清单项的 id 要稳定）', () => {
    expect(hashText('买票')).toBe(hashText('买票'));
    expect(hashText('买票')).not.toBe(hashText('订酒店'));
  });

  it('空白折叠后再算，连续空格和单个空格是同一个 id', () => {
    expect(hashText('买  票')).toBe(hashText('买 票'));
  });
});
