/** 首页：所有活动的索引，按状态分组。 */

import { escapeHtml, escapeJsonForScript } from '../lib/html.ts';
import {
  STATUS_LABEL,
  computeStatus,
  formatDateRange,
  formatStartClock,
  type EventStatus,
} from '../lib/status.ts';
import type { LoadedEvent } from '../lib/events.ts';
import { LINK_TABINDEX } from './layout.ts';

export interface HomeOptions {
  events: LoadedEvent[];
  /** 站点根 URL（可选）。 */
  siteUrl?: string;
}

/**
 * 嵌进页面的 site-data：**只有浏览器真正用到的字段**。
 *
 * 浏览器只用这 6 个（见 src/assets/site.js）：slug / startISO / endISO /
 * timezone / days / start。其余的（标题、简介、日期文案…）页面上已经有了，
 * 再塞一份进 JSON 只是白白变大；其中 status 更要不得——那是**构建时**的旧值，
 * 浏览器会按访问时刻重算，留着容易让人误读成权威值。
 */
export interface ClientEventData {
  slug: string;
  startISO: string | null;
  endISO: string | null;
  timezone: string;
  days: number | null;
  start: string | null;
}

/**
 * 卡片渲染数据。
 *
 * ⚠️ 这是**页面渲染的私有中间结构**，不导出——它只在 `renderHome` 里活一次。
 *    以前它是个导出的 `buildCardData()`，看着像两根管线（渲染用一份、浏览器用一份）的公共契约，
 *    实际只有渲染自己用：改卡片总要同时盯两处，而其中一处根本没人调用。
 *    真正跨到浏览器的那份是下面的 `ClientEventData`（见 `buildSitePayload`）。
 */
interface CardData {
  slug: string;
  title: string;
  summary: string;
  status: EventStatus;
  dateText: string;
  /** 真实开始时刻（`HH:MM`）；没有议程信息时是 null。 */
  startClock: string | null;
  placeText: string;
  tags: string[];
}

function buildCardData(events: LoadedEvent[]): CardData[] {
  return events.map((ev) => ({
    slug: ev.slug,
    title: ev.meta.title,
    summary: ev.meta.summary ?? '',
    status: computeStatus(ev.timing),
    dateText: formatDateRange(ev.timing),
    startClock: formatStartClock(ev.timing),
    placeText: placeText(ev),
    tags: ev.meta.tags,
  }));
}

/** 页面内嵌的 site-data。 */
export function buildSitePayload(events: LoadedEvent[]): ClientEventData[] {
  return events.map((ev) => ({
    slug: ev.slug,
    startISO: ev.timing.startISO,
    endISO: ev.timing.endISO,
    timezone: ev.timing.timezone,
    days: ev.timing.days,
    start: ev.timing.start,
  }));
}

function placeText(ev: LoadedEvent): string {
  const parts = [ev.meta.city, ev.meta.venue].filter((p): p is string => Boolean(p));
  return parts.join(' · ');
}

export function renderHome(options: HomeOptions): string {
  const { events } = options;
  const cards = buildCardData(events);

  const groups: Array<{ id: string; title: string; match: (c: CardData) => boolean }> = [
    {
      id: 'group-active',
      title: '即将开始 / 进行中',
      match: (c) => c.status === 'upcoming' || c.status === 'ongoing',
    },
    {
      id: 'group-unknown',
      title: '日期待定',
      match: (c) => c.status === 'unknown',
    },
    {
      id: 'group-ended',
      title: '已结束',
      match: (c) => c.status === 'ended',
    },
  ];

  const sections = groups
    .map((group) => {
      const items = cards.filter(group.match);
      const list = items
        .map((c) => renderCard(c))
        .join('\n');
      // 空分组先藏起来——「已结束 0」加上一个虚线框就是空壳，
      // 需求里明说「缺失数据不显示空壳」。分组容器还在 DOM 里，
      // 浏览器端按访问时刻重新分组时，有卡片搬进来再把它显示出来。
      const hidden = items.length === 0 ? ' hidden' : '';
      return `<section class="group" id="${group.id}" data-group="${group.id}"${hidden}>
  <h2 class="group-title">${escapeHtml(group.title)}<span class="group-count" data-group-count>${items.length}</span></h2>
  <ul class="cards" data-cards>${list}</ul>
</section>`;
    })
    .join('\n');

  const empty = `<section class="empty-state">
  <h2>还没有收录任何活动</h2>
  <p>把活动名称或链接交给调研流程，生成一份 <code>event.md</code> 放进 <code>content/</code> 目录，这个页面就会有内容了。</p>
</section>`;

  const body = cards.length === 0 ? empty : sections;

  const total = cards.length;
  const sub = total === 0
    ? '把各种活动的公开日程，整理成手机上随时能查的准备页'
    : `共收录 ${total} 个活动 · 把各种活动的公开日程，整理成手机上随时能查的准备页`;

  const dataJson = escapeJsonForScript({ events: buildSitePayload(events) });

  return `<div class="wrap home">
  <section class="hero">
    <h1>行程准备站</h1>
    <p class="hero-sub">${escapeHtml(sub)}</p>
  </section>
${body}
</div>
<script type="application/json" id="site-data">${dataJson}</script>
`;
}

function renderCard(card: CardData): string {
  const tags = card.tags.length
    ? `<ul class="tags">${card.tags.map((t) => `<li class="tag">${escapeHtml(t)}</li>`).join('')}</ul>`
    : '';
  const meta: string[] = [];
  if (card.dateText !== '日期待定') meta.push(`<div><dt>时间</dt><dd>${escapeHtml(card.dateText)}</dd></div>`);
  // 真实开始时刻：读者要的是「几点到场」，光有日期不够。
  // 没有议程信息时不写这一行——「00:00 开始」是在编造。
  if (card.startClock) meta.push(`<div><dt>开始</dt><dd>${escapeHtml(card.startClock)}</dd></div>`);
  if (card.placeText) meta.push(`<div><dt>地点</dt><dd>${escapeHtml(card.placeText)}</dd></div>`);

  return `<li class="event-card" data-event-slug="${escapeHtml(card.slug)}">
  <div class="card-head">
    <h3 class="card-title"><a href="${escapeHtml(card.slug)}/"${LINK_TABINDEX}>${escapeHtml(card.title)}</a></h3>
    ${card.summary ? `<p class="card-summary">${escapeHtml(card.summary)}</p>` : ''}
  </div>
  ${meta.length ? `<dl class="card-meta">${meta.join('')}</dl>` : ''}
  ${tags}
  <div class="card-side">
    <span class="badge badge-${card.status}" data-status-badge>${escapeHtml(STATUS_LABEL[card.status])}</span>
    <!-- 倒计时初始留空：状态徽章已经说了「即将开始」，再写一遍是同一句话说两遍。
         浏览器端按访问时刻填真倒计时，空着的时候 .countdown:empty 把这行收起。 -->
    <p class="countdown" data-countdown></p>
  </div>
</li>`;
}
