import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { replaceOutput } from '../lib/output.ts';
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
let root: string;
let out: string;
let content: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'eventprep-output-'));
  out = path.join(root, 'dist'); content = path.join(root, 'content');
  await mkdir(content);
});
afterEach(async () => { vi.mocked(rename).mockRestore(); await rm(root, { recursive: true, force: true }); });
async function build(text: string) {
  await replaceOutput(out, content, path.resolve('.'), stage => writeFile(path.join(stage, 'index.html'), text));
}
it('暂存写入失败和最终切换失败都恢复完整旧站', async () => {
  await build('old');
  await expect(replaceOutput(out, content, path.resolve('.'), async stage => {
    await writeFile(path.join(stage, 'index.html'), 'partial'); throw new Error('copy failed');
  })).rejects.toThrow('copy failed');
  expect(await readFile(path.join(out, 'index.html'), 'utf8')).toBe('old');
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (String(from).includes('.eventprep-stage-')) throw new Error('switch failed');
    return actual.rename(from, to);
  });
  await expect(build('new')).rejects.toThrow('switch failed');
  expect(await readFile(path.join(out, 'index.html'), 'utf8')).toBe('old');
});
it('同一输出目录的第二个构建拒绝运行', async () => {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const first = replaceOutput(out, content, path.resolve('.'), async stage => {
    started(); await wait; await writeFile(path.join(stage, 'index.html'), 'first');
  });
  await ready;
  await expect(build('second')).rejects.toThrow('已有构建');
  release(); await first;
  expect(await readFile(path.join(out, 'index.html'), 'utf8')).toBe('first');
});
it('切换中断后下次恢复备份再完成构建', async () => {
  await build('old');
  await rename(out, out + '.eventprep-backup');
  await build('new');
  expect(await readFile(path.join(out, 'index.html'), 'utf8')).toBe('new');
});
it('输出目录与输入目录嵌套或经联接指向输入都拒绝', async () => {
  await expect(replaceOutput(path.join(content, 'dist'), content, path.resolve('.'), async () => {})).rejects.toThrow('里面');
  await symlink(content, path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(replaceOutput(path.join(root, 'alias'), content, path.resolve('.'), async () => {})).rejects.toThrow('链接');
});

it('空目录首次接管后可以连续重建', async () => {
  await mkdir(out);
  await build('first');
  await build('second');
  await build('third');
  expect(await readFile(path.join(out, 'index.html'), 'utf8')).toBe('third');
});

it('进程在暂存时退出，下一次构建回收死进程锁且保留旧站', async () => {
  await build('old');
  const moduleUrl = pathToFileURL(path.resolve('src/lib/output.ts')).href;
  const script = `import { replaceOutput } from ${JSON.stringify(moduleUrl)};
    await replaceOutput(${JSON.stringify(out)}, ${JSON.stringify(content)}, ${JSON.stringify(path.resolve('.'))}, async () => { process.exit(0); });`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script]);
  expect(await readFile(path.join(out, 'index.html'), 'utf8')).toBe('old');
  await build('recovered');
  expect(await readFile(path.join(out, 'index.html'), 'utf8')).toBe('recovered');
});
