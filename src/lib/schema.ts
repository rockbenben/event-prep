/**
 * event.md front matter 的字段校验。
 *
 * 原则：**坏数据不许悄悄上线**。字段有错就是 error（构建失败），
 * 拿不准的是 warning（照常发布，但在构建日志里点出来）。
 */

import { isCalendarDate, isValidTimeZone } from './timezone.ts';

export interface EventMeta {
  title: string;
  summary?: string;
  start?: string;
  end?: string;
  timezone?: string;
  city?: string;
  venue?: string;
  venue_url?: string;
  address?: string;
  organizer?: string;
  website?: string;
  agenda_url?: string;
  ticket_url?: string;
  map_url?: string;
  tags: string[];
}

export interface ValidationResult {
  meta: EventMeta;
  errors: string[];
  warnings: string[];
}

/** front matter 里允许出现的字段。 */
export const KNOWN_FIELDS = [
  'title', 'summary', 'start', 'end', 'timezone',
  'city', 'venue', 'venue_url', 'address', 'organizer',
  'website', 'agenda_url', 'ticket_url', 'map_url',
  'tags',
] as const;

const URL_FIELDS = ['website', 'agenda_url', 'ticket_url', 'map_url', 'venue_url'] as const;
const TEXT_FIELDS = ['summary', 'city', 'venue', 'address', 'organizer'] as const;

/** 校验 front matter，返回可用于构建的元数据。 */
export function validateEvent(data: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const key of Object.keys(data)) {
    if (!(KNOWN_FIELDS as readonly string[]).includes(key)) {
      warnings.push(`未知字段「${key}」已忽略`);
    }
  }

  // title：唯一必填
  const rawTitle = data.title;
  let title = '';
  if (rawTitle === undefined || rawTitle === null) {
    errors.push('缺少必填字段 title');
  } else if (typeof rawTitle !== 'string') {
    errors.push('title 必须是字符串');
  } else if (rawTitle.trim() === '') {
    errors.push('title 不能为空');
  } else {
    title = rawTitle.trim();
  }

  const meta: EventMeta = { title, tags: [] };

  for (const key of TEXT_FIELDS) {
    const value = data[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      errors.push(`${key} 必须是字符串`);
      continue;
    }
    if (value.trim() === '') continue;
    meta[key] = value.trim();
  }

  // 日期
  const start = readDate(data.start, 'start', errors);
  const end = readDate(data.end, 'end', errors);
  if (start) meta.start = start;
  if (end) meta.end = end;
  if (start && end && end < start) {
    errors.push(`end（${end}）早于 start（${start}）`);
  }

  // 时区
  if (data.timezone !== undefined && data.timezone !== null) {
    if (typeof data.timezone !== 'string') {
      errors.push('timezone 必须是字符串');
    } else if (data.timezone.trim() === '') {
      warnings.push('timezone 是空的，将按 UTC 计算');
    } else if (!isValidTimeZone(data.timezone.trim())) {
      errors.push(`timezone「${data.timezone}」不是有效的 IANA 时区名（如 Asia/Shanghai）`);
    } else {
      meta.timezone = data.timezone.trim();
    }
  }

  // 链接
  for (const key of URL_FIELDS) {
    const value = data[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      errors.push(`${key} 必须是字符串`);
      continue;
    }
    const trimmed = value.trim();
    if (trimmed === '') continue;
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      errors.push(`${key}「${trimmed}」不是合法的 URL`);
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      errors.push(`${key}「${trimmed}」必须是 http(s) 地址`);
      continue;
    }
    meta[key] = trimmed;
  }

  // 标签
  const rawTags = data.tags;
  if (rawTags !== undefined && rawTags !== null) {
    if (typeof rawTags === 'string') {
      meta.tags = [rawTags.trim()].filter((t) => t !== '');
    } else if (Array.isArray(rawTags)) {
      const tags: string[] = [];
      for (const item of rawTags) {
        if (typeof item === 'string') {
          const t = item.trim();
          if (t !== '') tags.push(t);
          else warnings.push('tags 里有空字符串，已忽略');
        } else {
          warnings.push(`tags 里的 ${JSON.stringify(item)} 不是字符串，已忽略`);
        }
      }
      meta.tags = tags;
    } else {
      errors.push('tags 必须是字符串或字符串数组');
    }
  }

  return { meta, errors, warnings };
}

function readDate(value: unknown, field: string, errors: string[]): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    errors.push(`${field} 必须是 YYYY-MM-DD 字符串`);
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    errors.push(`${field}「${trimmed}」不是 YYYY-MM-DD 格式`);
    return null;
  }
  if (!isCalendarDate(trimmed)) {
    errors.push(`${field}「${trimmed}」不是真实存在的日期`);
    return null;
  }
  return trimmed;
}
