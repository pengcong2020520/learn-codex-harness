import fs from 'node:fs';
import { transform } from 'esbuild';
import postcss from 'postcss';
import tailwind from 'tailwindcss';

const local = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
const runtime = local('runtime.min.js');
const components = local('button.tsx') + local('card.tsx');

export async function compilePrototype({ html, jsx }) {
  // 只转换浏览器源码；没有入口路径、用户插件或构建配置，不解析模型给出的模块。
  const compiled = await transform(jsx, { loader: 'jsx', format: 'iife', minify: true, jsxFactory: 'Studio.React.createElement', jsxFragment: 'Studio.React.Fragment' });
  const result = await postcss([tailwind({
    content: [{ raw: html + '\n' + jsx + '\n' + components, extension: 'jsx' }],
    theme: { extend: { colors: { card: 'var(--surface)', 'card-foreground': 'var(--text)', primary: 'var(--accent)', 'primary-foreground': 'var(--on-accent, white)', border: 'var(--border)' } } },
  })]).process('@tailwind components; @tailwind utilities;', { from: undefined });
  const script = (runtime + '\n' + compiled.code).replace(/<\/script/gi, '<\\/script');
  const styles = result.css.replace(/<\/style/gi, '<\\/style');
  const output = html.replace('<!--studio-app-->', () => `<style>${styles}</style><script>${script}</script>`);
  if (Buffer.byteLength(output) > 256 * 1024) throw Error('编译结果超过 256 KiB，请减少内嵌数据或拆简该原型。');
  return output;
}
