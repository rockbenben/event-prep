/**
 * 活动的时间状态：什么时候开始、什么时候结束、现在算「即将开始 / 进行中 / 已结束」。
 *
 * ⚠️ 状态**不是构建时定死的**。构建时只把「活动自然日 + 时区」解析成**绝对瞬间**
 * （UTC ISO 字符串），真正的判定在浏览器里按访问时刻算。所以明天的活动不会因为
 * 站点是昨天构建的就一直显示「即将开始」。
 *
 * ⚠️ 时区回退：`event.md` 没写 `timezone` 时用 **UTC** 计算，并在页面上写明
 * 「未提供时区，按 UTC 计算」——不假装那就是活动所在地的时间。
 */

import {
  addDays,
  dateParts,
  isCalendarDate,
  isValidTimeZone,
  zonedDayStart,
  zonedMinuteOfDay,
} from './timezone.ts';

/** 活动时区缺失时的回退值。页面上会如实标注，不会说这是活动所在地时区。 */
export const FALLBACK_TIMEZONE = 'UTC';

export type EventStatus = 'upcoming' | 'ongoing' | 'ended' | 'unknown';

export interface EventTiming {
  /** 开始瞬间（UTC ISO）。日期未知时为 null。 */
  startISO: string | null;
  /** 结束瞬间（UTC ISO，**不含**这一瞬间）。日期未知时为 null。 */
  endISO: string | null;
  /** 实际用来计算的时区。 */
  timezone: string;
  /** 时区是不是活动自己声明的；false 表示用的是回退值。 */
  timezoneKnown: boolean;
  /** 活动占几个自然日（单日活动为 1）。 */
  days: number | null;
  /** 活动原始日期（`YYYY-MM-DD`），给显示用。 */
  start: string | null;
  end: string | null;
  /**
   * 开始时刻在活动时区的「第几分钟」（570 = 09:30）。
   *
   * ⚠️ null = **没有议程信息**，按当天 00:00 算。
   *    有值才说明这个时刻是从议程首场推出来的，可以放心显示给读者。
   */
  startMinute: number | null;
}

export interface TimingInput {
  start?: string;
  end?: string;
  timezone?: string;
  /**
   * 每天的实际开场时刻（当地「第几分钟」），按天序，从议程首场推出来。
   *
   * ⚠️ 议程里**没有**每一天的首场时间时，这一项是空的——
   *    那就退回按日期算（00:00），跟以前一样，不假装知道。
   */
  dayStartMinutes?: (number | null)[];
  /**
   * 每天的实际散场时刻（当地「第几分钟」），按天序，从议程末场推出来。
   *
   * ⚠️ 只有议程**覆盖了活动的全部天数**时它才被采信——
   *    议程缺了几天（作者还没写完）时，按日期算结束更保守。
   */
  dayEndMinutes?: (number | null)[];
}

/**
 * 把「自然日 + 时区」解析成绝对瞬间。
 * `end` 是**含当日**的：活动 11-05 至 11-06，则结束瞬间是 11-07 00:00（活动所在地时区）。
 *
 * ⚠️ `dayStartMinutes` 来自议程首场：有它就用**真实开场时刻**当开始瞬间
 *    （比如第一天 08:30 开始签到，而不是当天 00:00）；没有就退回按日期算。
 * ⚠️ `dayEndMinutes` 来自议程末场：议程覆盖了全部天数时用它当结束瞬间，
 *    这样「进行中」这个区间两头都对得上议程。
 */
export function resolveTiming(input: TimingInput): EventTiming {
  const timezoneKnown = Boolean(input.timezone && isValidTimeZone(input.timezone));
  const timezone = timezoneKnown ? (input.timezone as string) : FALLBACK_TIMEZONE;

  const start = input.start && isCalendarDate(input.start) ? input.start : null;
  const end = input.end && isCalendarDate(input.end) ? input.end : null;

  if (!start) {
    return {
      startISO: null,
      endISO: null,
      timezone,
      timezoneKnown,
      days: null,
      start: null,
      end: null,
      startMinute: null,
    };
  }

  // `end` 省略时按单日活动处理；结束瞬间统一取「结束日之后那一天的 00:00」
  const lastDay = end && end >= start ? end : start;
  const totalDays = dayCount(start, lastDay);

  const starts = input.dayStartMinutes ?? [];
  const ends = input.dayEndMinutes ?? [];

  // 开始瞬间 = 第一天的真实开场时刻（议程首场）；没有议程 → 当天 00:00
  const startMinute = starts[0] ?? null;
  const startInstant =
    startMinute === null ? zonedDayStart(start, timezone) : zonedMinuteOfDay(start, timezone, startMinute);

  // 结束瞬间：议程覆盖了全部天数就用议程末场，否则退回按日期算
  const lastEndMinute = ends.length >= totalDays ? (ends[totalDays - 1] ?? null) : null;
  let endInstant = zonedDayStart(addDays(lastDay, 1), timezone);
  if (lastEndMinute !== null) {
    const candidate = zonedMinuteOfDay(lastDay, timezone, lastEndMinute);
    // 结束不能早于开始：否则活动一打开就是「已结束」
    if (candidate.getTime() > startInstant.getTime()) endInstant = candidate;
  }

  return {
    startISO: startInstant.toISOString(),
    endISO: endInstant.toISOString(),
    timezone,
    timezoneKnown,
    days: totalDays,
    start,
    end: end && end >= start ? end : null,
    startMinute,
  };
}

/** 两个日期相差几天（end - start，可为负）。 */
export function calendarDaysBetween(start: string, end: string): number {
  const a = dateParts(start);
  const b = dateParts(end);
  if (!a || !b) return 0;
  const ta = Date.UTC(a.y, a.m - 1, a.d);
  const tb = Date.UTC(b.y, b.m - 1, b.d);
  return Math.round((tb - ta) / 86400000);
}

/** 含首尾的自然日天数（11-05 到 11-05 是 1 天）。 */
export function dayCount(start: string, end: string): number {
  return calendarDaysBetween(start, end) + 1;
}

/** 按访问时刻判定状态。 */
export function computeStatus(timing: EventTiming, now: Date = new Date()): EventStatus {
  if (!timing.startISO) return 'unknown';
  const t = now.getTime();
  const start = Date.parse(timing.startISO);
  // 坏的时间戳要判成 unknown：浏览器端就是这个口径，两边不能一个 ongoing 一个 unknown
  if (Number.isNaN(start)) return 'unknown';
  if (t < start) return 'upcoming';
  if (timing.endISO) {
    const end = Date.parse(timing.endISO);
    if (!Number.isNaN(end) && t >= end) return 'ended';
  }
  return 'ongoing';
}

export const STATUS_LABEL: Record<EventStatus, string> = {
  upcoming: '即将开始',
  ongoing: '进行中',
  ended: '已结束',
  unknown: '日期待定',
};

/** 倒计时文案。空壳状态不编造。 */
export function countdownText(timing: EventTiming, now: Date = new Date()): string {
  const status = computeStatus(timing, now);
  if (status === 'unknown') return '日期待定';
  if (status === 'ended') return '已结束';

  const t = now.getTime();
  const start = Date.parse(timing.startISO as string);
  const end = Date.parse(timing.endISO as string);

  if (status === 'upcoming') {
    const diff = start - t;
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    // 整日/整时不补「0 小时」「0 分钟」——「还有 1 天 0 小时」看着像没算完
    if (days > 0) return hours > 0 ? `还有 ${days} 天 ${hours} 小时` : `还有 ${days} 天`;
    if (hours > 0) return minutes > 0 ? `还有 ${hours} 小时 ${minutes} 分钟` : `还有 ${hours} 小时`;
    if (minutes > 0) return `还有 ${minutes} 分钟`;
    return '马上开始';
  }

  // 进行中：说清楚是第几天 / 共几天
  const totalDays = timing.days ?? 1;
  const dayIndex = Math.min(
    totalDays,
    Math.max(1, calendarDaysBetween(timing.start as string, localDateIn(timing, now)) + 1),
  );
  if (totalDays > 1) return `进行中 · 第 ${dayIndex} / ${totalDays} 天`;
  return `进行中 · 还剩 ${formatDuration(end - t)}`;
}

/**
 * 活动当前所处的自然日（按活动时区算）。
 *
 * ⚠️ 直接拿 `now` 按活动时区格式化，**不要**先按「已过天数」推一个近似时刻——
 * 那样在负偏移时区（美洲）会差一天。浏览器端就是这么做的，两边必须一模一样。
 */
function localDateIn(timing: EventTiming, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timing.timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}`;
}

export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  const hours = Math.floor(abs / 3600000);
  const minutes = Math.floor((abs % 3600000) / 60000);
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
  return `${minutes} 分钟`;
}

/** 活动日期的展示文案。 */
export function formatDateRange(timing: EventTiming): string {
  if (!timing.start) return '日期待定';
  const s = timing.start;
  if (!timing.end || timing.end === timing.start) return formatChineseDate(s);
  const sameYear = s.slice(0, 4) === timing.end.slice(0, 4);
  if (sameYear) {
    return `${formatChineseDate(s)} – ${formatChineseDate(timing.end).replace(/^\d{4}年/, '')}`;
  }
  return `${formatChineseDate(s)} – ${formatChineseDate(timing.end)}`;
}

/** `2026-11-05` → `2026年11月5日`。 */
export function formatChineseDate(date: string): string {
  const p = dateParts(date);
  if (!p) return date;
  return `${p.y}年${p.m}月${p.d}日`;
}

/**
 * 活动的开始时刻（活动所在地的墙上时间，`HH:MM`）。
 *
 * ⚠️ 没有议程信息时返回 null —— **别显示「00:00 开始」**：
 *    那是「我们不知道」，不是「凌晨零点开场」。
 *    不知道就不显示时刻，只给日期。
 */
export function formatStartClock(timing: EventTiming): string | null {
  const m = timing.startMinute;
  if (m === null) return null;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
