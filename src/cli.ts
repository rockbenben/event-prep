/**
 * 命令行入口。
 *
 *   node src/cli.ts build [--out dist] [--content content] [--site-url URL] [--tolerant]
 *   node src/cli.ts check [--content content]
 *   node src/cli.ts new-event <slug> [--title 标题] [--force]
 *   node src/cli.ts export <slug> [--content content]
 *   node src/cli.ts preview [--port 4173] [--out dist]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs as parseNodeArgs } from 'node:util';
import { buildSite, PROJECT_ROOT } from './lib/build.ts';
import { DirectoryProvider, isValidSlug, loadEvents } from './lib/events.ts';

interface Args {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/**
 * 用 Node 自带的 parseArgs，不自己手写。
 * 手写的那版认不出 `--out=dist`（会当成一个叫 "out=dist" 的布尔开关，值被丢掉），
 * 而且多二十行代码要维护。
 * strict: false —— 不认识的开关仍然忽略，跟以前的脾气一样。
 */
const OPTIONS = {
  out: { type: 'string' },
  content: { type: 'string' },
  'site-url': { type: 'string' },
  port: { type: 'string' },
  engine: { type: 'string' },
  dist: { type: 'string' },
  title: { type: 'string' },
  tolerant: { type: 'boolean' },
  force: { type: 'boolean' },
} as const;

function parseArgs(argv: string[]): Args {
  const { values, positionals } = parseNodeArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: OPTIONS,
  });
  const flags: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) flags[key] = value;
  }
  return { command: positionals[0] ?? 'help', positionals: positionals.slice(1), flags };
}

function str(flags: Args['flags'], key: string, fallback: string): string {
  const value = flags[key];
  return typeof value === 'string' ? value : fallback;
}

function printReport(result: Awaited<ReturnType<typeof buildSite>>, verb: string): void {
  if (!result.ok) {
    console.log(`${verb}未完成：有错误，没有动产出目录。`);
  } else {
    console.log(`${verb}完成：${result.built.length} 个活动`);
    for (const slug of result.built) console.log(`  ✓ ${slug}`);
  }
  if (result.skipped.length) {
    console.log(`跳过（数据有错）：${result.skipped.length}`);
    for (const slug of result.skipped) console.log(`  ✗ ${slug}`);
  }
  if (result.warnings.length) {
    console.log(`提醒（${result.warnings.length}）`);
    for (const w of result.warnings) console.log(`  ! ${w}`);
  }
  if (result.errors.length) {
    console.log(`错误（${result.errors.length}）`);
    for (const e of result.errors) console.log(`  ✗ ${e}`);
  }
}

async function cmdBuild(args: Args): Promise<number> {
  // 站点根地址：命令行优先，其次环境变量（SITE_URL），都没有就不设 canonical
  const siteUrlFlag = typeof args.flags['site-url'] === 'string' ? args.flags['site-url'] : undefined;
  const siteUrl = siteUrlFlag ?? process.env.SITE_URL;

  const result = await buildSite({
    contentDir: str(args.flags, 'content', path.join(PROJECT_ROOT, 'content')),
    outDir: str(args.flags, 'out', path.join(PROJECT_ROOT, 'dist')),
    siteUrl,
    tolerant: args.flags.tolerant === true,
  });

  printReport(result, '构建');

  if (!result.ok) {
    console.error('\n构建失败：没有产出可发布的站点（上面逐条列了原因）。');
    console.error('上一次构建好的站点还在原处，不会被这次失败清掉。');
    console.error('修好上面的错误后重跑。（本地预览可以用 --tolerant 跳过坏活动，但不要拿它发布。）');
    return 1;
  }
  console.log(`产物目录：${result.outDir}`);
  return 0;
}

async function cmdCheck(args: Args): Promise<number> {
  const result = await buildSite({
    contentDir: str(args.flags, 'content', path.join(PROJECT_ROOT, 'content')),
    outDir: path.join(PROJECT_ROOT, '.check-out'),
    tolerant: true,
    dryRun: true,
  });
  printReport(result, '检查');
  if (result.errors.length) {
    console.error(`\n有 ${result.errors.length} 处数据错误。`);
    return 1;
  }
  console.log('\n数据都没问题。');
  return 0;
}

async function cmdNewEvent(args: Args): Promise<number> {
  const slug = args.positionals[0];
  if (!slug) {
    console.error('用法：node src/cli.ts new-event <slug> [--title 活动名称]');
    console.error('slug 只能用小写字母、数字和连字符，例如 2026-11-ai-engineer');
    return 1;
  }
  if (!isValidSlug(slug)) {
    console.error(`slug「${slug}」不合法：只允许小写字母、数字和连字符（如 2026-11-ai-engineer）。`);
    return 1;
  }

  const contentDir = str(args.flags, 'content', path.join(PROJECT_ROOT, 'content'));
  const dir = path.join(contentDir, slug);
  const file = path.join(dir, 'event.md');

  if (existsSync(file) && args.flags.force !== true) {
    console.error(`${file} 已存在。加 --force 覆盖。`);
    return 1;
  }

  await mkdir(dir, { recursive: true });
  const template = await readFile(path.join(PROJECT_ROOT, 'src', 'templates', 'event-template.md'), 'utf8');
  const title = str(args.flags, 'title', '活动名称');
  // 两件事：
  //  1. 用函数形式替换——字符串替换会把标题里的 $& / $` 当成反向引用。
  //  2. 用 JSON 字符串写进 YAML——活动名里有 ": " 或以 "#" 开头时，
  //     裸写会让 YAML 解析失败或把标题整行当注释（CLI 却报「已创建」）。
  const content = template.replace(/^title:.*$/m, () => `title: ${JSON.stringify(title)}`);

  await writeFile(file, content, 'utf8');
  console.log(`已创建 ${path.relative(process.cwd(), file)}`);
  console.log('接下来：把调研到的信息填进去，然后跑 `npm run check` 校验、`npm run build` 生成站点。');
  return 0;
}

/**
 * 把某个活动的内容导成 Markdown，打到标准输出。
 *
 * 导出的就是**源文件原文**（front matter + 正文），不是渲染结果——
 * 渲染结果倒过来写是还原不回去的，源文件塞回 content/ 才更新得了页面。
 * 所以这条命令的用途是「拿一份能改的 Markdown 给 AI 或编辑器」。
 */
async function cmdExport(args: Args): Promise<number> {
  const slug = args.positionals[0];
  if (!slug) {
    console.error('用法：node src/cli.ts export <slug>');
    console.error('把活动的内容导成 Markdown 打到标准输出（给 AI 或编辑器改）。');
    console.error('例：npm run export -- 2026-11-ai-engineer-shanghai > event.md');
    return 1;
  }

  const contentDir = str(args.flags, 'content', path.join(PROJECT_ROOT, 'content'));
  const events = await loadEvents(new DirectoryProvider(contentDir));
  const found = events.find((ev) => ev.slug === slug);
  if (!found) {
    console.error(`没有找到活动「${slug}」。`);
    console.error(`内容目录：${path.relative(process.cwd(), contentDir) || contentDir}`);
    console.error(`现有的活动：${events.map((ev) => ev.slug).join('、') || '（一个都没有）'}`);
    return 1;
  }

  // ⚠️ 必须等写完再退出：stdout 接管道时是异步的，
  //    process.exit 会把还没写出去的内容截断（导出就会少一截）。
  await new Promise<void>((resolve) => {
    process.stdout.write(found.source, () => resolve());
  });
  return 0;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

async function cmdPreview(args: Args): Promise<number> {
  const outDir = path.resolve(str(args.flags, 'out', path.join(PROJECT_ROOT, 'dist')));
  const portArg = str(args.flags, 'port', '4173');
  const port = Number(portArg);
  // 0 合法：让系统分一个空闲端口（测试靠它避开撞端口）。
  // 不校验的话 `--port abc` 会把一个 NaN 交给 listen()，用户看到的是一坨原始堆栈。
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`--port 要是一个 0–65535 的整数，收到的是「${portArg}」。`);
    return 1;
  }

  if (!existsSync(outDir)) {
    console.error(`没有找到 ${outDir}，先跑一次 npm run build。`);
    return 1;
  }

  const server = createServer(async (req, res) => {
    // URL 里的百分号编码坏了要挡住：decodeURIComponent 抛错会让整个进程退出，
    // 一个畸形 URL 就能把预览服务器打挂
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    let filePath = path.join(outDir, pathname);
    // 路径守卫要用「相对路径」判断，不能用字符串前缀：
    // path.join(outDir, '/../dist-evil/x') 规范化后是 dist-evil/x，
    // 它仍然以 outDir 开头，前缀判断会放行，把 dist/ 外面的文件也伺服出去。
    const relative = path.relative(outDir, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    // 目录式路径（没有扩展名）补上 index.html
    if (!path.extname(filePath)) {
      const indexed = path.join(filePath, 'index.html');
      if (existsSync(indexed)) filePath = indexed;
    }
    // ⚠️ 找不到就如实 404，**不要**回首页。
    //    以前缺什么都是 200 + 首页 HTML：坏掉的资源链接在本地预览里看起来是好的，
    //    验收也永远量不到 404（分享卡 og-image 缺图就是靠这个洞混过去的）。
    if (!existsSync(filePath)) {
      res.writeHead(404).end('not found');
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    res.end(body);
  });

  // 只绑本机回环：默认 listen 会绑所有网卡，等于把本地预览暴露给同网段的人。
  // port 传 0 = 让系统分一个空闲端口（测试用，免得撞端口）。
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const actual = typeof address === 'object' && address ? address.port : port;
    console.log(`本地预览：http://localhost:${actual}/`);
    console.log('（Ctrl+C 停止）');
  });
  // 服务会一直跑着，直到用户 Ctrl+C —— 不 return，否则主流程会把进程 exit 掉
  await new Promise<void>(() => {});
  return 0;
}

function cmdHelp(): number {
  console.log(`EventPrep · 构建工具

  build        构建静态站点（默认输出到 dist/）
    --out <dir>          输出目录
    --content <dir>      内容目录
    --site-url <url>     站点根地址（用于 canonical / og:url）
    --tolerant           跳过数据有错的活动（只适合本地预览）

  check        只校验内容，不产出站点

  new-event    新建一个活动骨架
    <slug>              只允许小写字母、数字和连字符
    --title <标题>
    --force              覆盖已存在的文件

  export       把活动的内容导成 Markdown（打到标准输出）
    <slug>              要导出的活动
    --content <dir>     内容目录

  preview      本地起一个静态服务器预览 dist/
    --port <n>`);
  return 0;
}

const args = parseArgs(process.argv.slice(2));

let code = 0;
switch (args.command) {
  case 'build':
    code = await cmdBuild(args);
    break;
  case 'check':
    code = await cmdCheck(args);
    break;
  case 'new-event':
    code = await cmdNewEvent(args);
    break;
  case 'export':
    code = await cmdExport(args);
    break;
  case 'preview':
    code = await cmdPreview(args);
    break;
  default:
    code = cmdHelp();
}

// ⚠️ 成功时**不**强制退出：stdout 可能还没写完（export 走管道时是异步的），
//    process.exit 会把没写出去的内容截断。让进程自然结束，退出码照样是 0。
process.exitCode = code;
if (code !== 0) process.exit(code);
