import { describe, expect, it } from 'vitest';
import {
  addDays,
  dateParts,
  isCalendarDate,
  isValidTimeZone,
  zoneOffsetMs,
  zonedDayStart,
} from '../lib/timezone.ts';

describe('isValidTimeZone', () => {
  it('认识 IANA 时区名', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
  });

  it('拒绝乱写的时区', () => {
    expect(isValidTimeZone('Shanghai')).toBe(false);
    expect(isValidTimeZone('Asia/Nowhere')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(' Asia/Shanghai ')).toBe(false);
  });
});

describe('zoneOffsetMs', () => {
  it('算出上海与 UTC 的 +8 小时', () => {
    const instant = new Date('2026-07-01T00:00:00.000Z');
    expect(zoneOffsetMs(instant, 'Asia/Shanghai')).toBe(8 * 3600 * 1000);
    expect(zoneOffsetMs(instant, 'UTC')).toBe(0);
  });

  it('纽约冬令时是 -5 夏令时是 -4', () => {
    expect(zoneOffsetMs(new Date('2026-01-15T12:00:00.000Z'), 'America/New_York')).toBe(-5 * 3600 * 1000);
    expect(zoneOffsetMs(new Date('2026-07-15T12:00:00.000Z'), 'America/New_York')).toBe(-4 * 3600 * 1000);
  });
});

describe('zonedDayStart', () => {
  it('上海 11 月 5 日 00:00 = UTC 前一天 16:00', () => {
    const start = zonedDayStart('2026-11-05', 'Asia/Shanghai');
    expect(start.toISOString()).toBe('2026-11-04T16:00:00.000Z');
  });

  it('UTC 时区就是当天 00:00', () => {
    expect(zonedDayStart('2026-11-05', 'UTC').toISOString()).toBe('2026-11-05T00:00:00.000Z');
  });

  it('纽约 11 月 5 日 00:00 = UTC 当天 05:00（夏令时）', () => {
    expect(zonedDayStart('2026-11-05', 'America/New_York').toISOString()).toBe('2026-11-05T05:00:00.000Z');
  });

  it('纽约 1 月 5 日 00:00 = UTC 当天 05:00（冬令时）', () => {
    expect(zonedDayStart('2026-01-05', 'America/New_York').toISOString()).toBe('2026-01-05T05:00:00.000Z');
  });

  it('跨夏令时切换的日子也取到当地 00:00', () => {
    // 美东 2026-03-08 是夏令时开始日，当天 00:00 仍是 -5
    expect(zonedDayStart('2026-03-08', 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    // 上海没有夏令时，跨年也不受影响
    expect(zonedDayStart('2026-12-31', 'Asia/Shanghai').toISOString()).toBe('2026-12-30T16:00:00.000Z');
  });
});

describe('addDays', () => {
  it('跨月跨年都对', () => {
    expect(addDays('2026-11-05', 1)).toBe('2026-11-06');
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('isCalendarDate', () => {
  it('接受真实存在的日期', () => {
    expect(isCalendarDate('2026-11-05')).toBe(true);
    expect(isCalendarDate('2024-02-29')).toBe(true);
  });

  it('拒绝不存在的日期和错格式', () => {
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('2025-02-29')).toBe(false);
    expect(isCalendarDate('2026-11-5')).toBe(false);
    expect(isCalendarDate('11/05/2026')).toBe(false);
  });
});

describe('dateParts', () => {
  it('dateParts 解析或返回 null', () => {
    expect(dateParts('2026-11-05')).toEqual({ y: 2026, m: 11, d: 5 });
    expect(dateParts('nope')).toBeNull();
  });
});
