/** 活动页：按现场使用顺序排布的行程与准备页。 */

import { escapeHtml, escapeJsonForScript } from '../lib/html.ts';
import { STATUS_LABEL, computeStatus, formatDateRange } from '../lib/status.ts';
import { EXPORT_FILE, type LoadedEvent } from '../lib/events.ts';
import type { TocEntry } from '../lib/markdown.ts';
import { LINK_TABINDEX } from './layout.ts';
import { buildSitePayload } from './home.ts';

export interface EventPageOptions {
  event: LoadedEvent;
  /** 已渲染并消毒过的正文 HTML。 */
  bodyHtml: string;
  /** 目录条目。 */
  toc: TocEntry[];
  /** 「最重要的 3 件事」；没有则不显示这一块。 */
  calloutHtml: string | null;
  siteUrl?: string;
}

export function renderEventPage(options: EventPageOptions): string {
  const { event, bodyHtml, toc, calloutHtml } = options;
  const meta = event.meta;
  const timing = event.timing;

  const status = computeStatus(event.timing);
  const statusLabel = STATUS_LABEL[status];

  const metaRows: string[] = [];
  metaRows.push(row('日期', formatDateRange(timing)));
  // 地点：场地名本身可以点（venue_url），别只给一个「地图」按钮——
  // 读者要的是「这地方到底是哪」，地图只回答「怎么过去」。
  const placeParts: string[] = [];
  if (meta.city) placeParts.push(escapeHtml(meta.city));
  if (meta.venue) {
    placeParts.push(
      meta.venue_url
        ? `<a class="meta-link" href="${escapeHtml(meta.venue_url)}"${LINK_TABINDEX} target="_blank" rel="noopener noreferrer">${escapeHtml(
            meta.venue,
          )}</a>`
        : escapeHtml(meta.venue),
    );
  }
  if (placeParts.length > 0) metaRows.push(rowHtml('地点', placeParts.join(' · ')));
  if (meta.address) metaRows.push(row('地址', meta.address));
  if (meta.organizer) metaRows.push(row('主办方', meta.organizer));
  metaRows.push(
    row(
      '时区',
      timing.timezoneKnown
        ? timing.timezone
        : '未提供时区，按 UTC 计算',
    ),
  );

  // 手机上这五行会占掉大半屏，先收成一行摘要，点开才看全部
  const summaryBits = [formatDateRange(timing)];
  if (meta.city) summaryBits.push(meta.city);
  if (meta.venue) summaryBits.push(meta.venue);
  const metaSummary = summaryBits.filter((b) => b !== '日期待定').join(' · ');

  const actions: string[] = [];
  if (meta.website) actions.push(action(meta.website, '官网', true));
  if (meta.agenda_url) actions.push(action(meta.agenda_url, '议程', !meta.website));
  if (meta.ticket_url) actions.push(action(meta.ticket_url, '报名', !meta.website && !meta.agenda_url));
  // 「场地」是场地的官方页面（酒店官网、场馆官网）——
  // 窄屏头部信息是收起来的，没有这个按钮读者在手机上就点不到场地链接。
  if (meta.venue_url) actions.push(action(meta.venue_url, '场地', false));
  if (meta.map_url) actions.push(action(meta.map_url, '地图', false));

  const tags = meta.tags.length
    ? `<ul class="tags">${meta.tags.map((t) => `<li class="tag">${escapeHtml(t)}</li>`).join('')}</ul>`
    : '';

  const tocHtml = renderToc(toc);
  // 目录住在顶栏按钮点开的抽屉里，不占正文版面。
  const tocDrawer = toc.length
    ? `<dialog class="toc-drawer" id="toc-drawer" aria-label="本页目录">
  <div class="toc-drawer-head">
    <span class="toc-drawer-title">本页目录</span>
    <button type="button" class="toc-drawer-close" aria-label="关闭目录" title="关闭目录">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"></path></svg>
    </button>
  </div>
  <div class="toc-drawer-body">${tocHtml}</div>
</dialog>`
    : '';

  // site-data 的构造只有一处（home.ts 的 buildSitePayload）——活动页复用它，
  // 两边就不会各有一份手抄的字段清单，改了一边另一边不会悄悄漏掉
  const dataJson = escapeJsonForScript({ events: buildSitePayload([event]) });

  return `<div class="wrap event" data-event-slug="${escapeHtml(event.slug)}">
  <nav class="crumbs" aria-label="面包屑">
    <a href="../"${LINK_TABINDEX}>← 全部活动</a>
  </nav>

  <header class="event-head">
    <span class="badge badge-${status}" data-status-badge>${escapeHtml(statusLabel)}</span>
    <h1 class="event-title">${escapeHtml(meta.title)}</h1>
    ${meta.summary ? `<p class="event-summary">${escapeHtml(meta.summary)}</p>` : ''}
    <details class="event-meta-wrap" data-event-meta open>
      <summary class="event-meta-summary">
        <span class="event-meta-summary-text">${escapeHtml(metaSummary)}</span>
        <span class="event-meta-summary-action">详情</span>
        <span class="collapse-chevron" aria-hidden="true"></span>
      </summary>
      <dl class="event-meta">
${metaRows.join('\n')}
      </dl>
    </details>
    ${countdownSlot()}
    ${tags}
    ${actions.length ? `<ul class="actions">${actions.join('')}</ul>` : ''}
    ${
      timing.timezoneKnown
        ? ''
        : '<p class="notice">这个活动没有提供时区，日期与倒计时按 <strong>UTC</strong> 计算，可能与活动所在地的实际时间差一天。</p>'
    }
  </header>

  ${calloutHtml ? `<section class="callout" aria-labelledby="callout-title">
  <h2 id="callout-title">最重要的 3 件事</h2>
  <div class="callout-body">${calloutHtml}</div>
</section>` : ''}

  <div class="event-body">
    <article class="content" data-content>
${bodyHtml}
    </article>
  </div>

  ${exportNote(event.slug)}
</div>
${tocDrawer}
<script type="application/json" id="site-data">${dataJson}</script>
`;
}

/**
 * 目录：二级标题是顶层，三级标题收进各自的可折叠子列表。
 *
 * ⚠️ 为什么不一股脑全列出来：活动页的「推荐路线」下面常常挂着五六条三级标题，
 *    全摊开就是一堵墙——真正要扫的章节（速览、日程、行前清单）反而被挤到下面去了。
 *    收成「展开 N 项」之后，目录只剩页面级的章节，点开才看到细节。
 *
 * ⚠️ 孤立的三级标题（前面没有二级标题）照样列出来，只是当顶层——
 *    丢掉它等于读者在目录里找不到那一节。
 *
 * ⚠️ 目录本身住在顶栏按钮点开的抽屉里（`renderEventPage` 的 tocDrawer），
 *    所以这里只出列表，不再套一层可折叠的 details——抽屉的开关就是那层折叠。
 */
export function renderToc(toc: TocEntry[]): string {
  if (toc.length === 0) return '';

  const items: string[] = [];
  let index = 0;
  while (index < toc.length) {
    const entry = toc[index];
    if (!entry) break;
    if (entry.depth > 2) {
      items.push(tocItem(entry));
      index += 1;
      continue;
    }
    // 跟在这个二级标题后面的三级标题，收成它自己的子列表
    const children: TocEntry[] = [];
    let next = index + 1;
    while (next < toc.length) {
      const child = toc[next];
      if (!child || child.depth <= 2) break;
      children.push(child);
      next += 1;
    }
    if (children.length === 0) {
      items.push(tocItem(entry));
    } else {
      items.push(
        `      <li class="toc-item toc-depth-2 toc-has-children">${tocLink(entry)}
        <details class="toc-sub">
          <summary class="toc-sub-summary">展开 ${children.length} 项</summary>
          <ul class="toc-list toc-sub-list">
${children.map((child) => tocItem(child)).join('\n')}
          </ul>
        </details>
      </li>`,
      );
    }
    index = next;
  }

  return `<nav class="toc" aria-label="本页目录">
    <ul class="toc-list">
${items.join('\n')}
    </ul>
  </nav>`;
}

function tocLink(entry: TocEntry): string {
  return `<a href="#${escapeHtml(entry.id)}"${LINK_TABINDEX}>${escapeHtml(entry.text)}</a>`;
}

function tocItem(entry: TocEntry): string {
  return `      <li class="toc-item toc-depth-${entry.depth}">${tocLink(entry)}</li>`;
}

/**
 * 页面底部那行「把这一页拿走改」。
 *
 * 这一页的内容就是一份 Markdown（构建时把源文件原样放在页面旁边），
 * 拿走改完塞回 content/ 就能更新——给 AI 用、给人用，都是同一条路。
 * 放在正文后面而不是头部：现场看页面的人不需要它，编辑的人一眼能看见。
 */
function exportNote(slug: string): string {
  return `<p class="export-note">给 AI 或编辑器用：<a class="export-link" href="${EXPORT_FILE}"${LINK_TABINDEX} download>下载本页的 Markdown</a>（改完放回 <code>content/${escapeHtml(
    slug,
  )}/${EXPORT_FILE}</code>，重新构建就更新）</p>`;
}

function row(label: string, value: string): string {
  return `      <div class="meta-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

/** 值里带链接的 meta 行（值已经是 HTML，不再转义）。 */
function rowHtml(label: string, valueHtml: string): string {
  return `      <div class="meta-row"><dt>${escapeHtml(label)}</dt><dd>${valueHtml}</dd></div>`;
}

/**
 * 倒计时那一行的初始内容：**留空**。
 *
 * 状态已经由上面那枚徽章说了，没有 JavaScript 时再写一遍「即将开始」等于
 * 同一句话说两遍；而构建时刻算出来的倒计时又会过期（骗人）。
 * 元素本身要留在 DOM 里——浏览器端按访问时刻把真倒计时填进去，
 * 空着的时候 `.countdown:empty` 把它整行收起，不留空壳。
 */
function countdownSlot(): string {
  return '<p class="countdown countdown-lg" data-countdown></p>';
}

function action(href: string, label: string, isPrimary = false): string {
  const cls = isPrimary ? 'action-btn action-btn-primary' : 'action-btn';
  return `<li><a class="${cls}" href="${escapeHtml(href)}"${LINK_TABINDEX} target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a></li>`;
}

/** schema.org 的 Event 结构化数据，方便搜索引擎和日历工具识别。 */
export function buildJsonLd(event: LoadedEvent): unknown | null {
  const meta = event.meta;
  if (!meta.title) return null;
  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: meta.title,
  };
  if (meta.summary) ld.description = meta.summary;
  if (event.timing.startISO) {
    ld.startDate = event.timing.startISO;
    ld.endDate = event.timing.endISO ?? event.timing.startISO;
  }
  if (meta.website) ld.url = meta.website;
  if (meta.organizer) ld.organizer = { '@type': 'Organization', name: meta.organizer };
  const location: Record<string, unknown> = { '@type': 'Place' };
  if (meta.venue) location.name = meta.venue;
  if (meta.address || meta.city) {
    // 街道地址和城市都要留：只写其中一个会把另一个覆盖掉
    const address: Record<string, unknown> = { '@type': 'PostalAddress' };
    if (meta.address) address.streetAddress = meta.address;
    if (meta.city) address.addressLocality = meta.city;
    location.address = address;
  }
  if (meta.venue || meta.address || meta.city) ld.location = location;
  return ld;
}
