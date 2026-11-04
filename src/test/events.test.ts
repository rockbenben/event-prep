import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DirectoryProvider, isValidSlug, loadEvents, type EventProvider } from '../lib/events.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'event-prep-events-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeEvent(slug: string, front: string, body = '正文\n'): Promise<void> {
  const d = path.join(dir, slug);
  await mkdir(d, { recursive: true });
  await writeFile(path.join(d, 'event.md'), `---\n${front}\n---\n\n${body}`, 'utf8');
}

describe('isValidSlug', () => {
  it('接受小写字母、数字、连字符', () => {
    expect(isValidSlug('2026-11-ai-engineer')).toBe(true);
    expect(isValidSlug('devcon')).toBe(true);
    expect(isValidSlug('a1-b2')).toBe(true);
  });

  it('拒绝大写、下划线、中文、开头连字符', () => {
    expect(isValidSlug('DevCon')).toBe(false);
    expect(isValidSlug('dev_con')).toBe(false);
    expect(isValidSlug('开发大会')).toBe(false);
    expect(isValidSlug('-leading')).toBe(false);
    expect(isValidSlug('trailing-')).toBe(false);
    expect(isValidSlug('double--dash')).toBe(false);
  });
});

describe('DirectoryProvider + loadEvents', () => {
  it('只收有 event.md 的目录', async () => {
    await writeEvent('alpha', 'title: A');
    await writeEvent('beta', 'title: B');
    await mkdir(path.join(dir, 'not-an-event'), { recursive: true });
    await writeFile(path.join(dir, 'not-an-event', 'readme.txt'), 'x', 'utf8');
    await writeFile(path.join(dir, 'loose.md'), 'x', 'utf8');

    const events = await loadEvents(new DirectoryProvider(dir));
    expect(events.map((e) => e.slug).sort()).toEqual(['alpha', 'beta']);
  });

  it('目录名不合法会报错但不影响其它活动', async () => {
    await writeEvent('Alpha', 'title: A');
    await writeEvent('beta', 'title: B');
    const events = await loadEvents(new DirectoryProvider(dir));
    const alpha = events.find((e) => e.slug === 'Alpha');
    const beta = events.find((e) => e.slug === 'beta');
    expect(alpha?.errors.some((e) => e.includes('slug'))).toBe(true);
    expect(beta?.errors).toEqual([]);
  });

  it('内容有问题时错误被收集起来，事件照样读出来', async () => {
    await writeEvent('alpha', 'title: A\nstart: 不是日期');
    const events = await loadEvents(new DirectoryProvider(dir));
    expect(events).toHaveLength(1);
    expect(events[0]?.errors.some((e) => e.includes('start'))).toBe(true);
    expect(events[0]?.meta.title).toBe('A');
  });

  it('front matter 缺失会被指出来', async () => {
    await mkdir(path.join(dir, 'alpha'), { recursive: true });
    await writeFile(path.join(dir, 'alpha', 'event.md'), '没有 front matter\n', 'utf8');
    const events = await loadEvents(new DirectoryProvider(dir));
    expect(events[0]?.errors.some((e) => e.includes('front matter'))).toBe(true);
  });

  it('发现活动自带的资源目录', async () => {
    await writeEvent('alpha', 'title: A');
    await mkdir(path.join(dir, 'alpha', 'assets'), { recursive: true });
    await writeFile(path.join(dir, 'alpha', 'assets', 'map.png'), 'x', 'utf8');
    const events = await loadEvents(new DirectoryProvider(dir));
    expect(events[0]?.assetsDir).toContain('assets');
  });

  it('内容目录不存在时返回空，不报错', async () => {
    const events = await loadEvents(new DirectoryProvider(path.join(dir, 'missing')));
    expect(events).toEqual([]);
  });
});

describe('loadEvents · 日程章节的校验', () => {
  it('日程字段拼错 → 该活动带错误，不是静默忽略', async () => {
    await writeEvent(
      'bad-agenda',
      'title: 坏日程',
      '## 日程\n\n#### 09:45 · 一场\n- 形式: 讲座\n- 会场: 主会场\n',
    );
    const events = await loadEvents(new DirectoryProvider(dir));
    expect(events[0]?.errors.join(' ')).toContain('讲座');
  });

  it('头像文件不在 → error（发出去就是 404）', async () => {
    await writeEvent(
      'no-avatar',
      'title: 缺图',
      '## 日程\n\n#### 09:45 · 一场\n- 形式: 演讲\n- 会场: 主会场\n- 讲者: 张三 | 机构 | assets/speakers/gone.webp\n',
    );
    const events = await loadEvents(new DirectoryProvider(dir));
    expect(events[0]?.errors.join(' ')).toContain('assets/speakers/gone.webp');
  });

  it('头像在 assets/ 下真实存在 → 无错误', async () => {
    await mkdir(path.join(dir, 'ok-avatar', 'assets', 'speakers'), { recursive: true });
    await writeFile(path.join(dir, 'ok-avatar', 'assets', 'speakers', 'a.webp'), 'x', 'utf8');
    await writeEvent(
      'ok-avatar',
      'title: 有图',
      '## 日程\n\n#### 09:45 · 一场\n- 形式: 演讲\n- 会场: 主会场\n- 讲者: 张三 | 机构 | assets/speakers/a.webp\n',
    );
    const events = await loadEvents(new DirectoryProvider(dir));
    expect(events[0]?.errors).toEqual([]);
  });

  it('⚠️ 日程章节还是旧表格写法 → 报错，不让它被整段替换掉后静默空掉', async () => {
    await writeEvent(
      'legacy',
      'title: 旧写法',
      '## 日程\n\n| 时间 | 主题 |\n| --- | --- |\n| 09:45 | 甲 |\n',
    );
    const events = await loadEvents(new DirectoryProvider(dir));
    expect(events[0]?.errors.join(' ')).toContain('没有找到任何');
  });
});

describe('loadEvents · provider 接缝', () => {
  /** 目录 provider 造不出「两个同名」「读不出来」这两种情况，用桩 provider 测。 */
  function stub(items: Array<{ slug: string; body?: string; fail?: boolean }>): EventProvider {
    return {
      async discover() {
        return items.map((item) => ({
          slug: item.slug,
          origin: `stub:${item.slug}`,
          read: async () => {
            if (item.fail) throw new Error('磁盘坏了');
            return item.body ?? '---\ntitle: 示例\n---\n\n正文\n';
          },
        }));
      },
    };
  }

  it('两个活动同名要报错并点名', async () => {
    const events = await loadEvents(stub([{ slug: 'same' }, { slug: 'same' }]));
    expect(events).toHaveLength(2);
    expect(events[1]?.errors.some((e) => e.includes('重复'))).toBe(true);
    expect(events[0]?.errors.some((e) => e.includes('重复'))).toBe(false);
  });

  it('读不出来要报错，不能当成空内容', async () => {
    const events = await loadEvents(stub([{ slug: 'broken', fail: true }]));
    expect(events[0]?.errors.some((e) => e.includes('读取失败'))).toBe(true);
  });
});
