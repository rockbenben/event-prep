/** 会后资料的独立静态页。原始记录只转义文本，绝不执行其中的 Markdown/HTML。 */
import type { LoadedEvent } from './events.ts';
import type { SiteAssetNames } from './assets.ts';
import { escapeHtml } from './html.ts';
import { renderDocumentMarkdown } from './markdown.ts';
import { LINK_TABINDEX, renderLayout } from '../templates/layout.ts';
import { renderTocDrawer } from '../templates/event.ts';

export interface MaterialFile { relativePath: string; content: string | Buffer }

const RAW_PAGE_SIZE = 500;
function rawPart(line: number): string {
  const part = Math.ceil(line / RAW_PAGE_SIZE);
  return part === 1 ? '' : `part-${part}/`;
}

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
  const citations: { date: string; line: number; section: string; label: string }[] = [];
  function page(relativePath: string, title: string, body: string, toc = ''): void {
    const prefix = '../'.repeat(relativePath.split('/').length);
    const eventPrefix = '../'.repeat(relativePath.split('/').length - 1);
    const crumbs = `<nav class="material-crumbs" aria-label="面包屑"><ol>
      <li>${link(prefix, '全部活动')}</li><li>${link(eventPrefix, ev.meta.title)}</li>
      ${relativePath.startsWith('raw/') && relativePath.split('/').length >= 3 ? `<li>${link('../'.repeat(relativePath.split('/').length - 2), '原始记录')}</li>` : ''}
      <li>${link('./', title, ' aria-current="page"')}</li></ol></nav>`;
    files.push({ relativePath, content: renderLayout({
      title: `${title} · ${ev.meta.title} · EventPrep`, description: `${ev.meta.title} 的${title}`,
      rootPrefix: prefix, canonicalPath: `${ev.slug}/${relativePath.replace(/index\.html$/, '')}`,
      siteUrl, assets, showToc: Boolean(toc),
      content: `<div class="page-with-toc">${renderTocDrawer(toc)}<div class="wrap event material-page">${crumbs}<header class="event-head"><h1 class="event-title">${escapeHtml(title)}</h1>
        <p class="event-summary">${escapeHtml(ev.meta.title)}</p></header>${body}</div></div>`,
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
      return `../raw/${date}/${hash ? rawPart(Number(hash.slice(2))) + hash : ''}`;
    };
    const rendered = renderDocumentMarkdown(source.replace(/^\uFEFF/, '').replace(/^# [^\n]*(?:\n|$)/, ''), resolveLink);
    // 使用已经渲染过的链接（含参考式引用），记录每个引用所属的总结章节。
    let section = '';
    for (const match of rendered.html.matchAll(/<h[2-4] id="([^"]+)"|<a href="\.\.\/raw\/(\d{8})\/(?:part-\d+\/)?#L(\d+)"/g)) {
      if (match[1]) section = match[1];
      else if (section && match[2] && match[3]) citations.push({ date: match[2], line: Number(match[3]), section, label: rendered.toc.find(entry => entry.id === section)!.text });
    }
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
      const count = Math.ceil(lines.length / RAW_PAGE_SIZE);
      function readingPage(part: number | null): void {
        const full = part === null;
        const prefix = full || part! > 1 ? '../' : './';
        const start = full ? 0 : (part! - 1) * RAW_PAGE_SIZE;
        const end = full ? lines.length : Math.min(start + RAW_PAGE_SIZE, lines.length);
        const renderedLines = lines.slice(start, end).map((line, i) => {
          const number = start + i + 1;
          return `<div class="raw-line" id="L${number}">${link(`#L${number}`, String(number), ` class="raw-line-number" aria-label="第 ${number} 行"`)}<span>${escapeHtml(line)}</span></div>`;
        });
        // 全文保留全部 DOM 与行号，只让屏幕外的区块延后排版。
        const html = full ? Array.from({ length: Math.ceil(renderedLines.length / 100) }, (_, i) =>
          `<div class="raw-chunk">${renderedLines.slice(i * 100, (i + 1) * 100).join('\n')}</div>`).join('\n') : renderedLines.join('\n');
        const related = [...new Map(citations.filter(citation => citation.date === date && (full || (citation.line > start && citation.line <= end)))
          .map(citation => [citation.section, citation])).values()];
        const summaryLinks = related.length ? `<details class="raw-sections"><summary>相关总结 · ${related.length} 节</summary><nav class="materials-links" aria-label="相关总结">${related.map(citation =>
          link(`${prefix}../../summary/#${citation.section}`, citation.label)).join('')}</nav></details>` : '';
        const navigation = `<nav class="materials-links raw-pagination" aria-label="原文分段">
          ${!full && part! > 1 ? link(prefix + rawPart(start), '上一段', ' rel="prev"') : ''}
          <span aria-current="page">${full ? `全文 · 共 ${lines.length} 行` : `第 ${part} / ${count} 段 · L${start + 1}–L${end}`}</span>
          ${!full && part! < count ? link(prefix + rawPart(end + 1), '下一段', ' rel="next"') : ''}
          ${link(prefix + (full ? '' : 'all/'), full ? '分段阅读' : '查看全文')}
        </nav>`;
        const sections = `<details class="raw-sections"><summary>选择行号范围</summary><nav class="materials-links" aria-label="选择原文段落">${Array.from({ length: count }, (_, i) =>
          link(prefix + rawPart(i * RAW_PAGE_SIZE + 1), `L${i * RAW_PAGE_SIZE + 1}–L${Math.min((i + 1) * RAW_PAGE_SIZE, lines.length)}`, !full && part === i + 1 ? ' aria-current="page"' : '')).join('')}</nav></details>`;
        page(`raw/${date}/${full ? 'all/' : rawPart(start + 1)}index.html`, `${dateLabel(raw.file)} 原始记录`, `<p class="notice">自动转写可能有误。以下内容保留双语原文，行号以原文件为准；下载文件保留原始字节。${full ? '当前显示全文，可在浏览器中搜索全部记录。' : '当前仅加载本段；搜索全部记录或打印全文请先选择「查看全文」。'}</p>
          <nav class="materials-links" aria-label="资料操作">${link(prefix + '../', '全部日期')}${hasSummary ? link(prefix + '../../summary/', '会后总结') : ''}${link(`${prefix}../../${raw.file}`, '下载原始 Markdown', ' download')}</nav>
          ${navigation}${sections}${summaryLinks}
          <div class="raw-transcript${full ? ' raw-full' : ''}"${full ? '' : ` data-raw-total="${lines.length}"`}>${html}</div>${navigation}`);
      }
      for (let part = 1; part <= count; part += 1) readingPage(part);
      readingPage(null);
      files.push({ relativePath: raw.file, content: raw.bytes });
    }
  }
  return files;
}
