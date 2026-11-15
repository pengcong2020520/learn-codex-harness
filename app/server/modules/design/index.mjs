import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readAsUser, userFileOperation } from '../runtimes/user-files.mjs';
import { nodeHeaders } from '../sharding/node-auth.mjs';

const suggestions = {
  'text-overlap': '调整布局间距、定位或行高，避免字形相交。',
  'text-clipped': '增大文字容器或允许区域内滚动，避免隐藏正文。',
  'page-scroll': '把整页限制在视口内，将长内容放入局部滚动区域。',
  'outside-viewport': '修正宽高、定位和最小尺寸，让元素留在视口内。',
  'small-font': '将文字字号调整到至少 11px。',
  'external-request': '将依赖内嵌到单文件原型，移除网络请求。',
};
export function summarizeDesign(report) {
  if (report?.status !== 'completed' || !Array.isArray(report.issues) || !Number.isSafeInteger(report.errors) || report.errors < 0 || !Number.isSafeInteger(report.warnings) || report.warnings < 0 || report.issues.some(i => !i || !['error', 'warning'].includes(i.severity)) || report.errors !== report.issues.filter(i => i.severity === 'error').length || report.warnings !== report.issues.filter(i => i.severity === 'warning').length) throw new Error('布局校验服务不可用：报告格式无效，不能声称已通过校验。');
  return { status: 'completed', errors: report.errors, warnings: report.warnings, truncated: report.issues.length > 30,
    issues: report.issues.slice(0, 30).map(i => ({ screen: i.screen, state: i.state, viewport: i.viewport, element: i.element,
      code: i.code, severity: i.severity, reason: i.reason, fix: suggestions[i.code] || '按对应屏幕、状态和视口复核问题，修正后重新检查。' })) };
}

export function createDesignTools({ files, env = process.env, fetcher = fetch }) {
  return {
    async check_design({ path: relative }, { signal } = {}) {
      signal?.throwIfAborted();
      const { file, uid } = files.design_path({ path: relative });
      const html = new TextDecoder('utf-8', { fatal: true }).decode(await readAsUser(uid, file, { maxBytes: 2 * 1024 * 1024 }));
      let report;
      try {
        if (!env.AGENT_NODE_ID || !env.AGENT_NODE_KEY) throw new Error();
        const response = await fetcher(new URL('/check', env.DESIGN_CHECK_URL || 'http://design-check:8091'), {
          method: 'POST', headers: { ...nodeHeaders({ nodeId: env.AGENT_NODE_ID, key: env.AGENT_NODE_KEY }), 'content-type': 'application/json' },
          body: JSON.stringify({ html }), redirect: 'error',
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
        });
        if (response.status === 504) throw Object.assign(new Error('检查超时'), { code: 'DESIGN_CHECK_TIMEOUT' });
        if (!response.ok) throw new Error();
        report = await response.json();
      } catch (error) {
        signal?.throwIfAborted();
        if (error.code === 'DESIGN_CHECK_TIMEOUT' || error.name === 'TimeoutError') throw new Error('检查超时，未完成校验，不自动重试。');
        throw new Error('布局校验服务不可用，不能声称已经通过校验。请检查 studio profile 与服务状态。');
      }
      const summary = summarizeDesign(report);
      signal?.throwIfAborted();
      const project = relative.match(/^(?:outputs|inputs)\/design\/([^/]+)\//)?.[1] || path.basename(relative, path.extname(relative));
      const reportPath = `outputs/design/${project}/qa/${path.basename(relative, path.extname(relative))}-${Date.now()}-${randomUUID()}.json`;
      await files.write_design_report({ path: reportPath, report: { ...report, file: relative } });
      return { ...summary, reportPath };
    },
    async build_prototype({ path: relative, html, jsx }, { signal } = {}) {
      if (!/^outputs\/design\/[a-z][a-z0-9-]{0,47}\/prototype-v[1-9]\d*\.html$/.test(relative)) throw new Error('复杂原型须写到本项目的 prototype-v<n>.html。');
      if (!env.AGENT_NODE_ID || !env.AGENT_NODE_KEY) throw new Error('请启动工作室的设计校验服务后再编译。');
      const response = await fetcher(new URL('/compile', env.DESIGN_CHECK_URL || 'http://design-check:8091'), {
        method: 'POST', headers: { ...nodeHeaders({ nodeId: env.AGENT_NODE_ID, key: env.AGENT_NODE_KEY }), 'content-type': 'application/json' },
        body: JSON.stringify({ html, jsx }), redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error('原型编译失败，请核对 JSX、模板标记、文件大小及设计服务。');
      const result = await response.json();
      if (typeof result?.html !== 'string' || Buffer.byteLength(result.html) > 256 * 1024) throw new Error('编译结果不符合单文件大小或格式要求。');
      signal?.throwIfAborted();
      return files.write_file({ path: relative, content: result.html });
    },
    async check_agent_package({ path: relative }, { signal } = {}) {
      signal?.throwIfAborted();
      const { file, uid } = files.design_path({ path: relative.replace(/\/$/, ''), package: true });
      // 真实运行时以产物属主读取 0600 文件，避免 root 缺少 DAC 能力或跨用户读取。
      const result = process.getuid?.() === uid
        ? (await import('./package.mjs')).checkAgentPackage(file)
        : await userFileOperation(uid, 'check-agent-package', { directory: file });
      signal?.throwIfAborted();
      return result;
    },
  };
}
