/**
 * 日程卡片渲染：AgendaDay[] → HTML。
 *
 * 只用消毒白名单里已有的标签（section / ol / ul / li / p / span / details / summary /
 * h4 / img / a / button），新出现的样式钩子一律走 class——白名单要同批放行，否则这里写上去
 * 会被最后一道消毒剥掉。不扩标签是刻意的：标签决定无障碍语义，class 只决定长相。
 *
 * ⚠️ 这里**不引入** lib/markdown.ts：内联 Markdown 的渲染由调用方注入
 *    （markdown.ts → 本文件 → markdown.ts 是循环依赖）。调用方传进来的
 *    renderInline 已经过了内层消毒，外层还会再过一次——两道白名单是同一份。
 */

import { escapeHtml } from '../lib/html.ts';
import { LINK_TABINDEX } from './layout.ts';
import type { AgendaDay, AgendaSlot, Session, SessionSpeaker } from '../lib/agenda.ts';

/** 字段值里的内联 Markdown 渲染器（由 markdown.ts 注入）。 */
export type InlineRenderer = (value: string) => string;

/**
 * 摘要多长就直接摊开、不用点。
 *
 * 短摘要点开才看等于多一次点击；长摘要摊开会把卡片撑成一堵墙。
 * 200 字是个粗略的分界：手机上一屏能读完。
 */
const AUTO_ABSTRACT_MAX = 200;

/**
 * 一个小圆按钮 + 一个字：讲者简介用 i，场次备注用 !。
 *
 * ⚠️ 用文字而不是图标字体/emoji：emoji 在不同系统上字形差别太大，
 *    图标字体又要引依赖。两个字形稳定的字符最省事。
 *
 * ⚠️ 结构是「按钮 + 正文」两兄弟：正文放在 details 里的话，details 成了 flex 子项，
 *    正文会被挤成一条竖排的窄条；放在外面又得靠相邻兄弟选择器才能把它和自己的
 *    按钮绑在一起（靠祖先的 :has() 会「点一个开一片」）。
 */
function tipButton(kind: 'bio' | 'remark', label: string, body: string): string {
  const glyph = kind === 'bio' ? 'i' : '!';
  return `<div class="agenda-tip agenda-tip-${kind}"><details class="agenda-tip-toggle"><summary class="agenda-tip-btn" aria-label="${escapeHtml(
    label,
  )}" title="${escapeHtml(label)}"><span aria-hidden="true">${glyph}</span></summary></details><div class="agenda-tip-body">${body}</div></div>`;
}

/** 提示的正文：一段或多段（多段用 <p> 分开）。 */
function tipBody(paragraphs: string[]): string {
  return paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join('');
}

/**
 * 讲者行：头像 + 姓名 + 机构 + 就地注记；完整介绍挂在姓名后的图标上。
 *
 * ⚠️ 这一行用 `<div>` 不用 `<p>`：`<details>` 是流内容，放在 `<p>` 里
 *    解析器会把 `<p>` 提前闭合，图标就被踢到名字那一行外面去了。
 */
function speakerLine(speaker: SessionSpeaker, tip: string | null): string {
  const avatar =
    speaker.avatar === undefined
      ? ''
      : `<button type="button" class="agenda-avatar-btn" data-avatar="${escapeHtml(speaker.avatar)}" data-avatar-alt="${escapeHtml(
          speaker.name,
        )}" aria-label="放大 ${escapeHtml(speaker.name)} 的照片"><img class="agenda-avatar" src="${escapeHtml(
          speaker.avatar,
        )}" alt="${escapeHtml(speaker.name)}" width="56" height="56" loading="lazy"></button>`;
  const org = speaker.org === undefined ? '' : `<span class="speaker-org">${escapeHtml(speaker.org)}</span>`;
  const note = speaker.note === undefined ? '' : `<span class="note">${escapeHtml(speaker.note)}</span>`;
  const tipHtml =
    tip === null ? '' : tipButton('bio', `${speaker.name} 的简介`, tipBody([tip]));
  return `      <li class="agenda-speaker">${avatar}<div class="agenda-speaker-main"><div class="agenda-speaker-line"><span class="speaker-name">${escapeHtml(
    speaker.name,
  )}</span>${tipHtml}${org}${note}</div></div></li>\n`;
}

/**
 * 读者自己给这一场写的笔记。
 *
 * ⚠️ 这是**读者**的数据，不是作者的 `- 备注:`（那份是「看这一场之前要知道的事」）。
 *    两者都出现在卡片上，但一个来自内容、一个来自本机浏览器——别混。
 *    所以入口叫「记一笔」而不是「备注」。
 *
 * 编辑器默认收起（CSS 控制），点一下才展开；内容由 site.js 从 localStorage 填。
 */
function noteBlock(session: Session): string {
  return `<div class="agenda-note">
      <button type="button" class="agenda-note-btn" data-note-key="${escapeHtml(
        session.key,
      )}" aria-label="给这一场写笔记" aria-expanded="false">＋ 记一笔</button>
      <div class="agenda-note-editor">
        <textarea class="agenda-note-input" rows="3" placeholder="给这一场记点什么" aria-label="这一场的笔记"></textarea>
        <p class="agenda-note-hint">存在本机浏览器里，不同步、不会清理。</p>
      </div>
    </div>\n`;
}

function sessionCard(session: Session, renderInline: InlineRenderer, seen: Set<string>, seenBio: Set<string>): string {
  // ⚠️ 过滤掉空的会场：签到不要求会场（它发生在入口，不在任何一个会场里），
  //    不过滤就会渲染出一个空标签。
  const tags = [session.format, session.venue]
    .filter((value) => value !== '')
    .map((value) => `<span class="tag">${escapeHtml(value)}</span>`)
    .join('');
  const status =
    session.status === undefined ? '' : `<span class="note note-warn">${escapeHtml(session.status)}</span>`;
  const duration =
    session.duration === undefined ? '' : `<span class="agenda-duration">${escapeHtml(session.duration)}</span>`;

  // 官方出处：图标链接，放在标题旁边（不跟标签行的小图标挤在一起）
  const source =
    session.source === undefined
      ? ''
      : `<a class="agenda-source" href="${escapeHtml(session.source)}"${LINK_TABINDEX} target="_blank" rel="noopener noreferrer" aria-label="官方页面" title="官方页面"><span aria-hidden="true">↗</span></a>`;

  // 看这一场之前要知道的事：术语、注意事项——整场一个图标，正文里分段
  const remarks = session.remarks.length
    ? tipButton('remark', '看这一场之前要知道的事', tipBody(session.remarks))
    : '';

  // 完整介绍：只在这个人**第一次出现**的地方挂图标；
  // 同一场里简介文字一样的（几个人共用一段），只留第一个
  const speakers = session.speakers.length
    ? `    <ul class="agenda-speakers">\n${session.speakers
        .map((s) => {
          const key = s.name.replace(/（[^）]*）/g, '').trim();
          const firstTime = s.bio !== undefined && !seen.has(key) && !seenBio.has(s.bio);
          if (firstTime) {
            seen.add(key);
            seenBio.add(s.bio as string);
          }
          return speakerLine(s, firstTime ? (s.bio ?? null) : null);
        })
        .join('')}    </ul>\n`
    : '';
  const highlight =
    session.highlight === undefined ? '' : `<p class="agenda-highlight">${renderInline(session.highlight)}</p>\n`;

  // 短摘要直接摊开，长摘要收进点开式条目；不标来源（「非官方中文口径」那句是噪音）
  let abstractBlock = '';
  if (session.abstract !== undefined) {
    abstractBlock =
      session.abstract.length <= AUTO_ABSTRACT_MAX
        ? `    <p class="agenda-abstract-text">${renderInline(session.abstract)}</p>\n`
        : `    <details class="agenda-abstract"><summary>摘要</summary>\n      <p>${renderInline(
            session.abstract,
          )}</p>\n    </details>\n`;
  }

  return `      <li class="agenda-card">
        <div class="agenda-tags">${tags}${status}${duration}${remarks}</div>
        <div class="agenda-title-row"><h4>${renderInline(session.title)}</h4>${source}</div>
${speakers}${highlight}${abstractBlock}${noteBlock(session)}      </li>\n`;
}

/**
 * 服务性时段：茶歇、午休、签到。
 *
 * ⚠️ 它们不是「一场演讲」——没有讲者、没有摘要，摊成一张大卡片
 *    只会把真正要看的场次挤下去。一行小字就够。
 * ⚠️ 但**备注要留着**：签到那一行往往是读者唯一需要展开看的地方
 *    （带什么证件、去哪签到），所以照样挂提示图标。
 */
function serviceRow(session: Session, renderInline: InlineRenderer): string {
  const remarks = session.remarks.length
    ? tipButton('remark', '看这一场之前要知道的事', tipBody(session.remarks))
    : '';
  return `      <li class="agenda-break"><span class="agenda-time">${escapeHtml(session.timeText)}</span> ${renderInline(
    session.title,
  )}${remarks}</li>\n`;
}

/** 这些形式走「服务行」而不是大卡片。 */
const SERVICE_FORMATS: readonly string[] = ['茶歇', '签到'];

function slotBlock(slot: AgendaSlot, renderInline: InlineRenderer, seen: Set<string>, seenBio: Set<string>): string {
  const cards = slot.sessions
    .map((session) =>
      SERVICE_FORMATS.includes(session.format)
        ? serviceRow(session, renderInline)
        : sessionCard(session, renderInline, seen, seenBio),
    )
    .join('');
  const count = slot.sessions.length > 1 ? `<span class="slot-count">同时段 ${slot.sessions.length} 场</span>` : '';
  return `    <li class="agenda-slot">
      <p class="agenda-slot-head"><span class="agenda-time">${escapeHtml(slot.timeText)}</span>${count}</p>
      <ul class="agenda-cards">
${cards}      </ul>
    </li>\n`;
}

export function renderAgenda(days: AgendaDay[], renderInline: InlineRenderer): string {
  // 「首次出现」要跨整篇日程判断，所以用两张单独的表记谁已经出现过
  const seen = new Set<string>();
  const seenBio = new Set<string>();
  return days
    .map((day, index) => {
      const slots = day.slots.map((slot) => slotBlock(slot, renderInline, seen, seenBio)).join('');
      const open = index === 0 ? ' open' : '';
      return `<section class="agenda-day">
  <details class="agenda-day-block"${open}>
    <summary class="agenda-day-summary">${escapeHtml(day.title)}</summary>
    <ol class="agenda-slots">
${slots}    </ol>
  </details>
</section>\n`;
    })
    .join('');
}
