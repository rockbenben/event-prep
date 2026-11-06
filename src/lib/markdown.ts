/**
 * Markdown → 安全 HTML。
 *
 * 三个特别要求：
 *
 * 1. **`<details markdown="1">` 里的 Markdown 要被解析成 HTML。**
 *    通用 Markdown 引擎默认把 HTML 块整块原样透传，里面再写 Markdown 不会被解析。
 *    所以这里先把文档按 `<details>…</details>` 切成段，details 段的内容**单独递归解析**，
 *    再把结果塞回 details 里。段外的普通文本才交给 marked。
 *
 * 2. **「机构与嘉宾」「前置知识」这类说明性内容收成点开式条目。**
 *    手机上这类内容一屏放不下，摊开写等于把正文挤走。做法是：这两节里的
 *    三级标题（`###`）连同其下内容，收成一个「图标 + 名称 + 一行摘要」的条目，
 *    点一下才展开正文。用的是原生 `<details>`——键盘可达、移动端点一下就开，
 *    不需要任何脚本。
 *
 * 3. **不可信内容不能注入脚本或危险 URL。**
 *    所有产出一律过一遍 sanitize-html 的白名单：`javascript:` / `data:` 之类的协议被挡掉，
 *    `style` 属性不开放，外链补 `rel="noopener noreferrer"`。
 */

import { Marked, type Token, type TokensList } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { escapeHtml, hashText, htmlToPlain, slugify } from './html.ts';
import { parseAgenda } from './agenda.ts';
import { renderAgenda } from '../templates/agenda.ts';

export interface TocEntry {
  id: string;
  text: string;
  depth: number;
  /**
   * 目录条目的种类：
   * · `agenda-day` —— 日程里的一天：目录里略微缩进，跟页面级章节分开。
   * · `route`      —— 推荐路线里的一条：收成折叠条目，但目录里仍列出来
   *                  （读者是按自己的角色找路线的）。
   */
  kind?: 'agenda-day' | 'route';
}

export interface RenderedMarkdown {
  html: string;
  toc: TocEntry[];
}

interface Segment {
  type: 'text' | 'details' | 'agenda';
  content: string;
  attrs?: string;
}

/**
 * 章节的处理方式。**章节名匹配集中在这里**，别在模板里写死。
 *
 * ⚠️ 日程排在最前：章节名里同时出现「日程」和「讲者」时，议程优先
 *    （议程章节整体由议程渲染器接管，里面的 `###` 不该被收成机构条目）。
 */
export type SectionVariant = 'entity' | 'term' | 'agenda' | 'route';

const SECTION_VARIANTS: Array<{ match: RegExp; variant: SectionVariant }> = [
  { match: /日程|议程|^agenda$|^schedule$/i, variant: 'agenda' },
  // 关键词覆盖会议之外的场合（演出、赛事、展览），它们同样有「一帮人和机构要认」
  { match: /机构|嘉宾|讲者|讲师|演讲者|艺术家|演员|选手/, variant: 'entity' },
  { match: /前置知识|术语|背景知识/, variant: 'term' },
  // 「推荐路线」下面通常挂着五六条路线：每条是一整个角色视角，
  // 读者多半只关心跟自己相关的那一条，所以收成可折叠的条目（默认展开）。
  { match: /推荐路线|^路线$|推荐路径/, variant: 'route' },
];

/** 这个章节怎么处理。 */
export function variantForSection(section: string): SectionVariant | null {
  for (const item of SECTION_VARIANTS) {
    if (item.match.test(section)) return item.variant;
  }
  return null;
}

const ALLOWED_TAGS = [
  'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'a', 'ul', 'ol', 'li',
  'blockquote', 'strong', 'em', 'del', 's', 'code', 'pre', 'kbd', 'mark', 'sup', 'sub',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'br', 'hr', 'img',
  'details', 'summary',
  'span', 'div', 'section', 'button',
  'input', 'label', 'textarea',
];

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel', 'tabindex', 'aria-label', 'class'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'class'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan', 'scope'],
    details: ['open', 'id', 'class', 'data-day-date', 'data-fold-key'],
    summary: ['class', 'title', 'aria-label'],
    // 标题要带 id，目录里的锚点才指得到
    h2: ['id'],
    h3: ['id'],
    h4: ['id'],
    h5: ['id'],
    h6: ['id'],
    div: ['class'],
    span: ['class', 'aria-hidden'],
    code: ['class'],
    pre: ['class'],
    // ⚠️ 日程卡片用到的这四个标签要能挂 class。
    //    allowedClasses 放行的是 class 的**值**，allowedAttributes 放行的是 class **属性本身**，
    //    只改前者等于没改——属性会被整个剥掉。
    ol: ['start', 'class'],
    ul: ['class'],
    p: ['class'],
    section: ['class'],
    button: [
      'type', 'class', 'data-avatar', 'data-avatar-alt', 'data-note-key', 'aria-label', 'title', 'aria-expanded',
    ],
    textarea: ['class', 'placeholder', 'rows', 'aria-label'],
    input: ['type', 'id', 'checked', 'data-check-id'],
    label: ['for'],
    li: ['class'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  // class 只放行一小撮，避免作者用样式做布局伪装（也不需要）
  allowedClasses: {
    div: [
      'collapse-body', 'agenda-speaker-main', 'agenda-speaker-line', 'agenda-tags', 'agenda-title-row',
      'agenda-tip', 'agenda-tip-body',
      // ⚠️ 提示图标分两种：讲者简介（中性）与「看这场之前要知道的事」（暖色提醒）。
      //    这两个值不在白名单里的话，class 属性在、值被剥掉 → 暖色永远不生效（还看不出来）。
      'agenda-tip-bio', 'agenda-tip-remark',
      // 读者自己写的笔记（存在本机浏览器里）
      'agenda-note', 'agenda-note-editor',
      // 行前清单默认折叠的容器
      'checklist-fold-body',
    ],
    span: [
      'tag', 'note', 'note-warn', 'collapse-icon', 'collapse-text', 'collapse-name',
      'collapse-teaser', 'collapse-chevron',
      'agenda-time', 'slot-count', 'speaker-name', 'speaker-org', 'agenda-duration',
    ],
    li: ['task-item', 'agenda-slot', 'agenda-card', 'agenda-speaker', 'agenda-break'],
    ul: ['agenda-cards', 'agenda-speakers'],
    ol: ['agenda-slots'],
    p: ['agenda-highlight', 'agenda-slot-head', 'agenda-abstract-text', 'agenda-note-hint'],
    section: ['agenda-day'],
    a: ['agenda-source'],
    img: ['agenda-avatar'],
    button: ['agenda-avatar-btn', 'agenda-note-btn'],
    textarea: ['agenda-note-input'],
    details: ['collapse', 'entity', 'term', 'route', 'agenda-day-block', 'agenda-abstract', 'agenda-tip-toggle', 'checklist-fold'],
    summary: ['agenda-day-summary', 'agenda-tip-btn', 'checklist-fold-summary'],
  },
  transformTags: {
    /**
     * `tabindex="0"` 看着是多余的（链接本来就能 Tab 到），但**别删**：
     * Safari 默认不把链接放进 Tab 序列（要手动开「按 Tab 键高亮网页上的每一项」），
     * 加上它链接才进得了焦点序列——这是 WebAIM 给的办法。
     * 实测：WebKit 下 14 次 Tab，链接 0 次；加上后正常。
     * 在别的引擎上它什么都不改变（0 = 保持自然顺序）。
     */
    a: (tagName, attribs) => {
      const href = attribs.href ?? '';
      const external = /^https?:\/\//i.test(href);
      return {
        tagName,
        attribs: {
          ...attribs,
          tabindex: '0',
          ...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
        },
      };
    },
    img: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, loading: 'lazy' },
    }),
  },
};

/** 清单项的复选框先渲染成一个哨兵，等 listitem 知道 id 了再换成真正的 input。 */
const TASK_SENTINEL = '\u0000TASK\u0000';

/** 渲染过程中的共享状态。 */
interface RenderContext {
  /** 目录；null 表示这一轮不收目录（折叠块内部）。 */
  toc: TocEntry[] | null;
  /** 当前所在的二级章节（用来判断要不要收成条目）。跨段保留。 */
  section: string;
  /** 标题 id 去重表，跨段共享。 */
  seen: Map<string, number>;
  /** 复选框 id 去重表，跨段共享。 */
  checkIds: Map<string, number>;
  /**
   * 换行要不要当硬换行（`<br>`）。
   * 正文一律 false（Markdown 的规矩）；只有「最重要的 3 件事」用 true——
   * 那里每一行就是一件独立的事，折成一坨等于把编号写进同一段里。
   */
  breaks: boolean;

}

/** 渲染 Markdown 正文，返回安全 HTML 与目录。 */
export function renderMarkdown(source: string): RenderedMarkdown {
  const toc: TocEntry[] = [];
  const ctx: RenderContext = {
    toc,
    section: '',
    seen: new Map(),
    checkIds: new Map(),
    breaks: false,
  };
  const raw = renderSegments(splitSegments(source), ctx);
  return { html: sanitize(raw), toc };
}

/**
 * 只渲染一段 Markdown（用于「最重要的 3 件事」这类小段）。
 *
 * `breaks: true` 时源码里的换行是硬换行：那一节的每一行都是一件独立的事，
 * 按标准 Markdown 折成一段会把「3 件事」显示成一坨连续文字。
 */
export function renderInlineMarkdown(source: string, options: { breaks?: boolean } = {}): string {
  const ctx: RenderContext = {
    toc: null,
    section: '',
    seen: new Map(),
    checkIds: new Map(),
    breaks: options.breaks === true,
  };
  return sanitize(renderSegments(splitSegments(source), ctx));
}

/**
 * 字段值里的内联 Markdown：渲染成 HTML，但去掉包在外面的段落。
 *
 * ⚠️ 多段落降级成 `<br>`：外层已经有一个 `<p>` 了，再套一层 `<p>` 是非法 HTML，
 *    浏览器会自动闭合，版面就乱了。
 */
export function renderInlineValue(value: string): string {
  return renderInlineMarkdown(value)
    .replace(/^\s*<p>/, '')
    .replace(/<\/p>\s*$/, '')
    .replace(/<\/p>\s*<p>/g, '<br>')
    .trim();
}

function createMarked(ctx: RenderContext): Marked {
  return new Marked({
    gfm: true,
    breaks: ctx.breaks,
    renderer: {
      heading(token: { tokens: unknown[]; depth: number; text: string }) {
        const tokens = token.tokens as never[];
        const inner = this.parser.parseInline(tokens) as string;
        const plain = htmlToPlain(inner) || htmlToPlain(token.text);
        const id = uniqueId(ctx.seen, slugify(plain));
        if (ctx.toc && token.depth >= 2 && token.depth <= 3) {
          ctx.toc.push({ id, text: plain, depth: token.depth });
        }
        return `<h${token.depth} id="${escapeHtml(id)}">${inner}</h${token.depth}>\n`;
      },
      /**
       * 清单项（`- [ ]`）要能真的打勾，所以这里把 marked 默认的
       * `disabled` 复选框换成带稳定 id 的可交互复选框。
       * id 由**条目文字**哈希而来：内容不改，浏览器里存的勾就还在。
       */
      listitem(token: { text?: string; tokens: Token[]; task?: boolean; checked?: boolean }) {
        const body = this.parser.parse(token.tokens) as string;
        if (!token.task) {
          return `<li>${body}</li>\n`;
        }
        const base = hashText(token.text ?? '');
        const id = uniqueId(ctx.checkIds, base);
        const checked = token.checked ? ' checked' : '';

        // 紧凑列表的正文是裸文本，宽松列表的第一个段落包在 <p> 里
        let inner = body.replace(TASK_SENTINEL, '').replace(/^\s+/, '');
        let label = inner;
        let rest = '';
        const para = /^<p>([\s\S]*?)<\/p>([\s\S]*)$/.exec(inner);
        if (para) {
          label = (para[1] ?? '').trim();
          rest = para[2] ?? '';
        }
        return `<li class="task-item"><label><input type="checkbox" id="chk-${escapeHtml(id)}" data-check-id="${escapeHtml(id)}"${checked}> ${label}</label>${rest}</li>\n`;
      },
      /** 复选框先渲染成哨兵，等 listitem 知道 id 了再换成真正的 input。 */
      checkbox() {
        return TASK_SENTINEL;
      },
    },
  });
}

function uniqueId(counter: Map<string, number>, base: string): string {
  const count = counter.get(base) ?? 0;
  counter.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

function renderSegments(segments: Segment[], ctx: RenderContext): string {
  const marked = createMarked(ctx);
  const out: string[] = [];
  for (const seg of segments) {
    if (seg.type === 'text') {
      out.push(renderText(seg.content, marked, ctx));
      continue;
    }
    if (seg.type === 'agenda') {
      // ⚠️ 议程章节整段接管：产出的 HTML 直接进输出流，最后统一过一道消毒。
      //    日程各天的目录条目由 renderAgendaSection 追加，标题本身没走 heading 渲染器。
      out.push(renderAgendaSection(seg.content, ctx));
      continue;
    }
    // 折叠块内部的标题不进目录（这是原定的行为：目录只列页面级章节）
    const outerToc = ctx.toc;
    ctx.toc = null;
    const inner = renderSegments(splitSegments(seg.content), ctx);
    ctx.toc = outerToc;
    const open = /\bopen\b/i.test(seg.attrs ?? '') ? ' open' : '';
    out.push(`<details${open}>\n${inner}\n</details>\n`);
  }
  return out.join('');
}

/**
 * 议程章节：解析成场次 → 渲染成卡片 HTML。
 *
 * ⚠️ 这里出来的 HTML **不再过 marked**：段落里的缩进会被 Markdown 当成代码块，
 *    行首的 `<details>` 还会被重建（class 被丢）。卡片直接进输出流就好。
 *
 * ⚠️ 解析出错就抛出去：走既有的「页面渲染失败」路径（构建失败且不动产出目录），
 *    而不是渲染出一段空白。
 */
function renderAgendaSection(content: string, ctx: RenderContext): string {
  const parsed = parseAgenda(content);
  if (parsed.errors.length > 0) {
    throw new Error(`日程章节解析失败：${parsed.errors.join('；')}`);
  }
  // 议程每一天进目录：用跟正文标题同一套去重表生成稳定锚点 id，
  // 再把 id 传给渲染器，让每一天的 <details> 自己带上它（点目录能跳过去）。
  const dayIds = parsed.days.map((day) => uniqueId(ctx.seen, slugify(day.title)));
  if (ctx.toc) {
    for (let i = 0; i < parsed.days.length; i += 1) {
      const day = parsed.days[i];
      if (!day) continue;
      ctx.toc.push({ id: dayIds[i] ?? slugify(day.title), text: day.title, depth: 3, kind: 'agenda-day' });
    }
  }
  return renderAgenda(parsed.days, renderInlineValue, dayIds);
}

/**
 * 把文档切成三种段：普通文本、details 折叠块、**议程章节**。
 *
 * ⚠️ 议程章节整段交给议程渲染器，**不再经过 marked**。
 *    以前是把卡片 HTML 拼回源码再过引擎，引擎把它当源文本又解析了一遍：
 *    4 空格缩进变成代码块、行首 `<details>` 被重建（class 被丢）。
 */
function splitSegments(source: string): Segment[] {
  const out: Segment[] = [];
  for (const piece of carveAgendaSections(source)) {
    if (piece.type === 'agenda') {
      out.push(piece);
      continue;
    }
    out.push(...splitDetails(piece.content));
  }
  return out;
}

/**
 * 把 `## 日程` 这类章节整段切出来。
 * 标题行留在文本段里（目录要收得到它），章节正文单独成段。
 */
function carveAgendaSections(source: string): Segment[] {
  const out: Segment[] = [];
  const heading = /^#{1,2}[ \t]+(.+?)[ \t]*$/gm;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = heading.exec(source)) !== null) {
    if (variantForSection(match[1] ?? '') !== 'agenda') continue;
    const start = match.index + match[0].length;
    const rest = source.slice(start);
    const next = /^#{1,2}[ \t]/m.exec(rest);
    const end = start + (next ? next.index : rest.length);
    if (start > cursor) out.push({ type: 'text', content: source.slice(cursor, start) });
    out.push({ type: 'agenda', content: source.slice(start, end) });
    cursor = end;
    heading.lastIndex = end;
  }
  if (cursor < source.length) out.push({ type: 'text', content: source.slice(cursor) });
  return out;
}

/**
 * 渲染一段普通 Markdown。
 *
 * 先切成 token，再把「说明性章节」里的三级标题连同其下内容收成点开式条目。
 * 走 token 而不是走源码字符串，是因为 token 才知道哪些 `###` 真的在正文里
 * （代码块里的 `#` 不会被误认成标题）。
 */
function renderText(text: string, marked: Marked, ctx: RenderContext): string {
  const tokens = marked.lexer(text) as TokensList;
  const parts: Array<{ variant: 'plain' | 'entity' | 'term' | 'route' | 'checklist'; tokens: Token[] }> = [];
  let buf: Token[] = [];

  const flush = (): void => {
    if (buf.length > 0) {
      parts.push({ variant: 'plain', tokens: buf });
      buf = [];
    }
  };

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] as Token;

    if (token.type === 'heading' && token.depth === 2) {
      flush();
      ctx.section = headingPlain(token, marked);
      buf.push(token);
      i += 1;
      continue;
    }

    // 「行前清单」这一节：把标题之后的**整节正文**收进一个原生 <details>。
    // ⚠️ 到下一个二级标题就停（h2 本身不进折叠块，目录要收得到「行前清单」）；
    //    节里若有 ### 小标题也一起收进去，不漏掉。
    if (ctx.section === '行前清单') {
      const run: Token[] = [];
      let j = i;
      while (j < tokens.length) {
        const t = tokens[j] as Token;
        if (t.type === 'heading' && (t as Token & { depth: number }).depth <= 2) break;
        run.push(t);
        j += 1;
      }
      if (run.length > 0) {
        flush();
        parts.push({ variant: 'checklist', tokens: run });
        i = j;
        continue;
      }
    }

    if (token.type === 'heading' && token.depth === 3) {
      const variant = variantForSection(ctx.section);
      // ⚠️ 只有「说明性章节」才收成点开式条目。议程章节（agenda）在切段那一步
      //    就被整个接管了，正常走不到这里；留着这个判断是为了防御。
      if (variant === 'entity' || variant === 'term' || variant === 'route') {
        flush();
        // 这个标题 + 它下面直到下一个同级标题之间的内容 = 一个条目
        const group: Token[] = [token];
        let j = i + 1;
        while (j < tokens.length) {
          const next = tokens[j] as Token;
          if (next.type === 'heading' && next.depth <= 3) break;
          group.push(next);
          j += 1;
        }
        parts.push({ variant, tokens: group });
        i = j;
        continue;
      }
    }

    buf.push(token);
    i += 1;
  }
  flush();

  return parts
    .map((part) => {
      if (part.variant === 'plain') {
        return marked.parser(withLinks(part.tokens, tokens.links)) as string;
      }
      if (part.variant === 'checklist') {
        return renderChecklistFold(part.tokens, marked, tokens.links);
      }
      return renderCollapse(part.tokens, marked, part.variant, tokens.links, ctx);
    })
    .join('');
}

/**
 * 行前清单默认折叠：把这一节的正文收进一个原生 <details>。
 *
 * ⚠️ 折叠状态由浏览器端按活动存（eventprep:fold:<slug>:checklist），
 *    构建产出的 HTML 一律不带 open——刷新不闪，也不把「收起」写死在服务端。
 *    <summary> 里写清「展开清单」，读者一眼知道下面还有东西。
 */
function renderChecklistFold(
  group: Token[],
  marked: Marked,
  links: TokensList['links'],
): string {
  const body = marked.parser(withLinks(group, links)) as string;
  return `<details class="checklist-fold">
  <summary class="checklist-fold-summary">展开行前清单</summary>
  <div class="checklist-fold-body">${body}</div>
</details>`;
}

/**
 * 收成点开式条目：图标 + 名称 + 一行摘要，点开才是正文。
 *
 * 图标默认取名称的第一个字（中文名取首字，英文名取首字母）；
 * 名称以 emoji 开头时用那个 emoji 当图标（`### 🏢 某某科技`）。
 *
 * ⚠️ **「推荐路线」（route）默认展开**，而且是**服务端就写死 `open`**：
 *    推荐路线是全篇的产出，读者多半要读；而且折叠状态按活动存在本机
 *    （见 site.js 的 initRouteCollapse），读者手动收起后刷新仍然收着。
 *    与之相对，机构 / 术语条目默认收起——那些是「用到才看」的背景资料。
 */
function renderCollapse(
  group: Token[],
  marked: Marked,
  variant: 'entity' | 'term' | 'route',
  links: TokensList['links'],
  ctx: RenderContext,
): string {
  const heading = group[0] as Token & { text?: string };
  const bodyTokens = group.slice(1);

  const nameHtml = marked.parseInline(heading.text ?? '') as string;
  const plain = htmlToPlain(nameHtml);
  const { icon, consumed } = splitIcon(plain);
  // 名字开头的 emoji 已经被拿去做图标了，名字里不要再出现一次
  const displayName = consumed > 0 && nameHtml.startsWith(icon)
    ? nameHtml.slice(icon.length).replace(/^\s+/, '')
    : nameHtml;
  const bodyHtml = marked.parser(withLinks(bodyTokens, links)) as string;

  const bodyPlain = htmlToPlain(bodyHtml);
  // 正文本来就短的话，摘要就是正文本身，重复一遍没意义——只显示名称
  const teaser = bodyPlain.length > 60 ? teaserFrom(bodyPlain) : '';

  // id 要走同一套去重表：两个同名实体的 id 撞了，目录锚点会跳错、HTML 也不合法
  const id = uniqueId(ctx.seen, slugify(plain));
  // ⚠️ **推荐路线的每一条要进目录**：读者是按自己的角色找路线的
  //    （「我是做基建的，该看哪条？」），目录里没有就只剩整页滚。
  //    机构 / 术语条目不进目录——目录不该列一串嘉宾名。
  if (variant === 'route' && ctx.toc) {
    ctx.toc.push({ id, text: plain, depth: 3, kind: 'route' });
  }
  const open = variant === 'route' ? ' open' : '';
  // ⚠️ data-fold-key 是**稳定标识**：浏览器端用它记住这条是展开还是收起
  //    （存在本机，刷新后照旧）。别用显示文字当键——改了标题就读不到旧记录了。
  return `<details class="collapse ${variant}" id="${escapeHtml(id)}" data-fold-key="route-${escapeHtml(id)}"${open}>
  <summary>
    <span class="collapse-icon" aria-hidden="true">${escapeHtml(icon)}</span>
    <span class="collapse-text">
      <span class="collapse-name">${displayName}</span>${teaser ? `<span class="collapse-teaser">${escapeHtml(teaser)}</span>` : ''}
    </span>
    <span class="collapse-chevron" aria-hidden="true"></span>
  </summary>
  <div class="collapse-body">${bodyHtml}</div>
</details>`;
}

/** 名称开头的 emoji 拿来当图标，其余是名字。 */
function splitIcon(plain: string): { icon: string; consumed: number } {
  const chars = [...plain];
  const first = chars[0];
  if (!first) return { icon: '·', consumed: 0 };
  // 开头不是字母/数字（emoji、符号）就当图标用
  if (!/[\p{L}\p{N}]/u.test(first)) {
    return { icon: first, consumed: 1 };
  }
  return { icon: first, consumed: 0 };
}

/** 从正文里取一行摘要：取到第一个句号为止，太长就截断加省略号。 */
function teaserFrom(text: string, max = 46): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const slice = t.slice(0, max);
  const sentence = slice.match(/^(.*?[。！？!?；;])/);
  if (sentence?.[1]) return sentence[1];
  return `${slice.replace(/[，,、：:；;]$/, '')}…`;
}

function headingPlain(token: Token, marked: Marked): string {
  const text = (token as Token & { text?: string }).text ?? '';
  return htmlToPlain(marked.parseInline(text) as string);
}

/** 切片出来的 token 数组要保留 links，否则引用式链接解析不了。 */
function withLinks(tokens: Token[], links: TokensList['links']): TokensList {
  const list = tokens as TokensList;
  list.links = links;
  return list;
}

/**
 * 把文档切成「普通文本」与「details 块」两种段。
 * 只认行首的 `<details`（前面允许有空格），`</details>` 按嵌套配对。
 */
export function splitDetails(source: string): Segment[] {
  const segments: Segment[] = [];
  let textStart = 0;
  let i = 0;

  while (i < source.length) {
    const idx = source.indexOf('<details', i);
    if (idx === -1) break;

    const lineStart = source.lastIndexOf('\n', idx - 1) + 1;
    if (source.slice(lineStart, idx).trim() !== '') {
      i = idx + '<details'.length;
      continue;
    }

    const gt = source.indexOf('>', idx);
    if (gt === -1) break;
    const attrs = source.slice(idx + '<details'.length, gt);
    if (attrs.includes('<')) {
      i = idx + '<details'.length;
      continue;
    }

    const close = findClosingDetails(source, gt + 1);
    if (!close) {
      i = gt + 1;
      continue;
    }

    if (textStart < lineStart) {
      segments.push({ type: 'text', content: source.slice(textStart, lineStart) });
    }
    segments.push({ type: 'details', content: source.slice(gt + 1, close.start), attrs });
    i = close.end;
    textStart = i;
  }

  if (textStart < source.length) {
    segments.push({ type: 'text', content: source.slice(textStart) });
  }
  return segments;
}

/** 找到与已打开的 `<details>` 配对的 `</details>`（处理嵌套）。 */
function findClosingDetails(source: string, from: number): { start: number; end: number } | null {
  const tag = /<\/?details\b[^>]*>/gi;
  tag.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(source)) !== null) {
    if (match[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) {
        return { start: match.index, end: match.index + match[0].length };
      }
    } else {
      depth += 1;
    }
  }
  return null;
}

function sanitize(html: string): string {
  return decorateNote(sanitizeHtml(html, SANITIZE_OPTIONS));
}

/**
 * 注记标签升级成警示样式（还没定下来的那些）。
 *
 * ⚠️ 判据认「待……确认 / 待……公布 / 待定」，不是只认「待确认」三个字连写：
 *    写作细则给的示例就是 `主题待嘉宾确认`（见 writing-guide.md），
 *    按紧串匹配的话，同一个注记在细则里教人这么写、在页面上却不变色——
 *    一个正式活动页上 3 条「还没定」只有 1 条亮起来了。
 */
const UNRESOLVED_NOTE = /待[^，。；、<]{0,8}(?:确认|公布)|待定/;

function decorateNote(html: string): string {
  return html.replace(/<span class="note"[^>]*>[\s\S]*?<\/span>/g, (tag: string) => {
    if (!UNRESOLVED_NOTE.test(htmlToPlain(tag))) return tag;
    return tag.replace(/class="note"/, 'class="note note-warn"');
  });
}
/**
 * 取出正文开头那段引用块（「最重要的 3 件事」）。
 * 只认**正文第一段**就是引用块的情况；出现在中间的不动。
 *
 * 引用块里如果自己带了这个标签，剥掉——模板已经给这块起了「最重要的 3 件事」的标题，
 * 两处都写就成了同一句话说两遍。
 */
export function extractCallout(body: string): { callout: string | null; rest: string } {
  const trimmed = body.replace(/^\s+/, '');
  const match = /^((?:>[^\n]*(?:\n|$))+)/.exec(trimmed);
  const raw = match?.[1];
  if (raw === undefined) return { callout: null, rest: body };
  const lines = raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => l.replace(/^>\s?/, ''));
  if (lines.length === 0) return { callout: null, rest: body };
  const consumed = body.length - trimmed.length + raw.length;
  const text = lines.join('\n').replace(/^\s*\*\*\s*最重要的\s*[3三]\s*件事\s*\*\*\s*[:：]?\s*/, '');
  return { callout: text, rest: body.slice(consumed) };
}
