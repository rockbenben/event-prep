/**
 * YAML front matter 的切分与解析。
 * 解析和校验是分开的：这里只负责「切得对不对、YAML 合不合法」，
 * 字段级校验见 schema.ts。
 */

import { parse as parseYaml, YAMLParseError } from 'yaml';

export interface FrontMatter {
  /** 解析出的字段（未经校验）。 */
  data: Record<string, unknown>;
  /** front matter 之后的 Markdown 正文。 */
  body: string;
  /** 有问题时这里是可读的中文说明；没问题时为 null。 */
  error: string | null;
}

const DELIMITER = /^---[ \t]*$/;

/** 切出 front matter 与正文。 */
export function splitFrontMatter(source: string): { yaml: string | null; body: string; error: string | null } {
  let src = source;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  // Windows 换行统一成 LF：分隔符正则和 YAML 解析都按 LF 处理
  src = src.replace(/\r\n/g, '\n');

  const firstLineEnd = src.indexOf('\n');
  const firstLine = (firstLineEnd === -1 ? src : src.slice(0, firstLineEnd)).trim();
  if (firstLine !== '---') {
    return {
      yaml: null,
      body: src,
      error: '缺少 YAML front matter：文件应以一行 --- 开头',
    };
  }

  const rest = firstLineEnd === -1 ? '' : src.slice(firstLineEnd + 1);
  const lines = rest.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (DELIMITER.test(lines[i] ?? '')) {
      return {
        yaml: lines.slice(0, i).join('\n'),
        body: lines.slice(i + 1).join('\n'),
        error: null,
      };
    }
  }

  return { yaml: null, body: src, error: 'YAML front matter 没有闭合：找不到结束的 ---' };
}

/** 切分并解析 front matter。 */
export function parseFrontMatter(source: string): FrontMatter {
  const split = splitFrontMatter(source);
  if (split.error) {
    return { data: {}, body: split.body, error: split.error };
  }
  if (split.yaml === null || split.yaml.trim() === '') {
    return { data: {}, body: split.body, error: 'YAML front matter 是空的' };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(split.yaml, { prettyErrors: true });
  } catch (err) {
    if (err instanceof YAMLParseError) {
      return {
        data: {},
        body: split.body,
        error: `YAML 解析失败（第 ${err.linePos?.[0]?.line ?? '?'} 行）：${err.message}`,
      };
    }
    return { data: {}, body: split.body, error: `YAML 解析失败：${(err as Error).message}` };
  }

  if (parsed === null || parsed === undefined) {
    return { data: {}, body: split.body, error: 'YAML front matter 是空的' };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { data: {}, body: split.body, error: 'YAML front matter 必须是键值映射' };
  }

  return { data: parsed as Record<string, unknown>, body: split.body, error: null };
}
