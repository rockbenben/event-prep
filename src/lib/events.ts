/**
 * 活动内容的发现与加载。
 *
 * 内容来源做成可替换的 provider：
 *   · `DirectoryProvider` —— `content/<slug>/event.md`（默认，见 README）
 *   · 将来要支持「每个活动一个分支」，只需再加一个 provider，不用动构建管线。
 */

import { readdir, readFile, stat, lstat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { inventory } from './output.ts';
import { parseFrontMatter } from './frontmatter.ts';
import { validateEvent, type EventMeta } from './schema.ts';
import { addDays } from './timezone.ts';
import { resolveTiming, type EventTiming } from './status.ts';
import {
  dayEndMinutes as endMinutesOf,
  dayStartMinutes as startMinutesOf,
  locateAgendaSections,
  parseAgenda,
} from './agenda.ts';

export const EVENT_FILE = 'event.md';
export const ASSETS_DIR = 'assets';

export interface EventMaterials {
  summary?: string;
  /** 原始字节用于下载，渲染时另行解码，避免更改 BOM/换行。 */
  raw: { file: string; bytes: Buffer }[];
}

/**
 * 活动页旁边那份可编辑 Markdown 副本的文件名。
 *
 * ⚠️ 它跟源文件**同名同格式**——故意的：导出的东西要能直接塞回
 *    `content/<slug>/event.md`，页面就更新了。名字不一样的话，
 *    「下载下来改一改放回去」这件事就断了。
 */
export const EXPORT_FILE = 'event.md';

export interface LoadedEvent {
  materials?: EventMaterials;
  agenda?: Map<string, ReturnType<typeof parseAgenda>>;
  /** URL 里的路径片段，同时也是内容目录名。 */
  slug: string;
  /** 内容来源的人类可读说明（本地路径 / 分支名），报错时用。 */
  origin: string;
  meta: EventMeta;
  /** front matter 之后的 Markdown 正文。 */
  body: string;
  /**
   * 源文件全文（front matter + 正文），行尾统一成 LF。
   *
   * 导出 Markdown 用它：导出物必须**原样**是作者写的那份，
   * 重新塞回 content/ 才还原得回去。渲染出来的东西倒过来写不是一回事。
   */
  source: string;
  timing: EventTiming;
  /** 活动自带的资源目录（可选），构建时原样带到活动页下。 */
  assetsDir?: string;
  errors: string[];
  warnings: string[];
}

export interface EventProvider {
  /** 列出所有候选活动。实现自己负责判断哪些算活动分支。 */
  discover(): Promise<DiscoveredEvent[]>;
}

export interface DiscoveredEvent {
  readMaterials?(): Promise<EventMaterials>;
  slug: string;
  origin: string;
  /** 读取 event.md 原文。 */
  read(): Promise<string>;
  /** 该活动的附属资源目录（可选）。 */
  assetsDir?: string;
}

/** 目录名必须是 slug：只允许小写字母、数字、连字符。 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

/** 从 `content/` 目录读活动。 */
export class DirectoryProvider implements EventProvider {
  private readonly contentDir: string;

  constructor(contentDir: string) {
    this.contentDir = contentDir;
  }

  async discover(): Promise<DiscoveredEvent[]> {
    let entries: string[];
    try {
      entries = await readdir(this.contentDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return [];
    }

    const found: DiscoveredEvent[] = [];
    for (const entry of entries.sort()) {
      const dir = path.join(this.contentDir, entry);
      const info = await lstat(dir);
      if (info.isSymbolicLink()) throw new Error(`拒绝活动目录链接：${dir}`);
      if (!info || !info.isDirectory()) continue;

      const file = path.join(dir, EVENT_FILE);
      const fileInfo = await optionalStat(file);
      if (!fileInfo || !fileInfo.isFile()) continue;

      const assetsDir = path.join(dir, ASSETS_DIR);
      const assetsInfo = await optionalStat(assetsDir);

      found.push({
        slug: entry,
        origin: path.relative(process.cwd(), file) || file,
        read: async () => {
          if ((await lstat(file)).isSymbolicLink()) throw new Error(`拒绝内容文件链接：${file}`);
          if (assetsInfo) {
            if ((await lstat(assetsDir)).isSymbolicLink()) throw new Error(`拒绝资源目录链接：${assetsDir}`);
            const names = await inventory(assetsDir);
            const allowed = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.woff2']);
            for (const name of names.filter(name => !name.endsWith('/'))) {
              if (!allowed.has(path.extname(name).toLowerCase())) throw new Error(`不支持的活动资源：${name}`);
              const relative = path.relative(await realpath(dir), await realpath(path.join(assetsDir, name)));
              if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`资源越界：${name}`);
            }
          }
          return readFile(file, 'utf8');
        },
        readMaterials: async () => {
          const names = await readdir(dir);
          for (const name of names.filter(name => name === 'summary.md' || /^\d{8}-raw\.md$/.test(name))) {
            if ((await lstat(path.join(dir, name))).isSymbolicLink()) throw new Error(`拒绝资料文件链接：${name}`);
          }
          const summary = names.includes('summary.md') ? await readFile(path.join(dir, 'summary.md'), 'utf8') : undefined;
          const raw = await Promise.all(names.filter((name) => /^\d{8}-raw\.md$/.test(name)).sort().map(async (name) => ({
            file: name, bytes: await readFile(path.join(dir, name)),
          })));
          return { summary, raw };
        },
        assetsDir: assetsInfo?.isDirectory() ? assetsDir : undefined,
      });
    }
    return found;
  }
}

/**
 * 载入并校验全部活动。
 * 单个活动的错误**不**中断整体流程：坏活动照样被读出来、错误被收集起来，
 * 由调用方决定是让构建失败还是把它排除掉。
 */
export async function loadEvents(provider: EventProvider): Promise<LoadedEvent[]> {
  const discovered = await provider.discover();
  const events: LoadedEvent[] = [];
  const seen = new Map<string, string>();

  for (const item of discovered) {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!isValidSlug(item.slug)) {
      errors.push(
        `目录名「${item.slug}」不是合法 slug：只允许小写字母、数字和连字符（如 2026-11-ai-engineer）`,
      );
    }
    const previous = seen.get(item.slug);
    if (previous) {
      errors.push(`slug「${item.slug}」重复（另一个来源：${previous}）`);
    } else {
      seen.set(item.slug, item.origin);
    }

    let raw = '';
    try {
      raw = await item.read();
    } catch (err) {
      errors.push(`读取失败：${(err as Error).message}`);
    }

    const parsed = parseFrontMatter(raw);
    if (parsed.error) errors.push(parsed.error);

    const validated = validateEvent(parsed.data);
    errors.push(...validated.errors);
    warnings.push(...validated.warnings);

    // 日程章节的校验放在加载阶段：坏数据要进 errors，
    // 由既有的严格模式拦住（构建失败、不动上一次产物），而不是等渲染时才炸。
    const sections = locateAgendaSections(parsed.body);
    const agenda = new Map<string, ReturnType<typeof parseAgenda>>();
    let dayStartMinutes: (number | null)[] = [];
    let dayEndMinutes: (number | null)[] = [];
    let parsedAgenda: ReturnType<typeof parseAgenda> | undefined;
    for (const section of sections) {
      const result = parseAgenda(section.text, {
        assetExists: (rel) =>
          item.assetsDir !== undefined && existsSync(path.join(item.assetsDir, rel.slice('assets/'.length))),
      });
      agenda.set(section.text.trim(), result);
      errors.push(...result.errors);
      warnings.push(...result.warnings);
      parsedAgenda = { days: [...(parsedAgenda?.days ?? []), ...result.days], errors: [], warnings: [] };
      // ⚠️ 议程里的时刻就是活动的真实起止时刻：frontmatter 只有日期，
      //    锚在 00:00 的话倒计时指向当天午夜，读者看到的「还有 4 小时」
      //    跟「明早 8 点半签到」毫无关系。
      dayStartMinutes = startMinutesOf(parsedAgenda.days);
      dayEndMinutes = endMinutesOf(parsedAgenda.days);
    }

    if (parsedAgenda && parsedAgenda.days.some(day => day.date !== null)) {
      const dates = parsedAgenda.days.map(day => day.date);
      const count = validated.meta.start ? resolveTiming(validated.meta).days ?? 0 : 0;
      const starts = dayStartMinutes;
      const ends = dayEndMinutes;
      dayStartMinutes = [];
      dayEndMinutes = [];
      for (let i = 0; i < count; i++) {
        const date = addDays(validated.meta.start!, i);
        const indices = dates.flatMap((value, index) => value === date ? [index] : []);
        const dayStarts = indices.map(index => starts[index]).filter((value): value is number => value != null);
        const dayEnds = indices.map(index => ends[index]).filter((value): value is number => value != null);
        dayStartMinutes.push(dayStarts.length ? Math.min(...dayStarts) : null);
        dayEndMinutes.push(dayEnds.length ? Math.max(...dayEnds) : null);
      }
      if (dayEndMinutes.some(value => value === null)) dayEndMinutes = [];
    }
    const timing = resolveTiming({ ...validated.meta, dayStartMinutes, dayEndMinutes });

    let materials: EventMaterials | undefined;
    try {
      materials = await item.readMaterials?.();
    } catch (err) {
      errors.push(`读取会后资料失败：${(err as Error).message}`);
    }

    events.push({
      slug: item.slug,
      origin: item.origin,
      meta: validated.meta,
      body: parsed.body,
      source: normalizeSource(raw),
      materials,
      agenda,
      timing,
      assetsDir: item.assetsDir,
      errors,
      warnings,
    });
  }

  return events;
}

/**
 * 源文件归一化：去 BOM、换行统一成 LF。
 *
 * 导出出去的 Markdown 必须是 LF：仓库是 LF，Windows 上编辑完再存回去
 * 也不会因为换行符不同而在 git 里炸一整行。
 */
function normalizeSource(raw: string): string {
  return raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

async function optionalStat(file: string) {
  try { return await stat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
