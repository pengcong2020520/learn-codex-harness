import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createDesignTools } from '../server/modules/design/index.mjs';
import { createFileTools } from '../server/modules/data/files.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-e2e-'));
try {
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspaceDir, 'inputs'), { recursive: true });
  const files = createFileTools(root, { workspaceDir, sources: [{ locator: 'inputs', actions: ['read'] }, { locator: 'outputs', actions: ['read'] }], outputs: { directory: 'outputs' } });
  const tools = createDesignTools({ files });
  const clean = fs.readFileSync(new URL('../tests/fixtures/layout/clean.html', import.meta.url), 'utf8');
  const broken = clean.replace('</style>', 'body{height:2000px}p{position:absolute;top:0;left:0}</style>').replace('<p>干净页面</p>', '<p>Overlapping text</p><p>Overlapping text</p>');
  for (const [name, html] of [['broken', broken], ['clean', clean]]) {
    fs.writeFileSync(path.join(workspaceDir, `inputs/${name}.html`), html);
    const summary = await tools.check_design({ path: `inputs/${name}.html` });
    const report = JSON.parse(fs.readFileSync(path.join(workspaceDir, summary.reportPath)));
    if (name === 'broken') for (const code of ['text-overlap', 'page-scroll']) assert.ok(report.issues.some(i => i.code === code), `报告缺少 ${code}`);
    else assert.equal(report.errors, 0);
    assert.equal(summary.errors, report.errors);
  }
  const prototype = 'outputs/design/sample/prototype-v1.html';
  const html = clean.replace('<p>干净页面</p>', '<div id="react-root"></div>').replace('</html>', '<!--studio-app--></html>');
  const jsx = "const {React, createRoot, Button} = Studio; function Counter(){const [n,set]=React.useState(0);return <Button className='p-2' onClick={()=>set(n+1)}>计数 {n}</Button>} createRoot(document.querySelector('#react-root')).render(<Counter/>);";
  await tools.build_prototype({ path: prototype, html, jsx });
  const built = fs.readFileSync(path.join(workspaceDir, prototype), 'utf8');
  assert.ok(built.includes('.p-2') && !built.includes('<!--studio-app-->'));
  assert.equal((await tools.check_design({ path: prototype })).errors, 0);
  await assert.rejects(tools.build_prototype({ path: prototype, html, jsx }));
  const response = await fetch('http://design-check:8091/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ html: clean }) });
  assert.equal(response.status, 403);
  process.stdout.write('design-check 验收通过：重叠、整页滚动、干净页面、完整报告及节点认证。\n');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
