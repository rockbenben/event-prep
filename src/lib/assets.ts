/**
 * 站点级静态资源（样式与脚本）的**内容哈希命名**。
 *
 * 为什么不用固定文件名：
 *   固定名（`site.css`）没法配长缓存——CDN 一旦缓存了它，
 *   改了 CSS 也要等缓存过期才生效，用户拿到的还是旧样式。
 *   文件名带上内容哈希（`site.4f3a2b1c.css`）之后，
 *   内容变了文件名就变了，可以放心给一年 `immutable`。
 *
 * ⚠️ 只有**站点级**资源能这么干：
 *    活动自带的资源（讲者头像等）由内容里的路径指名，
 *    改名会让 `event.md` 里的引用对不上——那些保持原名。
 */

import { createHash } from 'node:crypto';

/** 哈希算法与长度：够短（文件名不丑）、够长（不会撞）。 */
const HASH_LENGTH = 8;

/**
 * 算内容哈希。
 *
 * 用 sha256 的前 8 位十六进制：内容变了哈希就变，
 * 内容没变哈希就不变（所以反复构建不会让缓存全部失效）。
 */
export function hashContent(content: string | Uint8Array): string {
  return createHash('sha256')
    .update(content)
    .digest('hex')
    .slice(0, HASH_LENGTH);
}

/**
 * 把文件名改成带哈希的：`site.css` → `site.4f3a2b1c.css`。
 *
 * 哈希插在扩展名前面：`.css` 还在，MIME 与缓存规则照旧按后缀走。
 */
export function hashedFileName(fileName: string, hash: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return `${fileName}.${hash}`;
  return `${fileName.slice(0, dot)}.${hash}${fileName.slice(dot)}`;
}

/** 站点级资源的文件名（构建后产物里的名字）。 */
export interface SiteAssetNames {
  css: string;
  js: string;
}

/**
 * 按内容算出站点级资源的哈希文件名。
 *
 * @param css 样式表内容
 * @param js  脚本内容
 */
export function siteAssetNames(css: string, js: string): SiteAssetNames {
  return {
    css: hashedFileName('site.css', hashContent(css)),
    js: hashedFileName('site.js', hashContent(js)),
  };
}
