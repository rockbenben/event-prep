/** 输出目录归属、并发互斥及可恢复的目录切换。 */
import { lstat, readdir, readFile, writeFile, mkdir, rename, rm, realpath, mkdtemp } from 'node:fs/promises';
import path from 'node:path';

const MANIFEST = '.eventprep.json';
export async function inventory(dir: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    const full = path.join(dir, entry.name);
    if ((await lstat(full)).isSymbolicLink()) throw new Error(`拒绝链接或目录联接：${full}`);
    if (entry.isDirectory()) {
      files.push(relative + '/');
      files.push(...await inventory(full, relative + '/'));
    }
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`不支持的文件类型：${full}`);
  }
  return files.sort();
}
async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function resolved(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return path.join(await resolved(path.dirname(file)), path.basename(file));
  }
}
function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
async function assertOwned(dir: string): Promise<void> {
  if ((await lstat(dir)).isSymbolicLink()) throw new Error(`拒绝目录链接：${dir}`);
  const files = await inventory(dir);
  if (!files.length) return;
  let manifest: { producer?: string; files?: unknown } | null;
  try {
    manifest = JSON.parse(await readFile(path.join(dir, MANIFEST), 'utf8'));
  } catch {
    throw new Error(`产出目录里有不属于构建产物的东西或缺少归属清单，请使用新的空目录：${dir}`);
  }
  if (!manifest || manifest.producer !== 'EventPrep' || !Array.isArray(manifest.files)) {
    throw new Error(`无法识别产出归属清单：${dir}`);
  }
  const owned = new Set<unknown>([MANIFEST, 'CNAME', ...manifest.files]);
  if (files.some(file => !owned.has(file))) {
    throw new Error(`产出目录里有不属于构建产物的东西，拒绝动手：${dir}`);
  }
}

export async function replaceOutput(out: string, content: string, project: string, write: (stage: string) => Promise<void>): Promise<void> {
  if (await exists(out) && (await lstat(out)).isSymbolicLink()) throw new Error(`拒绝输出目录链接：${out}`);
  const target = await resolved(out);
  const source = await resolved(content);
  if (contains(target, source) || contains(source, target) || contains(target, await resolved(project))) {
    throw new Error('内容目录在产出目录里面，或产出目录在内容目录里面，或与仓库根重叠，拒绝动手。');
  }
  await mkdir(path.dirname(target), { recursive: true });
  const lock = target + '.eventprep-lock';
  try {
    await writeFile(lock, String(process.pid), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(await readFile(lock, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`无法识别构建锁：${lock}`);
    try {
      process.kill(pid, 0);
      throw new Error('同一产出目录已有构建运行。');
    } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe;
    }
    await rm(lock);
    await writeFile(lock, String(process.pid), { flag: 'wx' });
  }
  const backup = target + '.eventprep-backup';
  let stage: string | undefined;
  try {
    if (await exists(backup)) {
      await assertOwned(backup);
      if (!(await exists(target))) await rename(backup, target);
    }
    if (await exists(target)) await assertOwned(target);
    if (await exists(backup)) await rm(backup, { recursive: true });
    stage = await mkdtemp(target + '.eventprep-stage-');
    await write(stage);
    await writeFile(path.join(stage, MANIFEST), JSON.stringify({ producer: 'EventPrep', files: await inventory(stage) }));
    if (await exists(target)) await rename(target, backup);
    try {
      await rename(stage, target);
      stage = undefined;
    } catch (error) {
      if (await exists(backup)) await rename(backup, target);
      throw error;
    }
    // 上一版保留到下一次构建，可用于恢复切换中断或人工回滚。
  } finally {
    try {
      if (stage) await rm(stage, { recursive: true, force: true });
    } finally {
      await rm(lock, { force: true });
    }
  }
}
