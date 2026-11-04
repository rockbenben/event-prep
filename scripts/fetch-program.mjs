/**
 * 官方议程 → .work/program.json（素材，不发布）。
 *
 * 只搬一手字段：时间、原题、讲者、机构、时长、官方状态标注、英文 Abstract、讲者页链接。
 * 中文摘要不在这里产出——那是 Task 7 里逐场写的内容（官方中文优先，取不到才转述）。
 *
 * 用法：node scripts/fetch-program.mjs [议程页 URL]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = process.argv[2] ?? 'https://ai.engineer/shanghai/2026/program';

const html = await (await fetch(SOURCE, { headers: { 'user-agent': 'Mozilla/5.0 (event-prep research)' } })).text();
const origin = new URL(SOURCE).origin;

/**
 * 页面结构：`<section id="day-…">` 是天，里面还有 `<section class="sh-program-lane">` 是轨道
 * （主会场 / AI 应用分会场）。会场来自轨道的 aria-label，不是从正文里猜的。
 *
 * ⚠️ 不能用「天 section 到第一个 `</section>`」去切：天里还嵌着轨道 section，
 *    非贪婪匹配会在轨道处截断（实测只抽到 26 行，实际 75 行）。
 *    改成按「下一个天 / 下一个轨道 / 下一个 session」三个标记切。
 */
const dayStarts = [...html.matchAll(/<section id="(day-[^"]+)"/g)];
const LANE = /<section class="sh-program-lane([^>]*)>/g;
/**
 * 两种行都要收：
 *   · 场次行  `<li id="session-…" class="sh-schedule-row sh-schedule-session …" data-slot-kind="talk">`
 *   · 服务行  `<li class="sh-schedule-row sh-schedule-service sh-schedule-break " data-slot-kind="break">`
 *     （休息、午餐、开场、闭幕没有 id，标题也是裸 `<h3>`）
 */
const ROW = /<li ([^>]*\bclass="sh-schedule-row[^"]*"[^>]*)>/g;

const sessions = [];
for (let d = 0; d < dayStarts.length; d += 1) {
  const dayId = dayStarts[d][1];
  const dayStart = dayStarts[d].index;
  const dayEnd = d + 1 < dayStarts.length ? dayStarts[d + 1].index : html.length;
  const dayBlock = html.slice(dayStart, dayEnd);
  const dayTitle = /<h2 id="[^"]*"[^>]*>([^<]*)<\/h2>/.exec(dayBlock)?.[1] ?? '';

  // 轨道与行在文档里是交错的：按出现顺序扫，记住当前所在的轨道
  const marks = [
    ...[...dayBlock.matchAll(LANE)].map((m) => ({ kind: 'lane', index: m.index, full: m[0], text: m[1] })),
    ...[...dayBlock.matchAll(ROW)].map((m) => ({ kind: 'row', index: m.index, full: m[0], text: m[1] })),
  ].sort((a, b) => a.index - b.index);

  let lane = { stage: null, label: '' };
  for (let i = 0; i < marks.length; i += 1) {
    if (marks[i].kind === 'lane') {
      const attrs = marks[i].text;
      lane = {
        stage: /data-stage="([^"]*)"/.exec(attrs)?.[1] ?? null,
        label: /aria-label="([^"]*)"/.exec(attrs)?.[1] ?? '',
      };
      continue;
    }
    const attrs = marks[i].text;
    // 行内容从 `<li …>` 整个标签之后开始（用完整标签长度，别拿属性长度去凑）
    const from = marks[i].index + marks[i].full.length;
    const to = i + 1 < marks.length ? marks[i + 1].index : dayBlock.length;
    const chunk = dayBlock.slice(from, to);

    const slug = /id="session-([^"]*)"/.exec(attrs)?.[1] ?? '';
    const slotKind = /data-slot-kind="([^"]*)"/.exec(attrs)?.[1] ?? null;
    const format = /data-format="([^"]*)"/.exec(attrs)?.[1] ?? null;
    const times = [...chunk.matchAll(/<(?:time|span)>(\d{1,2}:\d{2})<\/(?:time|span)>/g)].map((m) => m[1]);
    const title = /<h3>(?:<a href="[^"]*">)?([^<]+)(?:<\/a>)?<\/h3>/.exec(chunk)?.[1] ?? '';
    const status = /<p class="sh-schedule-status">([^<]*)<\/p>/.exec(chunk)?.[1] ?? null;
    const abstract = /<details class="sh-schedule-abstract">[\s\S]*?<p>([\s\S]*?)<\/p>/.exec(chunk)?.[1] ?? null;
    const avatars = [...chunk.matchAll(/<img src="(\/shanghai\/speakers\/[^"]+)"/g)].map((m) => m[1]);
    const byline = /<p class="sh-schedule-byline">([\s\S]*?)<\/p>/.exec(chunk)?.[1] ?? '';

    // 讲者：名字在 byline 的 <a> 里，机构在紧跟其后的 <span> 里；
    // 那个 span 里还混着时长（「25 min」），别把它当机构。
    // ⚠️ 多讲者的那一行是**一个** <a> 里用 ` & ` 连着两个名字（David Li & Alex Triplett），
    //    而且不一定带 lang="en"——所以名字按 ` & ` 拆，个数对齐头像。
    const anchors = [...byline.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)];
    const names = anchors.length > 0
      ? anchors.flatMap((m) => clean(m[2]).split(/\s*&\s*/)).filter((n) => n !== '')
      : [];
    const spans = [...byline.matchAll(/<span>([^<]*)<\/span>/g)].map((s) => clean(s[1]));
    const orgs = spans.filter((s) => s !== '' && !/^\d+\s*min$/i.test(s));
    const durationMin = /<span>(\d+)<!-- --> min<\/span>/.exec(byline)?.[1] ?? null;

    const speakers = names.map((name, i) => ({
      name,
      // 机构可能只有一个（多讲者共用），有一家分一家
      org: orgs.length === names.length ? (orgs[i] ?? '') : (orgs[0] ?? ''),
      url: origin + (anchors[0]?.[1] ?? ''),
      avatar: avatars[i] ? avatarName(avatars[i]) : null,
    }));

    sessions.push({
      day: dayId,
      dayTitle: clean(dayTitle),
      stage: lane.stage,
      lane: lane.label,
      slug,
      slotKind,
      format,
      start: times[0] ?? null,
      end: times[1] ?? null,
      titleEn: clean(title),
      speakers,
      durationMin,
      statusEn: status ? clean(status) : null,
      abstractEn: abstract ? clean(abstract).replace(/\s+/g, ' ') : null,
      speakerUrl: speakers[0]?.url ?? null,
    });
  }
}

function avatarName(ref) {
  return path.basename(ref.split('?')[0]).replace(/\.(jpg|jpeg|png|webp)$/i, '');
}

function clean(value) {
  if (value === null || value === undefined) return '';
  return decodeEntities(
    value
      .replace(/<!-- -->/g, '')
      .replace(/<[^>]+>/g, '')
      .trim(),
  );
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

const outDir = path.join(ROOT, '.work');
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'program.json'), JSON.stringify(sessions, null, 2), 'utf8');

const withAbstract = sessions.filter((s) => s.abstractEn).length;
const withSpeaker = sessions.filter((s) => s.speakers.length > 0).length;
console.log(`场次 ${sessions.length}（有讲者 ${withSpeaker}，有英文摘要 ${withAbstract}）→ .work/program.json`);
for (const day of dayStarts) {
  const rows = sessions.filter((s) => s.day === day[1]);
  const lanes = [...new Set(rows.map((s) => `${s.stage ?? '—'} / ${s.lane}`))];
  console.log(`  ${day[1]} ${rows[0]?.dayTitle ?? ''} —— ${rows.length} 行，轨道：${lanes.join(' / ')}`);
}
