/** HTML 相关的零碎工具：转义、slug、标签剥离。 */

/** 转义文本，供插入 HTML 文本节点。 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 把标题文字变成锚点 id。
 * 保留中日韩文字（`\p{L}` / `\p{N}`），只把空白和标点换成连字符。
 */
export function slugify(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

/** 去掉 HTML 标签与实体，还原成纯文字（用于目录条目）。 */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** JSON 嵌进 `<script type="application/json">` 时要防 `</script>` 提前收尾。 */
export function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/**
 * 文本的稳定短哈希（FNV-1a，base36）。
 * 用来给清单项生成 id：内容不变，id 就不变，用户浏览器里打的勾也就还在。
 */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  const s = text.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
