import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../../stages/build-roadmap.mjs';
import { dirs } from '../../stages/build-architecture.mjs';
import { repositoryUrl } from '../../app/web/course-data.mjs';

test('路线图按已完成阶段目录生成链接，规划阶段保持无链接', () => {
  const svg = render();
  const links = [...svg.matchAll(/<a href="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(links, dirs.map(dir => `${repositoryUrl}/stages/${dir}/README.md`));
  assert.equal((svg.match(/<\/a>/g) || []).length, dirs.length);
  assert.match(svg, /s12–s17 已完成，s18 规划中/);
  assert.ok(!links.some(link => link.includes('/s18')));
});
