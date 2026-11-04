/**
 * 调研技能（`skills/event-research/`）与骨架模板（`src/templates/event-template.md`）
 * 里写的**示例**必须真的能通过构建器。
 *
 * ⚠️ 为什么要有这条测试：
 *   技能是给 AI 照着写的——它照抄示例里的写法产出 `event.md`。
 *   示例里要是有一处写法构建器不认（比如时间的结束早于开始），
 *   AI 就会照着写出一份**构建直接失败**的内容，而且报错信息指向内容、
 *   指向那行示例，却没人会去翻技能文档。
 *   实测踩过：技能示例写的是 `#### 09:30–09:15`，构建器报
 *   「结束不早于开始」，整个活动页出不来。
 *
 *   所以：示例里的日程片段，交给真正的解析器跑一遍。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAgenda } from '../lib/agenda.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SKILL = path.join(ROOT, 'skills', 'event-research', 'SKILL.md');
const TEMPLATE = path.join(ROOT, 'src', 'templates', 'event-template.md');

/** 从 markdown 里抠出 `#### 时间 · 标题` 开头的场次片段。 */
function extractSessionBlocks(md: string): string[] {
  const lines = md.split('\n');
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    // 只取围栏代码块里的示例（那些是「照着抄」的段落）
    if (line.startsWith('#### ')) {
      current = [line];
      blocks.push(current.join('\n'));
      continue;
    }
    if (current) {
      if (line.startsWith('- ') || line.trim() === '') {
        current.push(line);
        blocks[blocks.length - 1] = current.join('\n');
        if (line.trim() === '') current = null;
      } else {
        current = null;
      }
    }
  }
  return blocks;
}

describe('调研技能与骨架模板里的示例', () => {
  it('技能里的场次示例都能通过日程解析（结束不早于开始）', async () => {
    const skill = await readFile(SKILL, 'utf8');
    const blocks = extractSessionBlocks(skill);
    expect(blocks.length).toBeGreaterThan(0);

    const problems: string[] = [];
    for (const block of blocks) {
      const parsed = parseAgenda(block, {});
      if (parsed.errors.length > 0) {
        problems.push(`${block.split('\n')[0]} → ${parsed.errors.join('；')}`);
      }
    }
    expect(problems, `技能里的示例构建器不认：\n${problems.join('\n')}`).toEqual([]);
  });

  it('骨架模板里的场次示例都能通过日程解析', async () => {
    const template = await readFile(TEMPLATE, 'utf8');
    const blocks = extractSessionBlocks(template);
    expect(blocks.length).toBeGreaterThan(0);

    const problems: string[] = [];
    for (const block of blocks) {
      const parsed = parseAgenda(block, {});
      if (parsed.errors.length > 0) {
        problems.push(`${block.split('\n')[0]} → ${parsed.errors.join('；')}`);
      }
    }
    expect(problems, `骨架模板里的示例构建器不认：\n${problems.join('\n')}`).toEqual([]);
  });

  it('技能与模板不再指向已删除的原始需求文档', async () => {
    const skill = await readFile(SKILL, 'utf8');
    const template = await readFile(TEMPLATE, 'utf8');
    // `docs/original/EVENT-RESEARCH.md` 已随原始需求文档一起移除
    expect(skill).not.toContain('EVENT-RESEARCH.md');
    expect(template).not.toContain('EVENT-RESEARCH.md');
  });
});
