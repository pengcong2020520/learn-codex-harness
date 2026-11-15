import { checkDesign } from '../../scripts/layout-check.mjs';

// no-sandbox 仅供专用容器：非 root、cap_drop ALL、只读根、内部网络与无宿主挂载共同提供边界。
export const chromeArgs = ['--no-sandbox', '--disable-dev-shm-usage', '--host-resolver-rules=MAP * ~NOTFOUND', '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>'];

process.once('message', async ({ file, viewports }) => {
  try {
    const report = await checkDesign(file, { viewports, chromeArgs });
    process.send({ report }, () => process.disconnect());
  } catch {
    process.send({ error: '布局检查无法完成，请检查 HTML、Chromium 和容器运行状态。' }, () => process.disconnect());
  }
});
