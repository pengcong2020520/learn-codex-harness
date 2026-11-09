import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../../stages/build-roadmap.mjs';
import { dirs } from '../../stages/build-architecture.mjs';
import { repositoryUrl } from '../../app/web/course-data.mjs';

test('路线图包含全部十九个已完成阶段并生成链接', () => {
  const svg = render();
  const links = [...svg.matchAll(/<a href="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(links, dirs.map(dir => `${repositoryUrl}/stages/${dir}/README.md`));
  assert.equal((svg.match(/<\/a>/g) || []).length, dirs.length);
  assert.match(svg, /s12–s18 已完成/);
  assert.ok(links.some(link => link.includes('/s18-replication/README.md')));
  assert.doesNotMatch(svg, /规划中/);
});

import fs from 'node:fs';
test('所有阶段第三行导航包含 s00 到 s18 与 app', () => {
 for (const dir of dirs) {
  const nav = fs.readFileSync(new URL(`../../stages/${dir}/README.md`, import.meta.url), 'utf8').split('\n')[2];
  assert.ok(nav.startsWith('[导论]'));
  for (const target of dirs) assert.ok(nav.includes(target === dir ? `\`${target.slice(0,3)}\`` : `[${target.slice(0,3)}]`));
  assert.ok(nav.endsWith('[app](../../app/)'));
 }
});
