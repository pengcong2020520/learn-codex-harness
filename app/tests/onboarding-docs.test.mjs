import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { hasSkillMetadata } from '../scripts/agent-check.mjs';

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const names = ['new-agent', 'extend-agent', 'go-production'];
for (const name of names) {
  test(`引导 Skill ${name} 两家逐字节相同`, () => {
    const codex = fs.readFileSync(new URL(`../../.agents/skills/${name}/SKILL.md`, import.meta.url));
    const claude = fs.readFileSync(new URL(`../../.claude/skills/${name}/SKILL.md`, import.meta.url));
    assert.ok(codex.equals(claude));
  });
  test(`引导 Skill ${name} 元数据完整且只有约定字段`, () => {
    const text = read(`../../.claude/skills/${name}/SKILL.md`);
    assert.ok(hasSkillMetadata(text));
    const header = text.split('---')[1];
    assert.deepEqual([...header.matchAll(/^(\w+):/gm)].map(match => match[1]).sort(), ['description', 'name']);
    assert.match(header, new RegExp(`^name: ${name}$`, 'm'));
  });
}

test('Skill 与提示词所引用的 npm 命令和 README 章节均存在', () => {
  const scripts = JSON.parse(read('../package.json')).scripts;
  const headings = new Set([...read('../README.md').matchAll(/^#{1,6} (.+)$/gm)].map(match => match[1]));
  const documents = [read('../docs/prompts.md'), ...names.map(name => read(`../../.claude/skills/${name}/SKILL.md`))];
  for (const text of documents) {
    const commands = [...text.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)];
    assert.ok(commands.length > 0);
    for (const [, command] of commands) assert.ok(Object.hasOwn(scripts, command), `未登记命令：${command}`);
    const references = [...text.matchAll(/README((?:「[^」]+」[、与和\s]*)+)/g)];
    assert.ok(references.length > 0);
    for (const [, titles] of references) for (const [, title] of titles.matchAll(/「([^」]+)」/g)) assert.ok(headings.has(title), `缺少章节：${title}`);
  }
});
