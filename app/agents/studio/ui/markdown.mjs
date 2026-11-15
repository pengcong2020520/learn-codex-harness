import { Marked } from './vendor/marked.mjs';
// 原始 HTML 作为文字保留；解析前转义，避免加载资源或丢失同一块内的正文。
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const parser = new Marked({ renderer: { html: ({ text }) => escape(text), image: ({ text }) => escape(text) } });
const allowed = new Set(['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a']);
const discard = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'form', 'input', 'button', 'img', 'video', 'audio', 'link', 'meta', 'base']);
export function sanitizeTree(root, document) {
  const fragment = document.createDocumentFragment();
  const copy = (node, parent) => {
    if (node.nodeType === 3) { parent.append(document.createTextNode(node.nodeValue)); return; }
    const tag = node.tagName?.toLowerCase();
    if (discard.has(tag)) return;
    const element = allowed.has(tag) ? document.createElement(tag) : parent;
    if (tag === 'a') {
      const href = node.getAttribute('href') || '';
      // 不接受相对链接、控制字符或协议混淆；不让文档劫持宿主导航。
      if (!/[\x00-\x20\x7f]/.test(href) && /^(https?:\/\/|mailto:)/i.test(href)) {
        try { const url = new URL(href); if (['https:', 'http:', 'mailto:'].includes(url.protocol)) { element.setAttribute('href', url.href); element.setAttribute('target', '_blank'); element.setAttribute('rel', 'noopener noreferrer'); } } catch { /* 无效链接保留文字。 */ }
      }
    }
    for (const child of node.childNodes || []) copy(child, element);
    if (element !== parent) parent.append(element);
  };
  for (const child of root.childNodes) copy(child, fragment);
  return fragment;
}
export function markdown(text, document = globalThis.document, Parser = globalThis.DOMParser) {
  const parsed = new Parser().parseFromString(parser.parse(String(text), { async: false, gfm: true }), 'text/html');
  return sanitizeTree(parsed.body, document);
}
export function outlineFromHtml(html, document = globalThis.document) {
  // template 内容保持惰性，产物中的 style/script 不会在宿主上执行或触发 CSP。
  const template = document.createElement('template'); template.innerHTML = html;
  const parsed = template.content;
  const node = parsed.querySelector('script#design-outline[type="application/json"]');
  const outline = JSON.parse(node?.textContent || 'null');
  if (!Array.isArray(outline?.groups) || !outline.groups.length) throw Error('产物缺少页面目录，请重新生成。');
  const ids = new Set(), groups = new Set();
  for (const group of outline.groups) {
    if (typeof group.id !== 'string' || groups.has(group.id) || typeof group.title !== 'string' || !Number.isInteger(group.order) || group.order < 1 || !Array.isArray(group.screens) || !group.screens.length) throw Error('产物分组目录无效。');
    groups.add(group.id);
    for (const screen of group.screens) {
      if (typeof screen.id !== 'string' || ids.has(screen.id) || typeof screen.title !== 'string' || !Number.isInteger(screen.position) || screen.position < 1 || !Array.isArray(screen.states) || !screen.states.length || screen.states.some(state => typeof state !== 'string' || !state) || new Set(screen.states).size !== screen.states.length) throw Error('产物页面或状态目录无效。');
      ids.add(screen.id);
      for (const state of screen.states) {
        const matches = [...parsed.querySelectorAll('section[data-screen]')].filter(section => section.dataset.screen === screen.id && section.dataset.state === state && section.dataset.group === group.id);
        if (matches.length !== 1) throw Error('产物目录与实际页面不一致。');
      }
    }
  }
  return outline;
}
