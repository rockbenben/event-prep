/** 页面外壳：所有页面共用的 <html> 骨架、页头页脚、主题切换。 */

import { escapeHtml } from '../lib/html.ts';

export interface LayoutOptions {
  /** 浏览器标签页标题。 */
  title: string;
  /** meta description。 */
  description: string;
  /**
   * 站内相对路径前缀。
   * 首页是 `''`，活动页是 `'../'`——用相对路径而不是绝对路径，
   * 这样站点挂在 `/<repo>/`（GitHub Pages 项目站）还是根路径都能正常工作。
   */
  rootPrefix: string;
  /** <main> 里的内容。 */
  content: string;
  /** 站点根 URL，用于 og:url（可选）。 */
  siteUrl?: string;
  /**
   * 社交分享用的预览图（**站内相对路径**，如 `og-image.png`）。
   *
   * `og:image` 只收绝对 URL 或带 scheme 的地址，而站内链接一律相对
   * （站点挂在 `/<repo>/` 还是根路径都不用改配置）——所以这里只在
   * `siteUrl` 给了的时候才拼得出来；没给就两个 meta 都不写，
   * 比写一条相对路径、让爬虫去猜要好。
   */
  ogImage?: string | null;
  /** 本页在站点内的路径（如 `2026-11-ai-engineer/`），用于 canonical。 */
  canonicalPath?: string;
  /** JSON-LD 结构化数据（可选）。 */
  jsonLd?: unknown;
  /**
   * 页头放一个「目录」按钮（活动页有目录时才放）。
   *
   * 目录住在抽屉里而不是正文旁边：正文上方一列字会挤走版面，
   * 而顶栏这个按钮是文档站的日常习惯——点开就是侧边目录。
   */
  showToc?: boolean;
  /**
   * 站点级资源在产物里的文件名（**带内容哈希**，如 `site.4f3a2b1c.css`）。
   *
   * ⚠️ 必须与构建实际写出的文件名一致——对不上就是一条 404，
   *    而且页面会「看起来正常」（只是 CSS 没生效），很难一眼看出。
   *    由 `build.ts` 统一算好后传进来。
   */
  assets: {
    css: string;
    js: string;
  };
}

/**
 * 站内链接一律带 `tabindex="0"`。
 *
 * 看着多余，但**别删**：Safari 默认不把链接放进 Tab 序列
 * （要手动开「按 Tab 键高亮网页上的每一项」），加上它链接才进得了焦点序列。
 * 这是 WebAIM 给的办法，在别的引擎上什么都不改变。
 */
export const LINK_TABINDEX = ' tabindex="0"';

/** 头部的 GitHub 图标指向仓库。 */
const REPO_URL = 'https://github.com/rockbenben/event-prep';

/** 在 <head> 里先把主题定下来，避免刷新时闪一下白底。 */
const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem('eventprep:theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

export function renderLayout(options: LayoutOptions): string {
  const { rootPrefix, title, description } = options;
  // canonical 与 og:url 都指向**本页**，不是站点根
  const pageUrl = options.siteUrl
    ? canonicalUrl(options.siteUrl, options.canonicalPath ?? '')
    : '';

  const jsonLd = options.jsonLd
    ? `<script type="application/ld+json">${JSON.stringify(options.jsonLd).replace(/</g, '\\u003c')}</script>`
    : '';

  // og:image 需要绝对 URL；siteUrl 没给就什么都不写（相对路径爬虫看不懂）
  const ogImageUrl = options.siteUrl && options.ogImage
    ? joinUrl(options.siteUrl, options.ogImage)
    : '';
  const ogImageTags = ogImageUrl
    ? `<meta property="og:image" content="${escapeHtml(ogImageUrl)}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escapeHtml(options.title)}">`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="color-scheme" content="light dark">
<!-- 地址栏/标签栏颜色跟着深浅色走，值就是 site.css 里的 --bg。
     以前这里写死一个 #1f6feb —— 那个色号在 CSS 里根本不存在（--accent 是 #2563eb），
     深色模式下也是蓝色地址栏配深色页面。两段 meta 各自带 media，浏览器自己选。 -->
<meta name="theme-color" content="#f8fafc" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0b0f17" media="(prefers-color-scheme: dark)">
${pageUrl ? `<link rel="canonical" href="${escapeHtml(pageUrl)}">` : ''}
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
${pageUrl ? `<meta property="og:url" content="${escapeHtml(pageUrl)}">` : ''}
${ogImageTags}
<script>${THEME_BOOTSTRAP}</script>
<link rel="icon" type="image/svg+xml" href="${rootPrefix}assets/favicon.svg">
<link rel="stylesheet" href="${rootPrefix}assets/${options.assets.css}">
${jsonLd}
</head>
<body>
<!-- 打印版工具条：平时 display:none，进入打印模式（<html class="print-mode">）才出现。
     打印到纸上时这条工具条自身要藏掉（见 site.css 的 @media print）——它是屏幕上的控件。 -->
<div class="print-bar" id="print-bar" role="toolbar" aria-label="打印版工具条">
  <span class="print-bar-title">EventPrep · 打印版 · 全部内容已展开</span>
  <div class="print-bar-actions">
    <button type="button" id="print-do" class="ghost-btn">打印 / 存 PDF</button>
    <button type="button" id="print-exit" class="ghost-btn">退出打印版</button>
  </div>
</div>
<a class="skip-link" href="#main"${LINK_TABINDEX}>跳到正文</a>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="site-name" href="${rootPrefix}index.html"${LINK_TABINDEX}>
      <svg class="site-logo" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
        <rect x="3" y="3.5" width="18" height="18" rx="4" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-width="1.8"/>
        <rect x="9.5" y="5.5" width="5" height="1.8" rx="0.9" fill="currentColor" fill-opacity="0.4"/>
        <path d="M6.5 11h5M6.5 14.5h3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        <circle cx="16" cy="15" r="4.2" fill="#16a34a"/>
        <path d="M14.2 15l1.3 1.3 2.5-2.5" stroke="#ffffff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>EventPrep</span>
    </a>
    <div class="header-actions">
      ${
        options.showToc
          ? `<button type="button" id="toc-open" class="ghost-btn" aria-label="目录" title="目录" aria-haspopup="dialog" aria-controls="toc-drawer">
        <svg class="theme-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" focusable="false">
          <path d="M9 6h11M9 12h11M9 18h11"></path>
          <circle cx="4.5" cy="6" r="1.1" fill="currentColor" stroke="none"></circle>
          <circle cx="4.5" cy="12" r="1.1" fill="currentColor" stroke="none"></circle>
          <circle cx="4.5" cy="18" r="1.1" fill="currentColor" stroke="none"></circle>
        </svg>
      </button>`
          : ''
      }
      ${
        options.showToc
          ? `<button type="button" id="print-open" class="ghost-btn" aria-label="打印版" title="打印版（展开全部内容）">
        <svg class="theme-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
          <path d="M6 9V3h12v6"></path>
          <rect x="6" y="14" width="12" height="8" rx="1"></rect>
          <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
          <circle cx="18" cy="12" r="0.8" fill="currentColor" stroke="none"></circle>
        </svg>
      </button>`
          : ''
      }
      <a class="ghost-btn" href="${REPO_URL}" target="_blank" rel="noopener noreferrer" aria-label="GitHub 仓库" title="GitHub 仓库">
        <svg class="theme-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
          <path d="M12 .8a11.2 11.2 0 0 0-3.54 21.83c.56.1.77-.24.77-.54v-2.1c-3.12.68-3.78-1.33-3.78-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.68.08-.68 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.63 1.22 3.27.95.1-.74.39-1.22.71-1.5-2.5-.28-5.12-1.25-5.12-5.56 0-1.23.44-2.23 1.16-3.02-.12-.28-.5-1.43.11-2.98 0 0 .95-.3 3.1 1.15a10.8 10.8 0 0 1 5.64 0c2.15-1.45 3.1-1.15 3.1-1.15.61 1.55.23 2.7.11 2.98.72.79 1.16 1.79 1.16 3.02 0 4.32-2.63 5.27-5.14 5.55.4.35.76 1.03.76 2.08v3.08c0 .3.2.65.78.54A11.2 11.2 0 0 0 12 .8Z"></path>
        </svg>
      </a>
      <button type="button" id="theme-toggle" class="ghost-btn" aria-label="切换深浅色" title="切换深浅色">
        <svg class="theme-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 3.5a8.5 8.5 0 0 0 0 17z" fill="currentColor" stroke="none" />
        </svg>
      </button>
    </div>
  </div>
</header>
<dialog class="avatar-viewer" id="avatar-viewer" aria-label="放大照片">
  <img id="avatar-viewer-img" src="" alt="">
</dialog>
<main id="main">
${options.content}
</main>
<footer class="site-footer">
  <div class="wrap">
    <p>页面信息来自各活动公开资料，可能随时变更；出发前请以主办方官方公告为准。</p>
  </div>
</footer>
<script src="${rootPrefix}assets/${options.assets.js}" defer></script>
</body>
</html>
`;
}

function canonicalUrl(siteUrl: string, path: string): string {
  const base = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;
  // 首页的路径是空的，别拼出一个双斜杠
  if (!path) return base;
  const rel = path.endsWith('/') ? path : `${path}/`;
  return `${base}${rel}`;
}

/** 把一个站内相对路径接到站点根后面（og:image 用）。 */
function joinUrl(siteUrl: string, relative: string): string {
  const base = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;
  const rel = relative.replace(/^\.?\//, '');
  return `${base}${rel}`;
}
