/**
 * 站点构建：把 `content/` 下的活动汇总成一套静态站点。
 *
 * 失败策略（README 里也写了一份）：
 * · **默认严格**：任何活动的数据有错，构建就失败，不产出可发布的站点。
 *   坏数据不会被悄悄发到线上，也不会因为一个活动出错就把整站丢掉——
 *   上一次的部署还在线上，直到这一次构建成功为止。
 * · **失败（或拒绝动手）都不碰产出目录**：页面全部渲染成功、且产出目录确认只装
 *   构建产物之后，才清空重写。
 * · `--tolerant`：坏活动被跳过（并在报告里点名），其余活动照常构建。
 *   适合本地预览，不适合发布。
 */

import { access, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectoryProvider, EXPORT_FILE, loadEvents, type LoadedEvent } from './events.ts';
import { extractCallout, renderInlineMarkdown, renderMarkdown } from './markdown.ts';
import { renderLayout } from '../templates/layout.ts';
import { renderHome } from '../templates/home.ts';
import { renderEventPage, buildJsonLd } from '../templates/event.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `src/lib` → `src` → 仓库根 */
export const PROJECT_ROOT = path.resolve(HERE, '..', '..');

/** 社交分享用的预览图：`docs/images/` 里的原图，构建时跟着产物一起发出去。 */
const OG_IMAGE_FILE = 'og-image.png';

export interface BuildOptions {
  contentDir?: string;
  outDir?: string;
  siteUrl?: string;
  /** 坏活动跳过而不是让构建失败。 */
  tolerant?: boolean;
  /** 只校验不落盘（`npm run check` 用）。页面照样渲染，渲染出错照样报。 */
  dryRun?: boolean;
  /**
   * 分享卡图片的来源，默认 `docs/images/og-image.png`。
   * 测试要能分别验到「图在」和「图不在」两支，所以这个路径不能写死在实现里。
   */
  ogImageSource?: string;
}

export interface BuildResult {
  ok: boolean;
  /** 成功写出的活动 slug。 */
  built: string[];
  /** 因数据有错被跳过的活动 slug。 */
  skipped: string[];
  errors: string[];
  warnings: string[];
  outDir: string;
}

export async function buildSite(options: BuildOptions = {}): Promise<BuildResult> {
  const contentDir = path.resolve(options.contentDir ?? path.join(PROJECT_ROOT, 'content'));
  const outDir = path.resolve(options.outDir ?? path.join(PROJECT_ROOT, 'dist'));
  const tolerant = options.tolerant === true;

  const provider = new DirectoryProvider(contentDir);
  const events = await loadEvents(provider);

  const errors: string[] = [];
  const warnings: string[] = [];
  for (const ev of events) {
    for (const w of ev.warnings) warnings.push(`${ev.slug}: ${w}`);
    for (const e of ev.errors) errors.push(`${ev.slug}: ${e}`);
  }

  const broken = events.filter((ev) => ev.errors.length > 0);
  const usable = events.filter((ev) => ev.errors.length === 0);

  // ⚠️ 有活动数据不合法时**不碰产出目录**。
  //    否则会清空 dist/ 再写出一个缺了坏活动的半成品，而命令行又报「没有产出可发布的站点」——
  //    自相矛盾，手工发布 dist/ 的人就会把缺活动的站点发出去。
  //    上一次构建好的站点留在原地，直到这次构建成功为止。
  if (errors.length > 0 && !tolerant) {
    return {
      ok: false,
      built: [],
      skipped: broken.map((ev) => ev.slug),
      errors,
      warnings,
      outDir,
    };
  }

  const dryRun = options.dryRun === true;

  // 分享卡：图在不在盘上，同时决定「要不要把它复制进产物」和「要不要写 og:image」。
  // ⚠️ 两者必须同一个依据。以前 meta 照写、图缺失就静默不复制，于是部署出去的页面
  //    指着一条 404 —— 而浏览器不会替爬虫去抓 og:image，任何验收都看不见它。
  const ogSource = options.ogImageSource ?? path.join(PROJECT_ROOT, 'docs', 'images', OG_IMAGE_FILE);
  const ogBytes = await readFile(ogSource).catch(() => null);
  const ogImage = ogBytes ? OG_IMAGE_FILE : null;

  // ⚠️ 先把**所有页面渲染完**，再碰产出目录。
  //    以前 rm() 写在活动循环前面：数据校验拦不住的那类错误（模板抛异常、
  //    活动资源读不了）会在清空之后才发生，留下的就是一个半成品 dist，
  //    而「失败不动上一次产物」这个承诺只对数据错误成立。
  const pages: RenderedPage[] = [];
  const renderErrors: string[] = [];
  for (const ev of usable) {
    try {
      pages.push({
        slug: ev.slug,
        html: renderEventPageHtml(ev, options.siteUrl, ogImage),
        markdown: ev.source,
        assetsDir: ev.assetsDir,
      });
    } catch (err) {
      renderErrors.push(`${ev.slug}: 页面渲染失败：${(err as Error).message}`);
    }
  }

  let homeDocument = '';
  try {
    homeDocument = renderLayout({
      title: '行程准备站',
      description: '把各种活动的公开日程，整理成手机上随时能查的准备页。',
      rootPrefix: '',
      canonicalPath: '',
      siteUrl: options.siteUrl,
      ogImage,
      content: renderHome({ events: usable, siteUrl: options.siteUrl }),
    });
  } catch (err) {
    renderErrors.push(`首页渲染失败：${(err as Error).message}`);
  }

  if (renderErrors.length > 0) {
    return {
      ok: false,
      built: [],
      skipped: broken.map((ev) => ev.slug),
      errors: [...errors, ...renderErrors],
      warnings,
      outDir,
    };
  }

  if (!dryRun) {
    // 清空产出目录之前先问一遍它是不是「只装构建产物」的目录（见 disposalProblems）
    const problems = await disposalProblems(outDir, contentDir);
    if (problems.length > 0) {
      return {
        ok: false,
        built: [],
        skipped: broken.map((ev) => ev.slug),
        errors: [...errors, ...problems],
        warnings,
        outDir,
      };
    }

    // 产出目录先清空：删掉的活动不会留下残页
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    // 站点共享的样式与脚本
    await cp(path.join(PROJECT_ROOT, 'src', 'assets'), path.join(outDir, 'assets'), { recursive: true });
    if (ogBytes) await writeFile(path.join(outDir, OG_IMAGE_FILE), ogBytes);

    for (const page of pages) {
      const dir = path.join(outDir, page.slug);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'index.html'), page.html, 'utf8');
      // ⚠️ 活动页旁边再放一份内容源文件（Markdown）：
      //    页面底部有个下载链接，AI / 编辑器拿走它改完塞回 content/ 就能更新页面。
      //    放的是**源文件原文**，不是渲染出来的东西——倒过来写还原不回去。
      await writeFile(path.join(dir, EXPORT_FILE), page.markdown, 'utf8');
      // 活动自带的资源（地图、场地照片……）原样带过去
      if (page.assetsDir) {
        await cp(page.assetsDir, path.join(dir, 'assets'), { recursive: true });
      }
    }

    await writeFile(path.join(outDir, 'index.html'), homeDocument, 'utf8');
  }

  const built = usable.map((ev) => ev.slug);
  const skipped = broken.map((ev) => ev.slug);

  return {
    ok: errors.length === 0 || tolerant,
    built,
    skipped,
    errors,
    warnings,
    outDir,
  };
}

/** 一个已经渲染好的活动页（还没落盘）。 */
interface RenderedPage {
  slug: string;
  html: string;
  /** 随页一起发布的 Markdown 源文件内容。 */
  markdown: string;
  assetsDir?: string;
}

/**
 * 产出目录顶层允许出现的东西。
 *
 * ⚠️ 构建会 `rm(outDir, {recursive:true})`，所以清空前必须确认它**只装本工具的产物**。
 *    `npm run build -- --out .` 这种写法以前会把仓库根当产物目录删掉
 *    （实测：指向一个含 package.json 与 content/ 的临时目录，跑完两者都没了）。
 *    活动页目录是 slug 命名的，认不出名字，只认它里面有没有构建写出的 index.html。
 */
const ARTIFACT_ENTRIES = new Set(['index.html', 'assets', OG_IMAGE_FILE, 'CNAME']);

async function disposalProblems(outDir: string, contentDir: string): Promise<string[]> {
  const problems: string[] = [];
  if (outDir === PROJECT_ROOT) {
    problems.push(`产出目录不能是仓库根（${PROJECT_ROOT}）：构建会清空它，那等于删掉整个项目。`);
  }
  if (contentDir === outDir || contentDir.startsWith(outDir + path.sep)) {
    problems.push(`内容目录（${contentDir}）在产出目录里面：清空产出目录等于删掉内容。`);
  }

  const entries = await readdir(outDir, { withFileTypes: true }).catch(() => []);
  const foreign: string[] = [];
  for (const entry of entries) {
    if (ARTIFACT_ENTRIES.has(entry.name)) continue;
    if (entry.isDirectory() && (await pathExists(path.join(outDir, entry.name, 'index.html')))) continue;
    foreign.push(entry.name);
  }
  if (foreign.length > 0) {
    problems.push(
      `产出目录（${outDir}）里有不属于构建产物的东西：${foreign.join('、')}。` +
        '构建会先清空产出目录，所以拒绝动手——换一个目录（默认 dist/），或把那些文件挪走。',
    );
  }
  return problems;
}

/** 渲染一个活动页的完整 HTML（不落盘）。 */
function renderEventPageHtml(ev: LoadedEvent, siteUrl?: string, ogImage: string | null = null): string {
  const { callout, rest } = extractCallout(ev.body);
  const rendered = renderMarkdown(rest);
  const bodyHtml = makeRootRelative(rendered.html, '../');
  const calloutHtml = callout
    ? makeRootRelative(renderInlineMarkdown(callout, { breaks: true }), '../')
    : null;

  const page = renderEventPage({
    event: ev,
    bodyHtml,
    toc: rendered.toc,
    calloutHtml,
    siteUrl,
  });

  return renderLayout({
    title: `${ev.meta.title} · 行程准备站`,
    description: ev.meta.summary ?? `${ev.meta.title} 的行程与准备信息`,
    rootPrefix: '../',
    canonicalPath: `${ev.slug}/`,
    siteUrl,
    ogImage,
    jsonLd: buildJsonLd(ev),
    // 页头的「目录」按钮：有目录才给，没目录就别放一个点开是空的按钮
    showToc: rendered.toc.length > 0,
    content: page,
  });
}

/** 文件在不在（og:image 缺失时静默跳过，不让构建失败）。 */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把正文里的站内绝对路径（`/foo.png`）改成相对路径。
 * 站点挂在 `/<repo>/`（GitHub Pages 项目站）还是根路径，绝对路径都会指错地方。
 */
export function makeRootRelative(html: string, prefix: string): string {
  return html.replace(/\s(href|src)="\/(?!\/)([^"]*)"/g, (_m, attr: string, rest: string) => {
    return ` ${attr}="${prefix}${rest}"`;
  });
}
