import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { buildSite } from '../lib/build.ts';
it('raw 原件经 Git 入库、检出和站点下载后字节一致', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'eventprep-git-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
    git('init', '-q');
    await writeFile(path.join(root, '.gitattributes'), await readFile(path.resolve('.gitattributes')));
    const dir = path.join(root, 'content/demo');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'event.md'), '---\ntitle: Demo\n---\n');
    const raw = Buffer.from('\uFEFFEnglish\r\n中文\r\n');
    const file = path.join(dir, '20261105-raw.md');
    await writeFile(file, raw);
    git('add', '.');
    await rm(file);
    git('checkout-index', '-a', '-f');
    expect(await readFile(file)).toEqual(raw);
    const out = path.join(root, 'dist');
    expect((await buildSite({ contentDir: path.join(root, 'content'), outDir: out })).ok).toBe(true);
    expect(await readFile(path.join(out, 'demo/20261105-raw.md'))).toEqual(raw);
  } finally { await rm(root, { recursive: true, force: true }); }
});
