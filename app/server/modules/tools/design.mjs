import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 快照只包含工具目录；校验器从受信项目代码加载，不从用户代码包导入模块。
export function createTools({ root, files }) {
  const invoke = method => async (args, context) => {
    const { createDesignTools } = await import(pathToFileURL(path.join(root, 'server/modules/design/index.mjs')).href);
    return createDesignTools({ files })[method](args, context);
  };
  return { check_design: invoke('check_design'), check_agent_package: invoke('check_agent_package') };
}
