/** 会后资料的独立静态页。原始记录只转义文本，绝不执行其中的 Markdown/HTML。 */
import type { LoadedEvent } from './events.ts';
import type { SiteAssetNames } from './assets.ts';
import { escapeHtml } from './html.ts';
import { renderDocumentMarkdown } from './markdown.ts';
import { LINK_TABINDEX, renderLayout } from '../templates/layout.ts';
import { renderTocDrawer } from '../templates/event.ts';

export interface MaterialFile { relativePath: string; content: string | Buffer }

function link(href: string, label: string, extra = ''): string {
  return `<a href="${escapeHtml(href)}"${LINK_TABINDEX}${extra}>${escapeHtml(label)}</a>`;
}

function dateLabel(file: string): string {
  return `${file.slice(0, 4)}-${file.slice(4, 6)}-${file.slice(6, 8)}`;
}

export function renderMaterials(ev: LoadedEvent, assets: SiteAssetNames, siteUrl?: string): MaterialFile[] {
  const materials = ev.materials;
  if (!materials) return [];
  const files: MaterialFile[] = [];
  const rawLines = new Map(materials.raw.map(raw => [raw.file, raw.bytes.toString('utf8').replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)]));
  const hasSummary = Boolean(materials.summary?.trim());
  function page(relativePath: string, title: string, body: string, toc = ''): void {
    const prefix = '../'.repeat(relativePath.split('/').length);
    const eventPrefix = '../'.repeat(relativePath.split('/').length - 1);
    const crumbs = `<nav class="material-crumbs" aria-label="面包屑"><ol>
      <li>${link(prefix, '全部活动')}</li><li>${link(eventPrefix, ev.meta.title)}</li>
      ${relativePath.startsWith('raw/') && relativePath.split('/').length === 3 ? `<li>${link('../', '原始记录')}</li>` : ''}
      <li>${link('./', title, ' aria-current="page"')}</li></ol></nav>`;
    files.push({ relativePath, content: renderLayout({
      title: `${title} · ${ev.meta.title} · EventPrep`, description: `${ev.meta.title} 的${title}`,
      rootPrefix: prefix, canonicalPath: `${ev.slug}/${relativePath.replace(/index\.html$/, '')}`,
      siteUrl, assets, showToc: Boolean(toc),
      content: `<div class="wrap event material-page">${crumbs}<header class="event-head"><h1 class="event-title">${escapeHtml(title)}</h1>
        <p class="event-summary">${escapeHtml(ev.meta.title)}</p></header>${body}</div>${renderTocDrawer(toc)}`,
    }) });
  }

  if (hasSummary) {
    const source = materials.summary!;
    // 源 Markdown 仍引用同目录的原始文件；网页引用转到带行号的阅读页。
    const resolveLink = (href: string): string => {
      const match = /^(\d{8})-raw\.md(#L\d+)?$/.exec(href);
      if (!match) return href;
      const date = match[1];
      const hash = match[2];
      const raw = materials.raw.find((raw) => raw.file === `${date}-raw.md`);
      if (!raw) throw new Error(`总结引用的原始记录不存在：${date}-raw.md`);
      if (hash && (Number(hash.slice(2)) < 1 || Number(hash.slice(2)) > rawLines.get(raw.file)!.length)) {
        throw new Error(`总结引用的原文行号越界：${date}-raw.md${hash}`);
      }
      return `../raw/${date}/${hash ?? ''}`;
    };
    const rendered = renderDocumentMarkdown(source.replace(/^\uFEFF/, '').replace(/^# [^\n]*(?:\n|$)/, ''), resolveLink);
    const toc = rendered.toc.length ? `<nav class="toc" aria-label="本页目录"><ul class="toc-list">${rendered.toc.map((entry) =>
      `<li class="toc-item toc-depth-${entry.depth}">${link(`#${entry.id}`, entry.text)}</li>`).join('')}</ul></nav>` : '';
    page('summary/index.html', '会后总结', `<nav class="materials-links" aria-label="资料操作">${link('../summary.md', '下载总结 Markdown', ' download')}
      ${materials.raw.length ? link('../raw/', '查看原始记录') : ''}</nav><article class="content" data-content>${rendered.html}</article>`, toc);
    files.push({ relativePath: 'summary.md', content: source });
  }

  if (materials.raw.length) {
    page('raw/index.html', '原始记录', `<p class="notice">以下为现场中英双语自动转写，可能存在识别、翻译错误或记录缺漏。原文件保持原样，行号用于与总结交叉核对。</p>
      ${hasSummary ? `<p>${link('../summary/', '阅读会后总结')}</p>` : ''}
      <ul class="raw-dates">${materials.raw.map((raw) => `<li>${link(`${raw.file.slice(0, 8)}/`, dateLabel(raw.file))} · ${link(`../${raw.file}`, '下载原始 Markdown', ' download')}</li>`).join('')}</ul>`);
    for (const raw of materials.raw) {
      const date = raw.file.slice(0, 8);
      const lines = rawLines.get(raw.file)!;
      const html = lines.map((line, i) => `<div class="raw-line" id="L${i + 1}">${link(`#L${i + 1}`, String(i + 1), ` class="raw-line-number" aria-label="第 ${i + 1} 行"`)}<span>${escapeHtml(line)}</span></div>`).join('\n');
      page(`raw/${date}/index.html`, `${dateLabel(raw.file)} 原始记录`, `<p class="notice">自动转写可能有误。以下内容保留双语原文，行号以原文件为准；下载文件保留原始字节。</p>
        <nav class="materials-links" aria-label="资料操作">${link('../', '全部日期')}${hasSummary ? link('../../summary/', '会后总结') : ''}${link(`../../${raw.file}`, '下载原始 Markdown', ' download')}</nav>
        <div class="raw-transcript">${html}</div>`);
      files.push({ relativePath: raw.file, content: raw.bytes });
    }
  }
  return files;
}
