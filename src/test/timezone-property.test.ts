/**
 * 时区换算的性质检查：只拿 Intl 自己对，不引第二套库。
 *
 * 要验证的性质：
 *   对任意 (时区, 自然日)，
 *     1. zonedDayStart 落在**那一天**（当地日期 == 目标日期）
 *     2. 它是那一天的**第一个瞬间**（往前挪 1 毫秒，当地日期就变早了）
 *
 * 这两条成立，说明换算没有「差一天」「落到前一天」「落到后一天」这类错。
 * 用 Intl 当基准，就不必为了自证再引一个时区库。
 */

import { describe, expect, it } from 'vitest';
import { isCalendarDate, zonedDayStart } from '../lib/timezone.ts';

/** 当地时区里，这个瞬间是第几天。 */
function localDate(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}`;
}

/** 覆盖各种「不乖」的时区：半小时、45 分钟、夏令时在午夜切换、全球两端。 */
const ZONES = [
  'Asia/Shanghai',        // +8
  'Asia/Kolkata',         // +5:30
  'Asia/Kathmandu',       // +5:45
  'Asia/Tehran',          // +3:30
  'Asia/Tokyo',           // +9
  'Australia/Adelaide',   // +9:30 / +10:30
  'Australia/Lord_Howe',  // +10:30 / +11
  'Pacific/Chatham',      // +12:45 / +13:45
  'Pacific/Kiritimati',   // +14
  'Pacific/Midway',       // -11
  'America/New_York',     // -5 / -4
  'America/Chicago',      // -6 / -5
  'America/Phoenix',      // -7（无夏令时）
  'America/Santiago',     // -4 / -3，**夏令时在午夜切换**
  'America/Sao_Paulo',    // -3，**夏令时在午夜切换**
  'America/Havana',       // -5 / -4，午夜切换
  'America/St_Johns',     // -3:30 / -2:30
  'Europe/London',        // 0 / +1
  'Europe/Dublin',
  'Europe/Berlin',        // +1 / +2
  'Africa/Cairo',         // +2
  'UTC',
];

// 夏令时切换前后 + 平时的日期，覆盖南北半球
const DATES = [
  '2026-01-15', '2026-03-01', '2026-03-08', '2026-03-09', '2026-03-29',
  '2026-06-15', '2026-09-06', '2026-09-07', '2026-10-25', '2026-11-01',
  '2026-11-03', '2026-12-15',
];

describe('时区换算的性质（基准是 Intl 自己）', () => {
  for (const tz of ZONES) {
    it(`${tz}：每一天都落在正确的那一天，且是当天的第一个瞬间`, () => {
      const problems: string[] = [];

      for (const date of DATES) {
        expect(isCalendarDate(date)).toBe(true);
        const start = zonedDayStart(date, tz);

        // 1. 落在那一天
        const got = localDate(start, tz);
        if (got !== date) {
          problems.push(`${date} → 当地日期变成 ${got}（差得离谱）`);
          continue;
        }

        // 2. 是那天的第一个瞬间：往前 1 毫秒必须已经更早
        const before = localDate(new Date(start.getTime() - 1), tz);
        if (before >= date) {
          problems.push(`${date} → 前 1 毫秒仍是 ${before}，不是当天的第一个瞬间`);
        }
      }

      expect(problems).toEqual([]);
    });
  }
});

describe('已知的整数偏移口径', () => {
  it('半小时 / 45 分钟偏移不会落到隔天', () => {
    expect(localDate(zonedDayStart('2026-06-15', 'Asia/Kolkata'), 'Asia/Kolkata')).toBe('2026-06-15');
    expect(localDate(zonedDayStart('2026-06-15', 'Asia/Kathmandu'), 'Asia/Kathmandu')).toBe('2026-06-15');
    expect(localDate(zonedDayStart('2026-06-15', 'America/St_Johns'), 'America/St_Johns')).toBe('2026-06-15');
  });

  it('全球两端也没问题', () => {
    expect(localDate(zonedDayStart('2026-06-15', 'Pacific/Kiritimati'), 'Pacific/Kiritimati')).toBe('2026-06-15');
    expect(localDate(zonedDayStart('2026-06-15', 'Pacific/Midway'), 'Pacific/Midway')).toBe('2026-06-15');
  });
});
