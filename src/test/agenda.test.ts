import { describe, expect, it } from 'vitest';
import {
  AGENDA_FORMATS,
  dayEndMinutes,
  dayStartMinutes,
  extractDayDate,
  locateAgendaSection,
  parseAgenda,
} from '../lib/agenda.ts';
import { renderInlineValue } from '../lib/markdown.ts';
import { renderAgenda } from '../templates/agenda.ts';

const ONE = `## 日程

### Day 1 · 11 月 5 日（周四）

#### 09:45–10:10 · 从模型到企业工作流
- 形式: 演讲
- 会场: 主会场
- 讲者: Marco Casalaina | 微软 | assets/speakers/marco.webp | 微软副总裁

## 行前清单
- [ ] 买票
`;

describe('dayStartMinutes / dayEndMinutes', () => {
  const TWO_DAYS = `### Day 1 · 11 月 5 日（周四）

#### 08:30–09:30 · 签到
- 形式: 签到

#### 09:30–10:00 · 开场致辞
- 形式: 开场
- 会场: 主会场

#### 17:45–17:50 · 收尾
- 形式: 闭幕
- 会场: 主会场

### Day 2 · 11 月 6 日（周五）

#### 09:00–10:00 · 签到
- 形式: 签到

#### 10:00–17:50 · 主题演讲
- 形式: 演讲
- 会场: 主会场
`;

  it('每天取最早一场的开始、最晚一场的结束', () => {
    const r = parseAgenda(TWO_DAYS);
    expect(r.errors).toEqual([]);
    expect(dayStartMinutes(r.days)).toEqual([8 * 60 + 30, 9 * 60]);
    expect(dayEndMinutes(r.days)).toEqual([17 * 60 + 50, 17 * 60 + 50]);
  });

  it('一天都没有场次时是 null（跟「结束在午夜」不是一回事）', () => {
    const r = parseAgenda(`### Day 1

#### 09:00–10:00 · 演讲
- 形式: 演讲
- 会场: 主会场

### Day 2
`);
    expect(dayStartMinutes(r.days)).toEqual([9 * 60, null]);
    expect(dayEndMinutes(r.days)).toEqual([10 * 60, null]);
  });

  it('没写结束时间的那一场，用它的开始时刻当结束', () => {
    const r = parseAgenda(`### Day 1

#### 09:00 · 演讲
- 形式: 演讲
- 会场: 主会场
`);
    expect(dayEndMinutes(r.days)).toEqual([9 * 60]);
  });
});

describe('签到', () => {
  it('不要求写会场——签到在入口，不在任何一个会场里', () => {
    const r = parseAgenda(`### Day 1

#### 08:30–09:30 · 签到
- 形式: 签到
`);
    expect(r.errors).toEqual([]);
    expect(r.days[0]?.slots[0]?.sessions[0]?.venue).toBe('');
  });

  it('其它形式缺会场照样报错', () => {
    const r = parseAgenda(`### Day 1

#### 08:30–09:30 · 演讲
- 形式: 演讲
`);
    expect(r.errors.join()).toContain('会场');
  });

  it('在闭集里', () => {
    expect(AGENDA_FORMATS).toContain('签到');
  });
});

describe('locateAgendaSection', () => {
  it('认「日程」「议程」两种叫法，范围不含下一个二级标题', () => {
    const found = locateAgendaSection(ONE);
    expect(found).not.toBeNull();
    // start 指在 `## 日程` 那一行之后，标题本身留给 Markdown 渲染（目录要它）
    expect(ONE.slice(found?.start ?? 0, found?.end ?? 0)).toContain('### Day 1');
    expect(ONE.slice(found?.start ?? 0, found?.end ?? 0)).not.toContain('行前清单');
    expect(locateAgendaSection('## 议程\n\n#### 10:00 · 开场\n- 形式: 开场\n- 会场: 主会场\n'))
      .not.toBeNull();
    expect(locateAgendaSection('## 速览\n\n没有日程\n')).toBeNull();
  });
});

function onlyErrors(section: string) {
  return parseAgenda(section).errors;
}

describe('parseAgenda · 正常读法', () => {
  it('一天一场，字段各归各位', () => {
    const r = parseAgenda(`### Day 1 · 11 月 5 日（周四）

#### 09:45–10:10 · 从模型到企业工作流
- 形式: 演讲
- 会场: 主会场
- 讲者: Marco Casalaina | 微软 | assets/speakers/marco.webp | 微软副总裁
`);
    expect(r.errors).toEqual([]);
    expect(r.days).toHaveLength(1);
    expect(r.days[0]!.title).toBe('Day 1 · 11 月 5 日（周四）');
    const s = r.days[0]!.slots[0]!.sessions[0]!;
    expect(s.start).toBe(585);            // 09:45
    expect(s.end).toBe(610);              // 10:10
    expect(s.timeText).toBe('09:45–10:10');
    expect(s.title).toBe('从模型到企业工作流');
    expect(s.format).toBe('演讲');
    expect(s.venue).toBe('主会场');
    expect(s.speakers).toEqual([
      { name: 'Marco Casalaina', org: '微软', avatar: 'assets/speakers/marco.webp', note: '微软副总裁' },
    ]);
  });

  it('同一开始时间的两场进同一个时段组，会场名升序、茶歇排最后', () => {
    const src = `### Day 1

#### 13:45–14:05 · 主会场这场
- 形式: 演讲
- 会场: 主会场

#### 13:45–14:05 · 分会场这场
- 形式: 演讲
- 会场: AI应用分会场

#### 13:45–13:50 · 茶歇
- 形式: 茶歇
- 会场: 走廊
`;
    const r = parseAgenda(src);
    expect(r.errors).toEqual([]);
    expect(r.days[0]!.slots).toHaveLength(1);
    // ⚠️ 排序走 CLDR 的 zh-CN 排序规则：汉字排在拉丁字母之前，
    //    所以「主会场」在「AI应用分会场」前面——主会场本来就是主轨，读者也这么预期。
    //    （别按「拼音 A 在 Z 前」去推演，那会得出相反的顺序。）
    expect(r.days[0]!.slots[0]!.sessions.map((s) => s.venue)).toEqual([
      '主会场', 'AI应用分会场', '走廊',
    ]);
  });

  it('只给开始时间也认；折行续写的字段值并成一行', () => {
    const r = parseAgenda(`#### 10:00 · 长摘要这场
- 形式: 演讲
- 会场: 主会场
- 摘要: 第一行开头，
  第二行接着说。
`);
    expect(r.errors).toEqual([]);
    const s = r.days[0]!.slots[0]!.sessions[0]!;
    expect(s.end).toBeNull();
    expect(s.abstract).toBe('第一行开头， 第二行接着说。');
  });

  it('多讲者每人一行', () => {
    const r = parseAgenda(`#### 10:50–11:10 · 两人一场
- 形式: 演讲
- 会场: 主会场
- 讲者: 李正楠 | You.com
- 讲者: Alex Triplett | You.com | assets/speakers/alex.webp
`);
    expect(r.errors).toEqual([]);
    expect(r.days[0]!.slots[0]!.sessions[0]!.speakers).toHaveLength(2);
  });
});

describe('parseAgenda · 坏数据要当场报错', () => {
  it('缺必填字段要报，写在小节外的字段要提醒', () => {
    expect(onlyErrors('#### 09:45 · 没有形式和会场\n').some((e) => e.includes('形式'))).toBe(true);
    expect(onlyErrors('#### 09:45 · 没有形式和会场\n- 形式: 演讲\n').some((e) => e.includes('会场'))).toBe(true);
    // 标题位置空着：`#### 09:45 ·` 后面没有主题
    expect(onlyErrors('#### 09:45 ·\n- 形式: 演讲\n- 会场: 主会场\n').some((e) => e.includes('####'))).toBe(true);
  });

  it('⚠️ 章节里有内容却一场都没解析出来 → 报错（旧表格写法会被整段抹掉，不能让它悄悄过去）', () => {
    // 字段行落在任何 #### 小节之外 → 提醒（写错位置的字段）＋ 整段无场次 → 报错
    const r = parseAgenda('- 形式: 演讲\n- 会场: 主会场\n');
    expect(r.warnings.some((w) => w.includes('形式'))).toBe(true);
    expect(r.errors.some((e) => e.includes('没有找到任何'))).toBe(true);

    // 旧写法（表格）整段会被替换掉 —— 这正是要拦住的：静默抹掉一整节日程
    const legacy = parseAgenda('| 时间 | 主题 |\n| --- | --- |\n| 09:45 | 甲 |\n');
    expect(legacy.errors.some((e) => e.includes('没有找到任何'))).toBe(true);

    // 空章节（作者还没写）不报错
    expect(parseAgenda('\n  \n').errors).toEqual([]);
  });

  it('形式不在闭集里，报文要列出可用值', () => {
    const errors = onlyErrors('#### 09:45 · 一场\n- 形式: 讲座\n- 会场: 主会场\n');
    expect(errors.some((e) => e.includes('讲座'))).toBe(true);
    for (const f of AGENDA_FORMATS) expect(errors.join(' ')).toContain(f);
  });

  it('未知字段名（拼错不能被静默丢掉）', () => {
    const errors = onlyErrors('#### 09:45 · 一场\n- 形式: 演讲\n- 会场: 主会场\n- 讲者姓名: 张三\n');
    expect(errors.some((e) => e.includes('讲者姓名'))).toBe(true);
  });

  it('时间格式与先后', () => {
    expect(onlyErrors('#### 9点45 · 一场\n- 形式: 演讲\n- 会场: 主会场\n').length)
      .toBeGreaterThan(0);
    expect(onlyErrors('#### 10:10–09:45 · 一场\n- 形式: 演讲\n- 会场: 主会场\n').length)
      .toBeGreaterThan(0);
  });

  it('头像必须是 assets/ 下的站内相对路径，且文件真在', () => {
    const bad = onlyErrors(
      '#### 09:45 · 一场\n- 形式: 演讲\n- 会场: 主会场\n- 讲者: 张三 | 机构 | https://example.org/a.jpg\n',
    );
    expect(bad.some((e) => e.includes('assets/'))).toBe(true);

    const r = parseAgenda(
      '#### 09:45 · 一场\n- 形式: 演讲\n- 会场: 主会场\n- 讲者: 张三 | 机构 | assets/speakers/missing.webp\n',
      { assetExists: () => false },
    );
    expect(r.errors.some((e) => e.includes('assets/speakers/missing.webp'))).toBe(true);
  });

  it('同一时段同一会场排两场 → 提醒而不是错误', () => {
    const r = parseAgenda(`#### 13:45–14:05 · 甲
- 形式: 演讲
- 会场: 主会场

#### 13:45–14:05 · 乙
- 形式: 圆桌
- 会场: 主会场
`);
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.includes('主会场'))).toBe(true);
  });

  it('茶歇行不要求讲者', () => {
    expect(parseAgenda('#### 10:45 · 茶歇休息\n- 形式: 茶歇\n- 会场: 主会场\n').errors).toEqual([]);
  });
});

describe('extractDayDate · 从当天标题里抠出日期', () => {
  it('认无歧义的 YYYY-MM-DD', () => {
    expect(extractDayDate('Day 1 · 2026-11-05（周四）开放模型')).toBe('2026-11-05');
    expect(extractDayDate('2026-12-31')).toBe('2026-12-31');
  });

  it('没有年份的中文日期不认（跨年会算错一天，宁可不知道）', () => {
    expect(extractDayDate('Day 1 · 11 月 5 日（周四）')).toBeNull();
    expect(extractDayDate('Day 1 · 12 月 31 日')).toBeNull();
  });

  it('不存在的日期不认', () => {
    expect(extractDayDate('Day 1 · 2026-02-30')).toBeNull();
    expect(extractDayDate('Day 1 · 2026-13-01')).toBeNull();
  });

  it('认不出就是 null', () => {
    expect(extractDayDate('Day 1')).toBeNull();
    expect(extractDayDate('')).toBeNull();
  });
});

describe('parseAgenda · 每天的日期', () => {
  it('标题里写了日期就记下来', () => {
    const days = agendaOf('### Day 1 · 2026-11-05（周四）\n\n#### 09:45 · 甲\n- 形式: 演讲\n- 会场: 主会场\n');
    expect(days[0]?.date).toBe('2026-11-05');
  });

  it('没写日期就是 null（判不出来就不猜）', () => {
    const days = agendaOf('### Day 1 · 11 月 5 日\n\n#### 09:45 · 甲\n- 形式: 演讲\n- 会场: 主会场\n');
    expect(days[0]?.date).toBeNull();
  });
});

function agendaOf(section: string) {
  return parseAgenda(section).days;
}

describe('renderAgenda', () => {
  it('一天一个点开式区块，只有第一天展开', () => {
    const html = renderAgenda(agendaOf(`### Day 1 · 11 月 5 日

#### 09:45–10:10 · 甲场
- 形式: 演讲
- 会场: 主会场

### Day 2 · 11 月 6 日

#### 10:00 · 乙场
- 形式: 开场
- 会场: 主会场
`), renderInlineValue);
    expect(html.match(/<details class="agenda-day-block"/g)).toHaveLength(2);
    expect(html).toMatch(/<details class="agenda-day-block"[^>]*open>/);
    expect(html.match(/open>/g)).toHaveLength(1);
    expect(html).toContain('Day 2 · 11 月 6 日');
  });

  it('传了 dayIds 时，每一天的 <details> 带上对应锚点 id', () => {
    const html = renderAgenda(
      agendaOf('### Day 1\n\n#### 09:45 · 甲场\n- 形式: 演讲\n- 会场: 主会场\n\n### Day 2\n\n#### 10:00 · 乙场\n- 形式: 演讲\n- 会场: 主会场\n'),
      renderInlineValue,
      ['day-1', 'day-2'],
    );
    expect(html).toContain('<details class="agenda-day-block" id="day-1" data-fold-key="day-1" open>');
    expect(html).toContain('<details class="agenda-day-block" id="day-2" data-fold-key="day-2">');
  });

  it('每一天带稳定的折叠键（浏览器端靠它记住展开/收起）', () => {
    const html = renderAgenda(
      agendaOf('### Day 1 · 2026-11-05（周四）\n\n#### 09:45 · 甲场\n- 形式: 演讲\n- 会场: 主会场\n\n### Day 2 · 2026-11-06（周五）\n\n#### 10:00 · 乙场\n- 形式: 演讲\n- 会场: 主会场\n'),
      renderInlineValue,
    );
    // ⚠️ 键用**序号**：作者改个标题措辞、或活动改期，键都不变，
    //    读者记的「第一天收着」还在
    expect(html).toContain('data-fold-key="day-1"');
    expect(html).toContain('data-fold-key="day-2"');
  });

  it('判不出日期的天也有折叠键（不参与自动收缩，但读者手动收起要记住）', () => {
    const html = renderAgenda(
      agendaOf('### Day 1 · 11 月 5 日（周四）\n\n#### 09:45 · 甲场\n- 形式: 演讲\n- 会场: 主会场\n'),
      renderInlineValue,
    );
    expect(html).not.toContain('data-day-date');
    expect(html).toContain('data-fold-key="day-1"');
  });

  it('当天的日期写进 data-day-date（浏览器按访问时刻判「过没过」）', () => {
    const html = renderAgenda(
      agendaOf('### Day 1 · 2026-11-05（周四）\n\n#### 09:45 · 甲场\n- 形式: 演讲\n- 会场: 主会场\n\n### Day 2 · 2026-11-06（周五）\n\n#### 10:00 · 乙场\n- 形式: 演讲\n- 会场: 主会场\n'),
      renderInlineValue,
    );
    expect(html).toContain('data-day-date="2026-11-05"');
    expect(html).toContain('data-day-date="2026-11-06"');
  });

  it('判不出日期的天不写这个属性（浏览器就当「不收缩」）', () => {
    const html = renderAgenda(
      agendaOf('### Day 1 · 11 月 5 日\n\n#### 09:45 · 甲场\n- 形式: 演讲\n- 会场: 主会场\n'),
      renderInlineValue,
    );
    expect(html).not.toContain('data-day-date');
  });

  it('卡片带时间、标签、标题、讲者（头像 alt 是讲者名）', () => {
    const html = renderAgenda(agendaOf(`#### 09:45–10:10 · 从模型到企业工作流
- 形式: 演讲
- 会场: 主会场
- 讲者: Marco Casalaina | 微软 | assets/speakers/marco.webp | 微软副总裁
- 时长: 25 分钟
`), renderInlineValue);
    expect(html).toContain('<span class="agenda-time">09:45–10:10</span>');
    expect(html).toContain('<span class="tag">演讲</span>');
    expect(html).toContain('<span class="tag">主会场</span>');
    expect(html).toContain('<h4>从模型到企业工作流</h4>');
    expect(html).toContain('class="agenda-avatar" src="assets/speakers/marco.webp" alt="Marco Casalaina"');
    expect(html).toContain('<span class="speaker-name">Marco Casalaina</span>');
    expect(html).toContain('<span class="speaker-org">微软</span>');
    expect(html).toContain('<span class="note">微软副总裁</span>');
    expect(html).toContain('<span class="agenda-duration">25 分钟</span>');
  });

  it('讲者行的第 5 段是完整介绍 → 变成姓名后面的 tip 图标', () => {
    const html = renderAgenda(agendaOf(`#### 09:45 · 一场
- 形式: 演讲
- 会场: 主会场
- 讲者: 张三 | 某某科技 | assets/speakers/zhang.webp | 工程师 | 某某科技的资深工程师，做过推理引擎。
`), renderInlineValue);
    expect(html).toContain('class="agenda-tip-btn"');
    expect(html).toContain('某某科技的资深工程师，做过推理引擎。');
    expect(html).toContain('aria-label="张三 的简介"');
  });

  it('「备注」字段 → 卡片上的提示图标', () => {
    const html = renderAgenda(agendaOf(`#### 09:45 · 一场
- 形式: 演讲
- 会场: 主会场
- 备注: 看这场之前得先弄懂 KV-Cache。
`), renderInlineValue);
    expect(html).toContain('agenda-tip-remark');
    expect(html).toContain('看这场之前得先弄懂 KV-Cache。');
  });

  it('状态字段渲染成警示小标签；短摘要直接摊开', () => {
    const html = renderAgenda(agendaOf(`#### 09:45 · 一场
- 形式: 演讲
- 会场: 主会场
- 状态: 主题待嘉宾确认
- 摘要: 中文摘要在这里。
`), renderInlineValue);
    expect(html).toContain('<span class="note note-warn">主题待嘉宾确认</span>');
    // 短摘要直接摊开：点一下才看等于多一次点击
    expect(html).toContain('<p class="agenda-abstract-text">中文摘要在这里。</p>');
    expect(html).not.toContain('agenda-abstract"');
    // 不再有「非官方中文口径」那句标注
    expect(html).not.toContain('中文转述自官方英文摘要');
  });

  it('长摘要收进点开式条目', () => {
    const html = renderAgenda(agendaOf(`#### 09:45 · 一场
- 形式: 演讲
- 会场: 主会场
- 摘要: ${'很长的摘要'.repeat(60)}
`), renderInlineValue);
    expect(html).toContain('<details class="agenda-abstract"><summary>摘要</summary>');
    expect(html).not.toContain('agenda-abstract-text');
  });

  it('茶歇是一条分隔行，不是卡片', () => {
    const html = renderAgenda(agendaOf(`#### 10:45 · 茶歇休息
- 形式: 茶歇
- 会场: 主会场
`), renderInlineValue);
    expect(html).toContain('<li class="agenda-break">');
    expect(html).not.toContain('<li class="agenda-card">');
  });

  it('签到也是一条分隔行，备注挂在提示图标上', () => {
    const html = renderAgenda(agendaOf(`#### 08:30–09:30 · 签到
- 形式: 签到
- 备注: 签到地点与入场证件要求以主办方通知为准。
`), renderInlineValue);
    expect(html).toContain('<li class="agenda-break">');
    expect(html).not.toContain('<li class="agenda-card">');
    // 备注不能因为走了分隔行就丢掉——签到那一行往往是读者唯一要展开看的
    expect(html).toContain('agenda-tip-remark');
    expect(html).toContain('签到地点与入场证件要求以主办方通知为准。');
  });

  it('同时段两场才标「同时段 N 场」', () => {
    const html = renderAgenda(agendaOf(`#### 13:45–14:05 · 甲
- 形式: 演讲
- 会场: 主会场

#### 13:45–14:05 · 乙
- 形式: 演讲
- 会场: 分会场
`), renderInlineValue);
    expect(html).toContain('<span class="slot-count">同时段 2 场</span>');
    expect(renderAgenda(agendaOf('#### 13:45 · 独一场\n- 形式: 演讲\n- 会场: 主会场\n'), renderInlineValue))
      .not.toContain('slot-count');
  });

  it('出处渲染成图标外链；没有出处就不出现这一段', () => {
    const html = renderAgenda(agendaOf(`#### 09:45 · 一场
- 形式: 演讲
- 会场: 主会场
- 出处: https://ai.engineer/shanghai/2026/speakers/marco-casalaina
`), renderInlineValue);
    expect(html).toContain('<a class="agenda-source" href="https://ai.engineer/shanghai/2026/speakers/marco-casalaina" tabindex="0"');
    expect(html).toContain('aria-label="官方页面"');
    expect(html).not.toContain('官方本页');
    expect(renderAgenda(agendaOf('#### 09:45 · 一场\n- 形式: 演讲\n- 会场: 主会场\n'), renderInlineValue))
      .not.toContain('agenda-source');
  });

  it('字段值里的 Markdown 照常生效，且不带外层 <p>', () => {
    const html = renderAgenda(agendaOf(`#### 09:45 · 一场
- 形式: 演讲
- 会场: 主会场
- 看点: **必听**，实测对比五种沙箱。
`), renderInlineValue);
    expect(html).toContain('<p class="agenda-highlight"><strong>必听</strong>，实测对比五种沙箱。</p>');
  });

  it('标题与字段里的尖括号被转义，不成为标签', () => {
    const html = renderAgenda(agendaOf(`#### 09:45 · <script>alert(1)</script>
- 形式: 演讲
- 会场: 主会场
`), renderInlineValue);
    expect(html).not.toContain('<script>');
  });

  it('每场都带一个「记一笔」入口，键是这一场自己的', () => {
    const html = renderAgenda(agendaOf(`#### 09:45 · 甲场
- 形式: 演讲
- 会场: 主会场

#### 10:00 · 乙场
- 形式: 演讲
- 会场: 主会场
`), renderInlineValue);
    const keys = [...html.matchAll(/data-note-key="([^"]+)"/g)].map((m) => m[1]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(html).toContain('agenda-note-input');
  });
});

describe('场次的稳定标识', () => {
  it('同样的内容得到同样的键（笔记才挂得住），不同场次不同键', () => {
    const one = `### Day 1

#### 09:45–10:10 · 甲场
- 形式: 演讲
- 会场: 主会场
`;
    const two = `### Day 1

#### 09:45–10:10 · 乙场
- 形式: 演讲
- 会场: 主会场
`;
    const keyOf = (src: string) => parseAgenda(src).days[0]?.slots[0]?.sessions[0]?.key;
    expect(keyOf(one)).toBeTruthy();
    expect(keyOf(one)).toBe(keyOf(one));
    expect(keyOf(one)).not.toBe(keyOf(two));
  });
});

describe('renderInlineValue', () => {
  it('内联渲染后去掉外层段落标签', () => {
    expect(renderInlineValue('**粗**')).toBe('<strong>粗</strong>');
    expect(renderInlineValue('普通文字')).toBe('普通文字');
  });

  it('多段落降级成 <br>，不产出嵌套 <p>（外层已经有 p 了）', () => {
    const html = renderInlineValue('第一段\n\n第二段');
    expect(html).not.toContain('<p>');
    expect(html).toContain('<br>');
  });
});
