// 与浏览器用例共用探针，让离线测试可以控制 CSP 事件的到达顺序。
export function previewProbe() {
  window.probe = { violations: [] };
  const report = (stage, details = {}) => parent.postMessage({ previewEvent: { stage, timestamp: Date.now(), ...details } }, '*');
  // fetch 拒绝与 CSP 事件没有固定先后顺序，二者都到齐才能发送快照。
  const connectBlocked = new Promise(resolve => {
    addEventListener('securitypolicyviolation', event => {
      window.probe.violations.push(event.effectiveDirective);
      report('violation', { effectiveDirective: event.effectiveDirective });
      if (event.effectiveDirective === 'connect-src') resolve();
    });
  });
  document.querySelector('#probe').onclick = async () => {
    report('click');
    document.querySelector('#probe').textContent = '脚本已运行';
    window.probe.text = document.querySelector('#probe').textContent;
    try { sessionStorage.getItem('agent.web.token'); window.probe.storage = 'unexpected'; } catch (error) { window.probe.storage = error.name + ': ' + error.message; }
    try { parent.document.body; window.probe.parent = 'unexpected'; } catch (error) { window.probe.parent = error.name + ': ' + error.message; }
    report('fetch-start');
    try { await fetch('/sessions'); window.probe.fetch = 'unexpected'; } catch (error) { window.probe.fetch = error.name + ': ' + error.message; }
    report('fetch-done', { result: window.probe.fetch });
    await connectBlocked;
    parent.postMessage({ previewProbe: window.probe }, '*');
    report('snapshot-sent');
  };
  addEventListener('load', () => {
    // 跨进程 iframe 的 load 不代表合成帧已提交，等两帧再允许父页面点击。
    requestAnimationFrame(() => requestAnimationFrame(() => {
      report('ready');
      parent.postMessage({ previewReady: true }, '*');
    }));
  }, { once: true });
}
