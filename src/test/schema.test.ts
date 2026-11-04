import { describe, expect, it } from 'vitest';
import { validateEvent } from '../lib/schema.ts';

describe('validateEvent', () => {
  it('接受一份完整合法的活动', () => {
    const { meta, errors } = validateEvent({
      title: '示例大会 2026',
      summary: '一句话简介',
      start: '2026-11-05',
      end: '2026-11-06',
      timezone: 'Asia/Shanghai',
      city: '上海',
      venue: '示例会场',
      venue_url: 'https://example.org/venue',
      address: '示例地址',
      organizer: '示例主办方',
      website: 'https://example.org/',
      agenda_url: 'https://example.org/agenda',
      ticket_url: 'https://example.org/tickets',
      map_url: 'https://example.org/map',
      tags: ['AI', '大会'],
    });
    expect(errors).toEqual([]);
    expect(meta.title).toBe('示例大会 2026');
    expect(meta.tags).toEqual(['AI', '大会']);
  });

  it('title 缺失或为空是错误', () => {
    expect(validateEvent({}).errors.some((e) => e.includes('title'))).toBe(true);
    expect(validateEvent({ title: '   ' }).errors.some((e) => e.includes('title'))).toBe(true);
    expect(validateEvent({ title: 123 }).errors.some((e) => e.includes('title'))).toBe(true);
  });

  it('日期格式错、不存在、倒序都是错误', () => {
    expect(validateEvent({ title: 'x', start: '2026-11-5' }).errors.some((e) => e.includes('start'))).toBe(true);
    expect(validateEvent({ title: 'x', start: '2026-02-30' }).errors.some((e) => e.includes('start'))).toBe(true);
    expect(validateEvent({ title: 'x', start: '2026/11/05' }).errors.some((e) => e.includes('start'))).toBe(true);
    const reversed = validateEvent({ title: 'x', start: '2026-11-06', end: '2026-11-05' });
    expect(reversed.errors.some((e) => e.includes('end'))).toBe(true);
  });

  it('非法时区是错误', () => {
    expect(validateEvent({ title: 'x', timezone: 'Shanghai' }).errors.some((e) => e.includes('timezone'))).toBe(true);
  });

  it('链接必须是 http(s)', () => {
    expect(validateEvent({ title: 'x', website: 'ftp://example.org' }).errors.some((e) => e.includes('website'))).toBe(true);
    expect(validateEvent({ title: 'x', website: 'javascript:alert(1)' }).errors.some((e) => e.includes('website'))).toBe(true);
    expect(validateEvent({ title: 'x', website: '不是网址' }).errors.some((e) => e.includes('website'))).toBe(true);
    expect(validateEvent({ title: 'x', website: 'https://example.org/' }).errors).toEqual([]);
  });

  it('venue_url 是场地官方页面的链接，规则跟别的链接一样', () => {
    const { meta, errors, warnings } = validateEvent({
      title: 'x',
      venue: '示例会场',
      venue_url: 'https://example.org/venue',
    });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(meta.venue_url).toBe('https://example.org/venue');
    // 不是 http(s) 就是错：这是会被渲染成 <a href> 的字段
    expect(validateEvent({ title: 'x', venue_url: 'javascript:alert(1)' }).errors.some((e) => e.includes('venue_url'))).toBe(
      true,
    );
    expect(validateEvent({ title: 'x', venue_url: '不是网址' }).errors.some((e) => e.includes('venue_url'))).toBe(true);
    // 不写就是没写，不是错
    expect(validateEvent({ title: 'x', venue: '示例会场' }).meta.venue_url).toBeUndefined();
  });

  it('tags 可以是数组也可以是单个字符串', () => {
    expect(validateEvent({ title: 'x', tags: ['a', 'b'] }).meta.tags).toEqual(['a', 'b']);
    expect(validateEvent({ title: 'x', tags: 'a' }).meta.tags).toEqual(['a']);
    expect(validateEvent({ title: 'x', tags: 123 }).errors.some((e) => e.includes('tags'))).toBe(true);
  });

  it('未知字段是提醒不是错误', () => {
    const result = validateEvent({ title: 'x', tittle: '拼错了' });
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes('tittle'))).toBe(true);
  });

  it('空字符串字段当作没写', () => {
    const { meta, errors } = validateEvent({ title: 'x', summary: '', city: '   ' });
    expect(errors).toEqual([]);
    expect(meta.summary).toBeUndefined();
    expect(meta.city).toBeUndefined();
  });

  it('类型不对是错误，值不对是提醒', () => {
    expect(validateEvent({ title: 'x', summary: 123 }).errors.some((e) => e.includes('summary'))).toBe(true);
    const mixed = validateEvent({ title: 'x', tags: ['a', 5] });
    expect(mixed.errors).toEqual([]);
    expect(mixed.warnings.some((w) => w.includes('tags'))).toBe(true);
    expect(mixed.meta.tags).toEqual(['a']);
  });

  it('时区是空白算提醒，非法算错误', () => {
    expect(validateEvent({ title: 'x', timezone: '  ' }).warnings.some((w) => w.includes('timezone'))).toBe(true);
    expect(validateEvent({ title: 'x', timezone: 'Shanghai' }).errors.some((e) => e.includes('timezone'))).toBe(true);
  });
});
