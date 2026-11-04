/**
 * 服务端与浏览器端必须用**同一套**状态与倒计时口径。
 *
 * 这两份实现是分开的（一个是 TS，一个是浏览器里的 JS），所以很容易改了一边忘了另一边。
 * 这个测试把浏览器脚本放进 vm 里跑起来，再拿它的输出跟服务端逐条比对。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { computeStatus, countdownText, resolveTiming } from '../lib/status.ts';

const CLIENT_JS = path.resolve(import.meta.dirname, '..', 'assets', 'site.js');

interface ClientApi {
  statusOf: (ev: { startISO: string | null; endISO: string | null }, now: number) => string;
  countdown: (ev: Record<string, unknown>, now: number) => string;
}

async function loadClient(): Promise<ClientApi> {
  const source = await readFile(CLIENT_JS, 'utf8');
  const sandbox: Record<string, unknown> = {
    console,
    Intl,
    Date,
    JSON,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    isNaN,
    parseInt,
    parseFloat,
    setInterval: () => 0,
    clearInterval: () => {},
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    document: {
      readyState: 'complete',
      documentElement: { getAttribute: () => null, setAttribute: () => {} },
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: 'site.js' });
  return (sandbox.window as { __eventPrep: ClientApi }).__eventPrep;
}

describe('服务端与浏览器端口径一致', () => {
  it('状态判定一致', async () => {
    const client = await loadClient();
    const cases = [
      { start: '2026-11-05', end: '2026-11-06', timezone: 'Asia/Shanghai' },
      { start: '2026-11-05', timezone: 'Asia/Shanghai' },
      { start: '2026-03-08', timezone: 'America/New_York' },
      { start: '2026-12-30', end: '2027-01-02', timezone: 'Asia/Shanghai' },
    ];
    const moments = [
      '2026-11-04T15:59:59.000Z',
      '2026-11-04T16:00:00.000Z',
      '2026-11-05T12:00:00.000Z',
      '2026-11-06T16:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ];

    for (const c of cases) {
      const timing = resolveTiming(c);
      for (const m of moments) {
        const now = new Date(m);
        expect(client.statusOf(timing, now.getTime())).toBe(computeStatus(timing, now));
      }
    }
  });

  it('坏的时间戳两边都判成 unknown', async () => {
    const client = await loadClient();
    const broken = {
      startISO: 'not-a-date',
      endISO: null,
      timezone: 'UTC',
      timezoneKnown: false,
      days: null,
      start: null,
      end: null,
      startMinute: null,
    };
    const now = new Date('2026-11-05T12:00:00.000Z');
    expect(computeStatus(broken, now)).toBe('unknown');
    expect(client.statusOf(broken, now.getTime())).toBe('unknown');
  });

  it('倒计时文案一致', async () => {
    const client = await loadClient();
    const cases = [
      { start: '2026-11-05', end: '2026-11-07', timezone: 'Asia/Shanghai' },
      { start: '2026-11-05', timezone: 'Asia/Shanghai' },
      { start: '2026-03-08', end: '2026-03-09', timezone: 'America/New_York' },
      // ⚠️ 负偏移时区、多日、且正处于「进行中」——这一档以前两边会差一天
      { start: '2026-11-05', end: '2026-11-06', timezone: 'America/New_York' },
      { start: '2026-11-05', end: '2026-11-08', timezone: 'America/Chicago' },
      { start: '2026-11-05', end: '2026-11-06', timezone: 'Pacific/Auckland' },
    ];
    const moments = [
      '2026-11-04T16:00:00.000Z',
      '2026-11-05T04:00:00.000Z',
      '2026-11-05T12:00:00.000Z',
      // 纽约当地已经是 11 月 6 日（负偏移，UTC 还没过完 11 月 5 日）
      '2026-11-06T10:00:00.000Z',
      '2026-11-07T16:00:00.000Z',
      '2026-11-08T20:00:00.000Z',
    ];

    for (const c of cases) {
      const timing = resolveTiming(c);
      const payload = {
        startISO: timing.startISO,
        endISO: timing.endISO,
        timezone: timing.timezone,
        days: timing.days,
        start: timing.start,
      };
      for (const m of moments) {
        const now = new Date(m);
        expect(client.countdown(payload, now.getTime()), `${c.timezone} @ ${m}`).toBe(countdownText(timing, now));
      }
    }
  });

  it('议程推出的真实起止时刻，两边也一致', async () => {
    const client = await loadClient();
    // ⚠️ 开始时刻锚到议程首场（08:30 签到）之后，两边的「即将开始 / 进行中」
    //    分界线就跟着挪了——浏览器端只认 startISO，所以这里要盯住
    //    「分界线前后一秒」这种最容易差一档的时刻。
    const cases = [
      {
        start: '2026-11-05',
        end: '2026-11-06',
        timezone: 'Asia/Shanghai',
        dayStartMinutes: [510, 600],
        dayEndMinutes: [1070, 1070],
      },
      {
        start: '2026-11-05',
        timezone: 'Asia/Shanghai',
        dayStartMinutes: [510],
        dayEndMinutes: [1070],
      },
      {
        start: '2026-03-08',
        end: '2026-03-09',
        timezone: 'America/New_York',
        dayStartMinutes: [510, 600],
        dayEndMinutes: [1070, 1070],
      },
    ];
    const moments = [
      '2026-11-04T12:00:00.000Z',
      '2026-11-05T00:29:59.000Z',
      '2026-11-05T00:30:00.000Z',
      '2026-11-05T12:00:00.000Z',
      '2026-11-06T09:50:00.000Z',
      '2026-11-06T09:50:01.000Z',
      '2026-11-07T16:00:00.000Z',
    ];

    for (const c of cases) {
      const timing = resolveTiming(c);
      const payload = {
        startISO: timing.startISO,
        endISO: timing.endISO,
        timezone: timing.timezone,
        days: timing.days,
        start: timing.start,
      };
      for (const m of moments) {
        const now = new Date(m);
        expect(client.statusOf(payload, now.getTime()), `${c.timezone} @ ${m}`).toBe(computeStatus(timing, now));
        expect(client.countdown(payload, now.getTime()), `${c.timezone} @ ${m}`).toBe(countdownText(timing, now));
      }
    }
  });
});
