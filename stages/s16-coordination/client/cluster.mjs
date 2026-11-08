import { pathToFileURL } from 'node:url';
import { AgentClient, loadClientConnection } from './modules/connection/index.mjs';
export function runCluster(argv = process.argv.slice(2), api = new AgentClient(loadClientConnection())) {
  if (argv.length !== 1 || argv[0] !== 'status') throw new Error('用法：npm run cluster -- status');
  return api.request('/cluster');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve().then(() => runCluster()).then(value => console.log(JSON.stringify(value, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
