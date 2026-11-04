import { describe, expect, it } from 'vitest';
import {
  calendarDaysBetween,
  computeStatus,
  countdownText,
  dayCount,
  formatDateRange,
  formatDuration,
  resolveTiming,
} from '../lib/status.ts';

describe('resolveTiming', () => {
  it('把活动自然日按活动时区解析成瞬间', () => {
    const timing = resolveTiming({ start: '2026-11-05', timezone: 'Asia/Shanghai' });
    expect(timing.startISO).toBe('2026-11-04T16:00:00.000Z');
    expect(timing.timezone).toBe('Asia/Shanghai');
    expect(timing.timezoneKnown).toBe(true);
  });

  it('end 是含当日的：11-05 至 11-06 的结束瞬间是 11-07 当地 00:00', () => {
    const timing = resolveTiming({ start: '2026-11-05', end: '2026-11-06', timezone: 'Asia/Shanghai' });
    expect(timing.endISO).toBe('2026-11-06T16:00:00.000Z');
    expect(timing.days).toBe(2);
  });

  it('不写 end 时按单日活动处理', () => {
    const timing = resolveTiming({ start: '2026-11-05', timezone: 'Asia/Shanghai' });
    expect(timing.endISO).toBe('2026-11-05T16:00:00.000Z');
    expect(timing.days).toBe(1);
  });

  it('没有时区就回退到 UTC，并如实标记不是活动所在地时区', () => {
    const timing = resolveTiming({ start: '2026-11-05' });
    expect(timing.timezone).toBe('UTC');
    expect(timing.timezoneKnown).toBe(false);
    expect(timing.startISO).toBe('2026-11-05T00:00:00.000Z');
  });

  it('没有日期时状态未知', () => {
    const timing = resolveTiming({});
    expect(timing.startISO).toBeNull();
    expect(timing.endISO).toBeNull();
    expect(computeStatus(timing, new Date())).toBe('unknown');
  });

  it('非法时区退回 UTC，并如实标记不是活动所在地时区', () => {
    const timing = resolveTiming({ start: '2026-11-05', timezone: 'Shanghai' });
    expect(timing.timezone).toBe('UTC');
    expect(timing.timezoneKnown).toBe(false);
  });

  it('end 早于 start 时退回单日，不算出负的天数', () => {
    const timing = resolveTiming({ start: '2026-11-06', end: '2026-11-05', timezone: 'Asia/Shanghai' });
    expect(timing.end).toBeNull();
    expect(timing.days).toBe(1);
  });
});

describe('computeStatus', () => {
  const timing = resolveTiming({ start: '2026-11-05', end: '2026-11-06', timezone: 'Asia/Shanghai' });

  it('开幕之前是即将开始', () => {
    // 2026-11-04 16:00Z = 11-05 00:00 之前一秒
    expect(computeStatus(timing, new Date('2026-11-04T15:59:59.000Z'))).toBe('upcoming');
  });

  it('开幕当刻进入进行中', () => {
    expect(computeStatus(timing, new Date('2026-11-04T16:00:00.000Z'))).toBe('ongoing');
  });

  it('第二天仍然是进行中', () => {
    expect(computeStatus(timing, new Date('2026-11-05T12:00:00.000Z'))).toBe('ongoing');
  });

  it('结束瞬间之后是已结束', () => {
    expect(computeStatus(timing, new Date('2026-11-06T16:00:00.000Z'))).toBe('ended');
  });

  it('跨时区看，判定的是同一个瞬间', () => {
    const shanghai = resolveTiming({ start: '2026-11-05', timezone: 'Asia/Shanghai' });
    const now = new Date('2026-11-04T17:00:00.000Z');
    expect(computeStatus(shanghai, now)).toBe('ongoing');
    // 纽约此刻还是 11-04，但那不是活动所在地的时间——活动按上海算
    expect(computeStatus(shanghai, now)).toBe(computeStatus(shanghai, now));
  });
});

describe('countdownText', () => {
  it('即将开始：整日不补「0 小时」，有零头才带上小时', () => {
    const timing = resolveTiming({ start: '2026-11-08', timezone: 'Asia/Shanghai' });
    // 正好差 3 天：以前写成「还有 3 天 0 小时」，看着像没算完
    expect(countdownText(timing, new Date('2026-11-04T16:00:00.000Z'))).toBe('还有 3 天');
    expect(countdownText(timing, new Date('2026-11-04T11:00:00.000Z'))).toBe('还有 3 天 5 小时');
  });

  it('进行中的多日活动报第几天', () => {
    const timing = resolveTiming({ start: '2026-11-05', end: '2026-11-07', timezone: 'Asia/Shanghai' });
    const text = countdownText(timing, new Date('2026-11-05T04:00:00.000Z'));
    expect(text).toContain('第 1 / 3 天');
  });

  it('结束后说已结束，日期未知说日期待定', () => {
    const timing = resolveTiming({ start: '2026-01-05', timezone: 'Asia/Shanghai' });
    expect(countdownText(timing, new Date('2026-02-01T00:00:00.000Z'))).toBe('已结束');
    expect(countdownText(resolveTiming({}), new Date())).toBe('日期待定');
  });
});

describe('dayCount / calendarDaysBetween / formatDateRange', () => {
  it('dayCount 含首尾，calendarDaysBetween 是差值', () => {
    expect(dayCount('2026-11-05', '2026-11-05')).toBe(1);
    expect(dayCount('2026-11-05', '2026-11-06')).toBe(2);
    expect(dayCount('2026-12-30', '2027-01-02')).toBe(4);
    expect(calendarDaysBetween('2026-11-05', '2026-11-05')).toBe(0);
    expect(calendarDaysBetween('2026-11-05', '2026-11-06')).toBe(1);
  });

  it('同年只写一次年', () => {
    const timing = resolveTiming({ start: '2026-11-05', end: '2026-11-06', timezone: 'Asia/Shanghai' });
    expect(formatDateRange(timing)).toBe('2026年11月5日 – 11月6日');
  });

  it('跨年两个年份都写', () => {
    const timing = resolveTiming({ start: '2026-12-30', end: '2027-01-02', timezone: 'Asia/Shanghai' });
    expect(formatDateRange(timing)).toBe('2026年12月30日 – 2027年1月2日');
  });

  it('单日活动只写一天', () => {
    const timing = resolveTiming({ start: '2026-11-05', timezone: 'Asia/Shanghai' });
    expect(formatDateRange(timing)).toBe('2026年11月5日');
  });

  it('没有日期就说明日期待定，不编', () => {
    expect(formatDateRange(resolveTiming({}))).toBe('日期待定');
  });
});

describe('formatDuration', () => {
  it('整小时不补「0 分钟」', () => {
    expect(formatDuration(3 * 3600000)).toBe('3 小时');
    expect(formatDuration(3 * 3600000 + 20 * 60000)).toBe('3 小时 20 分钟');
    expect(formatDuration(20 * 60000)).toBe('20 分钟');
  });
});
