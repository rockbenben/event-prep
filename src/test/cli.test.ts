/**
 * 命令行的回归测试。
 *
 * 这两个 bug 都是命令行独有的，库层测试覆盖不到：
 *   · `new-event --title "Cost $& Price"` —— 标题里的 $ 被当成反向引用，front matter 被改坏
 *   · 预览服务器遇到畸形 URL —— decodeURIComponent 抛错，整个进程退出
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseFrontMatter } from '../lib/frontmatter.ts';
import { PROJECT_ROOT } from '../lib/build.ts';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(ROOT, 'src', 'cli.ts');

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'event-prep-cli-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('new-event', () => {
  it('生成骨架，标题原样写进去', async () => {
    const contentDir = path.join(workDir, 'content');
    await execFileAsync(process.execPath, [
      CLI, 'new-event', '2026-11-example', '--title', '示例大会 2026', '--content', contentDir,
    ]);

    const file = path.join(contentDir, '2026-11-example', 'event.md');
    const content = await readFile(file, 'utf8');
    const parsed = parseFrontMatter(content);
    expect(parsed.error).toBeNull();
    expect(parsed.data.title).toBe('示例大会 2026');
  });

  it('标题里有 $ 也不会被改坏（$& 与 $` 是反向引用）', async () => {
    const contentDir = path.join(workDir, 'content');
    const title = 'Cost $& Price and $100 `tick`';
    await execFileAsync(process.execPath, [
      CLI, 'new-event', '2026-11-dollar', '--title', title, '--content', contentDir,
    ]);

    const content = await readFile(path.join(contentDir, '2026-11-dollar', 'event.md'), 'utf8');
    const line = content.split('\n').find((l) => l.startsWith('title:'));
    expect(line).toBe(`title: ${JSON.stringify(title)}`);
  });

  it('标题里有冒号或井号也写出合法的 YAML（裸写会让解析失败或把标题当注释）', async () => {
    const contentDir = path.join(workDir, 'content');
    for (const [slug, title] of [
      ['2026-11-colon', 'DevConf: Frontend 2026'],
      ['2026-11-hash', '#2026 AI 大会'],
    ] as const) {
      await execFileAsync(process.execPath, [
        CLI, 'new-event', slug, '--title', title, '--content', contentDir,
      ]);
      const content = await readFile(path.join(contentDir, slug, 'event.md'), 'utf8');
      const parsed = parseFrontMatter(content);
      expect(parsed.error, `${title} 写出的 front matter 应当能解析`).toBeNull();
      expect(parsed.data.title).toBe(title);
    }
  });

  it('slug 不合法时拒绝并返回非零退出码', async () => {
    const contentDir = path.join(workDir, 'content');
    await expect(
      execFileAsync(process.execPath, [
        CLI, 'new-event', 'Bad_Slug', '--content', contentDir,
      ]),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('已存在时拒绝，除非给 --force', async () => {
    const contentDir = path.join(workDir, 'content');
    await execFileAsync(process.execPath, [
      CLI, 'new-event', '2026-11-dup', '--title', '第一次', '--content', contentDir,
    ]);

    await expect(
      execFileAsync(process.execPath, [
        CLI, 'new-event', '2026-11-dup', '--title', '第二次', '--content', contentDir,
      ]),
    ).rejects.toMatchObject({ code: 1 });

    await execFileAsync(process.execPath, [
      CLI, 'new-event', '2026-11-dup', '--title', '第二次', '--content', contentDir, '--force',
    ]);
    const content = await readFile(path.join(contentDir, '2026-11-dup', 'event.md'), 'utf8');
    expect(parseFrontMatter(content).data.title).toBe('第二次');
  });

  it('`--flag=value` 写法认得（以前会被当成一个叫 "out=dist" 的开关，值丢掉）', async () => {
    const outDir = path.join(workDir, 'dist-eq');
    const contentDir = path.join(workDir, 'content');
    await execFileAsync(process.execPath, [
      CLI, 'build', `--out=${outDir}`, `--content=${contentDir}`,
    ]);
    expect(existsSync(path.join(outDir, 'index.html'))).toBe(true);
  });
});

describe('check', () => {
  it('好内容退出码 0，且不产出站点', async () => {
    const contentDir = path.join(workDir, 'content');
    await execFileAsync(process.execPath, [
      CLI, 'new-event', '2026-11-good', '--title', '好的活动', '--content', contentDir,
    ]);
    const { stdout } = await execFileAsync(process.execPath, [
      CLI, 'check', '--content', contentDir,
    ]);
    expect(stdout).toContain('数据都没问题');
    expect(existsSync(path.join(PROJECT_ROOT, '.check-out'))).toBe(false);
  });

  it('坏内容退出码 1', async () => {
    const contentDir = path.join(workDir, 'content');
    await mkdir(path.join(contentDir, '2026-11-bad'), { recursive: true });
    await writeFile(
      path.join(contentDir, '2026-11-bad', 'event.md'),
      '---\ntitle: 坏的活动\nstart: 不是日期\n---\n\n正文\n',
      'utf8',
    );
    await expect(
      execFileAsync(process.execPath, [CLI, 'check', '--content', contentDir]),
    ).rejects.toMatchObject({ code: 1 });
  });
});

describe('build', () => {
  it('SITE_URL 环境变量能定下 canonical（部署工作流就靠它）', async () => {
    const outDir = path.join(workDir, 'dist-env');
    await execFileAsync(process.execPath, [CLI, 'build', '--out', outDir, '--content', path.join(workDir, 'empty')], {
      env: { ...process.env, SITE_URL: 'https://example.org/prep/' },
    });
    const home = await readFile(path.join(outDir, 'index.html'), 'utf8');
    expect(home).toContain('<link rel="canonical" href="https://example.org/prep/">');
  });
});

describe('export', () => {
  it('把活动的内容原样打到标准输出', async () => {
    const contentDir = path.join(workDir, 'content');
    const source = '---\ntitle: 活动一\nstart: 2026-11-05\n---\n\n## 速览\n\n正文\n';
    await mkdir(path.join(contentDir, '2026-11-one'), { recursive: true });
    await writeFile(path.join(contentDir, '2026-11-one', 'event.md'), source, 'utf8');

    const { stdout } = await execFileAsync(process.execPath, [
      CLI, 'export', '2026-11-one', '--content', contentDir,
    ]);
    expect(stdout).toBe(source);
  });

  it('导出的是源文件，不是渲染结果（能塞回 content/ 才算数）', async () => {
    const contentDir = path.join(workDir, 'content');
    await mkdir(path.join(contentDir, '2026-11-one'), { recursive: true });
    await writeFile(
      path.join(contentDir, '2026-11-one', 'event.md'),
      '---\ntitle: 活动一\nvenue_url: https://example.org/venue\n---\n\n## 速览\n\n正文\n',
      'utf8',
    );

    const { stdout } = await execFileAsync(process.execPath, [
      CLI, 'export', '2026-11-one', '--content', contentDir,
    ]);
    // front matter 原样在：塞回 content/ 才能更新页面
    expect(stdout).toContain('venue_url: https://example.org/venue');
    expect(stdout.startsWith('---')).toBe(true);
    // 没有渲染出来的东西（HTML 标签）
    expect(stdout).not.toContain('<h2');
  });

  it('活动不存在时给非零退出码和现有活动名单', async () => {
    const contentDir = path.join(workDir, 'content');
    await mkdir(path.join(contentDir, '2026-11-one'), { recursive: true });
    await writeFile(path.join(contentDir, '2026-11-one', 'event.md'), '---\ntitle: 活动一\n---\n', 'utf8');

    const err = (await execFileAsync(process.execPath, [
      CLI, 'export', '2026-11-nope', '--content', contentDir,
    ]).catch((e) => e)) as { code: number; stderr: string };
    expect(err.code).toBe(1);
    expect(err.stderr).toContain('没有找到活动');
    expect(err.stderr).toContain('2026-11-one');
  });

  it('不给 slug 时给用法说明，不默默导出别的东西', async () => {
    const err = (await execFileAsync(process.execPath, [
      CLI, 'export', '--content', path.join(workDir, 'empty'),
    ]).catch((e) => e)) as { code: number; stderr: string };
    expect(err.code).toBe(1);
    expect(err.stderr).toContain('用法');
  });
});

/**
 * 起一个预览服务器并等它把实际端口打印出来。
 * `--port 0` 让系统分空闲端口：自己挑固定端口会跟别的服务撞，
 * 「等服务器起来」也会变成一场竞态（这条测试本来就偶发失败过）。
 */
async function startPreview(outDir: string): Promise<{ port: number; kill: () => void }> {
  const child = spawn(process.execPath, [CLI, 'preview', '--out', outDir, '--port', '0'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += String(d); });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const matched = /http:\/\/localhost:(\d+)\//.exec(stdout);
    if (matched?.[1]) {
      return { port: Number(matched[1]), kill: () => child.kill() };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`预览服务器没起来：${stdout}`);
}

async function buildEmptyDist(name: string): Promise<string> {
  const outDir = path.join(workDir, name);
  await execFileAsync(process.execPath, [
    CLI, 'build', '--out', outDir, '--content', path.join(workDir, 'empty'),
  ]);
  return outDir;
}

describe('preview', () => {
  it('畸形 URL 打不挂服务器（以前 decodeURIComponent 抛错会让整个进程退出）', async () => {
    const { port, kill } = await startPreview(await buildEmptyDist('dist'));
    try {
      const bad = await fetch(`http://localhost:${port}/%`);
      expect(bad.status).toBe(400);

      // 服务器还活着
      const after = await fetch(`http://localhost:${port}/`);
      expect(after.status).toBe(200);
    } finally {
      kill();
    }
  }, 30000);

  it('缺的资源如实 404，不拿首页冒充（以前坏链接在本地预览里看着是好的）', async () => {
    const outDir = await buildEmptyDist('dist');
    const { port, kill } = await startPreview(outDir);
    try {
      // 样式名带内容哈希，所以从产物目录里读出真实名字再取
      const assets = await readdir(path.join(outDir, 'assets'));
      const cssName = assets.find((f) => f.endsWith('.css'));
      expect(cssName).toBeTruthy();
      const css = await fetch(`http://localhost:${port}/assets/${cssName}`);
      expect(css.status).toBe(200);
      expect(css.headers.get('content-type')).toContain('text/css');

      // 挑一个构建产物里不可能存在的名字：拿 og-image.png 当例子的话，
      // 图一旦补上，这条测试就会因为「不该有的理由」变红
      const missingImage = await fetch(`http://localhost:${port}/assets/no-such-file.css`);
      expect(missingImage.status).toBe(404);
      expect(await missingImage.text()).not.toContain('<!DOCTYPE html>');

      const missingPage = await fetch(`http://localhost:${port}/no-such-event/`);
      expect(missingPage.status).toBe(404);
    } finally {
      kill();
    }
  }, 30000);

  it('不伺服 dist/ 外面的文件（路径守卫要用相对路径判断，不能用字符串前缀）', async () => {
    const outDir = await buildEmptyDist('dist');
    // dist 旁边放一个「看起来在 dist 里、其实不在」的文件
    const sibling = path.join(workDir, 'dist-evil');
    await mkdir(sibling, { recursive: true });
    await writeFile(path.join(sibling, 'secret.txt'), '不该被伺服出去', 'utf8');

    const { port, kill } = await startPreview(outDir);
    try {
      const escaped = await fetch(`http://localhost:${port}/../dist-evil/secret.txt`);
      const body = await escaped.text();
      expect(body).not.toContain('不该被伺服出去');
    } finally {
      kill();
    }
  }, 30000);

  it('--port 不是数字时给人话，而不是一坨原始堆栈', async () => {
    const outDir = await buildEmptyDist('dist');
    const err = (await execFileAsync(process.execPath, [
      CLI, 'preview', '--out', outDir, '--port', 'abc',
    ]).catch((e) => e)) as { code: number; stderr: string };
    expect(err.code).toBe(1);
    expect(err.stderr).toContain('--port');
  });
});

describe('build --out 守卫', () => {
  it('产出目录里装着别人的东西时拒绝动手，那些文件一个都不掉', async () => {
    // 就是 `npm run build -- --out .` 那一类写法：以前会连 package.json 一起 rm -rf
    const target = path.join(workDir, 'not-a-dist');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'package.json'), '{}', 'utf8');

    const err = (await execFileAsync(process.execPath, [
      CLI, 'build', '--out', target, '--content', path.join(workDir, 'empty'),
    ]).catch((e) => e)) as { code: number; stdout: string };

    expect(err.code).toBe(1);
    expect(err.stdout).toContain('不属于构建产物');
    expect(existsSync(path.join(target, 'package.json'))).toBe(true);
  });
});
