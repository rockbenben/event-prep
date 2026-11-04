/**
 * IANA 时区与「活动所在地自然日」的换算。
 *
 * 站点不把日期当字符串比较，而是先把 `2026-11-05` + `Asia/Shanghai` 解析成一个
 * **瞬间**（UTC 毫秒），再拿它跟访问时刻比。这样「11 月 5 日 09:00 开始」在
 * 上海、在纽约看浏览器看到的都是同一件事。
 *
 * 全部用 Intl 完成，不引第三方时区库。
 */

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(tz, f);
  }
  return f;
}

/** 该字符串是不是 Intl 认识的 IANA 时区名。 */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.trim() !== tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * 某一瞬间在该时区的 UTC 偏移（毫秒）。
 * 用「把瞬间按当地墙上时间格式化成 UTC 再相减」这一步算出来，Intl 不直接给偏移。
 */
export function zoneOffsetMs(instant: Date, tz: string): number {
  const parts = zoneFormatter(tz).formatToParts(instant);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour) % 24,
    Number(map.minute),
    Number(map.second),
  );
  // formatToParts 只到秒，所以先把瞬间也截到秒，否则偏移会差几百毫秒
  const truncated = Math.floor(instant.getTime() / 1000) * 1000;
  return asUTC - truncated;
}

/** `YYYY-MM-DD` 的三段数字。格式不对时返回 null。 */
export interface DateParts {
  y: number;
  m: number;
  d: number;
}

export function dateParts(date: string): DateParts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** 把「某时区的某个自然日 00:00」换算成 UTC 瞬间。
 *
 * 做法是先假设偏移为 0 得到一个候选瞬间，再用该瞬间处的真实偏移修正一次。
 * 迭代两轮足够处理夏令时切换（偏移在一天内变了两次的情况靠第二轮收敛）。
 */
export function zonedDayStart(date: string, tz: string): Date {
  const parts = dateParts(date);
  if (!parts) throw new Error(`不是合法的日期：${date}`);
  const wall = Date.UTC(parts.y, parts.m - 1, parts.d, 0, 0, 0, 0);
  let guess = wall;
  for (let i = 0; i < 3; i += 1) {
    const next = wall - zoneOffsetMs(new Date(guess), tz);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

/** 在日历上给 `YYYY-MM-DD` 加减天数（只动日期，不动时区）。 */
export function addDays(date: string, days: number): string {
  const parts = dateParts(date);
  if (!parts) throw new Error(`不是合法的日期：${date}`);
  const t = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/** `2026-11-05` 是不是一个真实存在的日历日（挡掉 2026-02-30 这种）。 */
export function isCalendarDate(date: string): boolean {
  const parts = dateParts(date);
  if (!parts) return false;
  if (parts.m < 1 || parts.m > 12 || parts.d < 1 || parts.d > 31) return false;
  const t = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  return (
    t.getUTCFullYear() === parts.y &&
    t.getUTCMonth() === parts.m - 1 &&
    t.getUTCDate() === parts.d
  );
}
