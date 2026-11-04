/**
 * 日程章节的解析与校验。
 *
 * 作者写法：一天一个 `###`，一场一个 `#### 时间 · 标题`，紧跟的列表项是这一场的字段。
 * 这里只把文字读成结构化场次，不生成 HTML、不读文件——渲染见 templates/agenda.ts，
 * 「头像文件在不在」由调用方注入的 assetExists 决定（保持本模块可纯函数测试）。
 */

import { hashText } from './html.ts';

export type AgendaFormat =
  | '演讲' | '圆桌' | '快闪' | '开场' | '闭幕' | '茶歇' | '边会' | '行程';

export const AGENDA_FORMATS: readonly AgendaFormat[] = [
  '演讲', '圆桌', '快闪', '开场', '闭幕', '茶歇', '边会', '行程',
];

const SECTION_HEADING = /^#{2}[ \t]+(日程|议程|agenda|schedule)[ \t]*$/im;
const FIELD_KEYS = [
  '形式', '会场', '讲者', '时长', '状态', '看点', '摘要', '备注', '出处',
] as const;

export interface SessionSpeaker {
  name: string;
  org?: string;
  avatar?: string;
  note?: string;
  /** 完整介绍（讲者行的第 5 段）：渲染成姓名后面的 tip 图标。 */
  bio?: string;
}

export interface Session {
  start: number;
  end: number | null;
  timeText: string;
  title: string;
  /**
   * 稳定标识：时间 + 标题的哈希。
   *
   * 读者自己写的笔记按它存——所以标题或时间改了，笔记就挂不上去了
   * （宁可挂不上，也不要挂到另一场去）。
   */
  key: string;
  format: AgendaFormat;
  venue: string;
  speakers: SessionSpeaker[];
  duration?: string;
  status?: string;
  highlight?: string;
  abstract?: string;
  /** 看这一场之前要知道的事（术语、注意事项）：渲染成卡片上的 tip 图标。 */
  remarks: string[];
  source?: string;
  line: number;
}

export interface AgendaSlot { start: number; timeText: string; sessions: Session[] }
export interface AgendaDay { title: string; slots: AgendaSlot[] }

export interface AgendaParseResult {
  days: AgendaDay[];
  errors: string[];
  warnings: string[];
}

export interface AgendaOptions {
  /** 判断 `assets/...` 这种站内相对路径指向的文件在不在。不给就不查。 */
  assetExists?: (rel: string) => boolean;
}

export interface LocatedSection { text: string; start: number; end: number }

/**
 * 找到日程章节。
 * start 落在 `## 日程` 那一行**之后**——标题留给 Markdown，目录才收得到它。
 */
export function locateAgendaSection(body: string): LocatedSection | null {
  const match = SECTION_HEADING.exec(body);
  if (!match || match.index === undefined) return null;
  const lineEnd = body.indexOf('\n', match.index);
  if (lineEnd === -1) return { text: '', start: body.length, end: body.length };
  const start = lineEnd + 1;
  const rest = body.slice(start);
  const next = /^#{1,2}[ \t]/m.exec(rest);
  const end = start + (next ? next.index : rest.length);
  return { text: body.slice(start, end), start, end };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

function isTime(value: string): boolean {
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(value);
}

/**
 * 把 HTML 注释整段抹掉（保留换行）。
 *
 * ⚠️ 行号要留着：报错说「第 N 行」时得对得上原文。
 *    骨架模板与作者都爱在章节里写注释说明，不抹掉的话整段会被当成「有内容却没场次」。
 */
function stripComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, (block) => block.replace(/[^\n]/g, ' '));
}

const SESSION_HEADING = /^####[ \t]+(.+?)[ \t]*$/;
const DAY_HEADING = /^###[ \t]+(.+?)[ \t]*$/;
const FIELD_LINE = /^[ \t]*[-*][ \t]+([^:：]+)[ \t]*[:：][ \t]*(.*)$/;
const TIME_RANGE = /^(?:(\d{1,2}:\d{2})[ \t]*[–—-][ \t]*(\d{1,2}:\d{2})|(\d{1,2}:\d{2}))[ \t]*·[ \t]*(.+)$/;

interface RawSession {
  heading: string;
  line: number;
  fields: Map<string, string[]>;
}

function splitSpeaker(value: string): SessionSpeaker {
  const parts = value.split('|').map((p) => p.trim());
  const [name, org, avatar, note, bio] = parts as [string, string?, string?, string?, string?];
  return {
    name: name ?? '',
    ...(org ? { org } : {}),
    ...(avatar ? { avatar } : {}),
    ...(note ? { note } : {}),
    ...(bio ? { bio } : {}),
  };
}

/** 把 `#### 09:45–10:10 · 标题` 拆成时间与标题；拆不动返回 null（报错误用）。 */
function readHeading(raw: string): { start: number; end: number | null; timeText: string; title: string } | null {
  const m = TIME_RANGE.exec(raw);
  if (!m) return null;
  const [, startText, endText, single, title] = m;
  const begin = startText ?? single ?? '';
  const finish = endText ?? null;
  if (!isTime(begin) || (finish !== null && !isTime(finish))) return null;
  const beginMin = toMinutes(begin);
  const endMin = finish === null ? null : toMinutes(finish);
  if (endMin !== null && endMin < beginMin) return null;
  return {
    start: beginMin,
    end: endMin,
    timeText: finish === null ? begin : `${begin}–${finish}`,
    title: (title ?? '').trim(),
  };
}

export function parseAgenda(section: string, options: AgendaOptions = {}): AgendaParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const days: AgendaDay[] = [];

  let currentDay: AgendaDay | null = null;
  let current: RawSession | null = null;
  let lastKey: string | null = null;
  let sawSessionHeading = false;

  const ensureDay = (): AgendaDay => {
    if (!currentDay) {
      currentDay = { title: '日程', slots: [] };
      days.push(currentDay);
    }
    return currentDay;
  };

  const pushSession = (): void => {
    if (!current) return;
    const day = ensureDay();
    const built = buildSession(current, errors, options);
    if (built) day.slots.push({ start: built.start, timeText: built.timeText, sessions: [built] });
    current = null;
    lastKey = null;
  };

  const lines = stripComments(section).split(/\r?\n/);
  lines.forEach((line, index) => {
    const at = index + 1;

    const dayMatch = DAY_HEADING.exec(line);
    if (dayMatch?.[1] !== undefined && !SESSION_HEADING.test(line)) {
      pushSession();
      currentDay = { title: dayMatch[1].trim(), slots: [] };
      days.push(currentDay);
      return;
    }

    if (SESSION_HEADING.test(line)) {
      sawSessionHeading = true;
      pushSession();
      const heading = (SESSION_HEADING.exec(line)?.[1] ?? '').trim();
      current = { heading, line: at, fields: new Map() };
      lastKey = null;
      return;
    }

    if (/^<details/i.test(line)) {
      warnings.push(`第 ${at} 行：议程章节里不支持 <details>，这一块的内容会被忽略。`);
      return;
    }

    if (!current) {
      // 字段行写在小节外面是最容易犯的错（漏了 ####）。
      // 不静默丢——提醒作者那一行没落到任何一场里。
      const orphan = FIELD_LINE.exec(line);
      if (orphan?.[1] !== undefined) {
        warnings.push(`第 ${at} 行：字段「${orphan[1].trim()}」写在任何 \`####\` 小节之外，已忽略。`);
      }
      return;
    }

    const field = FIELD_LINE.exec(line);
    if (field?.[1] !== undefined && field[2] !== undefined) {
      const key = field[1].trim();
      if (!(FIELD_KEYS as readonly string[]).includes(key)) {
        errors.push(`第 ${at} 行：未知字段「${key}」。日程里可用的字段：${FIELD_KEYS.join('、')}。`);
        lastKey = null;
        return;
      }
      const list = current.fields.get(key) ?? [];
      list.push(field[2].trim());
      current.fields.set(key, list);
      lastKey = key;
      return;
    }

    // 缩进的续行并进上一个字段值（长摘要是散文，一行写不下）
    const value = line.trim();
    if (lastKey !== null && value !== '' && /^[ \t]/.test(line) && !/^[-*] /.test(value)) {
      const list = current.fields.get(lastKey);
      if (list?.at(-1) !== undefined) {
        list[list.length - 1] = `${list[list.length - 1]} ${value}`;
      }
    }
  });
  pushSession();

  // ⚠️ 章节里有内容，却一个 `####` 场次都没找到 → 报错。
  //    这是最隐蔽的一种坏数据：作者还在用旧的表格写法（或章节名写错了），
  //    而这一整段会被卡片渲染器替换掉 —— 照旧渲染就是「一整节日程静默消失」。
  //    拦住它，坏数据就不会悄悄上线。
  if (!sawSessionHeading && stripComments(section).trim() !== '') {
    errors.push(
      '日程章节里没有找到任何 `####` 场次。每一场要写成 `#### 时间 · 标题`，下面跟 `- 形式:`、`- 会场:` 等字段；' +
        '这一段会被整个替换掉，不能让它悄悄空掉。',
    );
  }

  return { days: groupSlots(days, warnings), errors, warnings };
}

function buildSession(
  raw: RawSession,
  errors: string[],
  options: AgendaOptions,
): Session | null {
  const head = readHeading(raw.heading);
  if (!head) {
    errors.push(
      `第 ${raw.line} 行：小节标题要写成 \`#### 09:45–10:10 · 主题\`（时间是 HH:MM，结束不早于开始）。收到：${raw.heading}`,
    );
    return null;
  }
  if (head.title === '') {
    errors.push(`第 ${raw.line} 行：这一场缺标题。`);
    return null;
  }

  const one = (key: string): string | undefined => raw.fields.get(key)?.[0];
  const many = (key: string): string[] => raw.fields.get(key) ?? [];

  const format = one('形式');
  if (format === undefined) {
    errors.push(`第 ${raw.line} 行「${head.title}」缺必填字段：形式、会场。`);
    return null;
  }
  if (!(AGENDA_FORMATS as readonly string[]).includes(format)) {
    errors.push(
      `第 ${raw.line} 行「${head.title}」的形式「${format}」不在可用值里：${AGENDA_FORMATS.join(' / ')}`,
    );
    return null;
  }
  // includes() 不产生类型谓词，闭集校验过了这里才敢当 AgendaFormat 用
  const agendaFormat = format as AgendaFormat;
  const venue = one('会场');
  if (venue === undefined || venue === '') {
    errors.push(`第 ${raw.line} 行「${head.title}」缺必填字段：会场。`);
    return null;
  }

  const speakers = many('讲者').map(splitSpeaker);
  for (const speaker of speakers) {
    if (speaker.name === '') errors.push(`第 ${raw.line} 行「${head.title}」有一条空的讲者行。`);
    if (speaker.avatar === undefined) continue;
    if (!speaker.avatar.startsWith('assets/')) {
      errors.push(
        `第 ${raw.line} 行「${head.title}」的头像「${speaker.avatar}」要写成 assets/ 下的站内相对路径（热链官方图片会随对方改名失效）。`,
      );
      continue;
    }
    if (options.assetExists && !options.assetExists(speaker.avatar)) {
      errors.push(
        `第 ${raw.line} 行「${head.title}」的头像文件不存在：${speaker.avatar}（发出去就是一条 404）。`,
      );
    }
  }

  return {
    start: head.start,
    end: head.end,
    timeText: head.timeText,
    title: head.title,
    key: hashText(`${head.timeText}|${head.title}`),
    format: agendaFormat,
    venue,
    speakers,
    ...(one('时长') !== undefined ? { duration: one('时长') } : {}),
    ...(one('状态') !== undefined ? { status: one('状态') } : {}),
    ...(one('看点') !== undefined ? { highlight: one('看点') } : {}),
    ...(one('摘要') !== undefined ? { abstract: one('摘要') } : {}),
    remarks: many('备注'),
    ...(one('出处') !== undefined ? { source: one('出处') } : {}),
    line: raw.line,
  };
}

/** 同一天里开始时间相同的场次并成一个时段组；组内会场名升序，茶歇排最后。 */
function groupSlots(days: AgendaDay[], warnings: string[]): AgendaDay[] {
  for (const day of days) {
    const byStart = new Map<number, AgendaSlot>();
    for (const slot of day.slots) {
      for (const session of slot.sessions) {
        const target = byStart.get(session.start);
        if (target) target.sessions.push(session);
        else byStart.set(session.start, { start: session.start, timeText: session.timeText, sessions: [session] });
      }
    }
    for (const slot of byStart.values()) {
      slot.sessions.sort((a, b) => {
        const aBreak = a.format === '茶歇' ? 1 : 0;
        const bBreak = b.format === '茶歇' ? 1 : 0;
        if (aBreak !== bBreak) return aBreak - bBreak;
        // ⚠️ zh-CN 的排序规则是**汉字在前、拉丁字母在后**（CLDR 的 zh 排序），
        //    所以「主会场」排在「AI应用分会场」前面——主会场本来就是主轨，读者也这么预期。
        //    别按「拼音 A 在 Z 前」去推演，那会得出相反的顺序。
        return a.venue.localeCompare(b.venue, 'zh-CN');
      });
      const seen = new Set<string>();
      for (const session of slot.sessions) {
        const key = `${session.start}|${session.venue}`;
        if (seen.has(key)) {
          warnings.push(`时段 ${session.timeText} 的会场「${session.venue}」排了两场：${session.title}`);
        }
        seen.add(key);
      }
    }
    day.slots = [...byStart.values()].sort((a, b) => a.start - b.start);
  }
  return days;
}
