/**
 * 抓官方讲者头像进活动自带资源目录，统一转成 200px 见方的 WebP。
 *
 * 为什么入库而不是热链：官方改一次路径，页面就是一堆 404，
 * 而验收那条「每个请求都拿到 2xx/3xx」只能拍到已经发出去的站点。
 * 图片是公开议程页上的讲者照片，出处写进 event.md 的「信息来源」。
 *
 * ⚠️ **要同时给议程页和讲者页**：圆桌/对谈类场次在议程页上 `speakers` 常常是空的
 *    （实测「AI 时代的社区」这场就是），只扫议程页会把这几位整场漏掉——
 *    页面上就出现「同一场里别人有头像自己没有」的不齐。
 *    讲者页是全量名单，议程页补的是讲者页没有的。
 *
 * 用法：node scripts/fetch-speakers.mjs --event 2026-11-ai-engineer-shanghai \
 *         --source https://ai.engineer/shanghai/2026/program,https://ai.engineer/shanghai/2026/speakers
 */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const eventSlug = arg('event');
// 多个来源页用逗号或空格分开
const sourceArg = arg('source');
if (!eventSlug || !sourceArg) {
  console.error('用法：node scripts/fetch-speakers.mjs --event <slug> --source <议程页 URL>[,<讲者页 URL>]');
  process.exit(1);
}
const sourceUrls = sourceArg
  .split(/[,\s]+/)
  .map((u) => u.trim())
  .filter(Boolean);

const outDir = path.join(ROOT, 'content', eventSlug, 'assets', 'speakers');
await mkdir(outDir, { recursive: true });

// 每个来源页的 origin 可能不同（官方 CDN 与站点同源，但别假设）
const refs = new Map();
for (const sourceUrl of sourceUrls) {
  const html = await fetchPage(sourceUrl);
  const origin = new URL(sourceUrl).origin;
  const found = [...html.matchAll(/<img[^>]+src="(\/shanghai\/speakers\/[^"]+)"/g)].map((m) => m[1]);
  console.log(`${sourceUrl} → ${found.length} 个头像引用`);
  for (const ref of found) refs.set(ref, origin + ref);
}
if (refs.size === 0) {
  console.error('页面里没找到 /shanghai/speakers/ 的头像——官方改版了，先确认结构再跑');
  process.exit(1);
}

let converted = 0;
for (const [ref, url] of refs) {
  // 文件名不带查询串：官方有一张是 `xxx.webp?v=20261101`，直接取 basename 会把查询串当文件名
  const name = path.basename(ref.split('?')[0]).replace(/\.(jpg|jpeg|png|webp)$/i, '');
  const target = path.join(outDir, `${name}.webp`);
  const raw = await fetchBuffer(url);
  if (raw.length === 0) {
    console.error(`跳过空响应：${ref}`);
    continue;
  }
  const tmp = path.join(outDir, `.tmp-${name}`);
  await writeFile(tmp, raw);
  try {
    // 200px 见方：卡片里显示 44–56px，2 倍屏够用；比原图（600–800px）省一个量级
    execFileSync(
      'ffmpeg',
      ['-y', '-i', tmp, '-vf', 'scale=200:200:force_original_aspect_ratio=decrease,pad=200:200:(ow-iw)/2:(oh-ih)/2', '-quality', '80', target],
      { stdio: 'ignore' },
    );
  } finally {
    // ⚠️ 临时文件必须删：留着会被 `git add assets/speakers` 一起提交进仓库
    await rm(tmp, { force: true });
  }
  converted += 1;
}

console.log(`头像：${refs.size} 个引用，${converted} 张转成 WebP → ${path.relative(ROOT, outDir)}/`);
console.log('下一步：把 event.md 的讲者行写成 assets/speakers/<name>.webp，缺图 npm run build 会拦。');

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (event-prep research)' } });
  if (!res.ok) throw new Error(`抓取失败 ${res.status} ${url}`);
  return res.text();
}
async function fetchBuffer(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (event-prep research)' } });
  if (!res.ok) throw new Error(`抓取失败 ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}
