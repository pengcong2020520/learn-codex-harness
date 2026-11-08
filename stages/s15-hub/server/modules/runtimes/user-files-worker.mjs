// 固定操作集合；只能在降权后的短命进程执行，不接受任意代码。
import fs from 'node:fs';
import { readLocalFile } from './user-files.mjs';

try {
  process.umask(0o007);
  const task = JSON.parse(fs.readFileSync(0, 'utf8'));
  let value;
  if (task.operation === 'read') {
    const { data, metadata } = readLocalFile(process.getuid(), task.file, task.options);
    fs.writeFileSync(1, data); fs.writeFileSync(3, JSON.stringify(metadata));
  } else {
    switch (task.operation) {
      case 'prepare': {
        const { prepareRun } = await import('../codex/runtime.mjs');
        const { prepareCodexConfig } = await import('../codex/config.mjs');
        const { installSkills } = await import('../codex/skills.mjs');
        const runtime = await prepareRun(task.config.launch, task.config.root, { ...task.paths, instructions: task.instructions, servicePid: task.servicePid });
        prepareCodexConfig(task.config, task.mcp);
        const installed = installSkills({ skills: task.skills }, task.paths.codexHome);
        value = { runtime, installed: [...installed], env: task.config.launch.env };
        break;
      }
      case 'skills': {
        const { installSkills } = await import('../codex/skills.mjs');
        value = [...installSkills({ skills: task.skills }, task.codexHome)]; break;
      }
      case 'finish': {
        const { finishRun } = await import('../codex/runtime.mjs');
        finishRun(task.runDir, task.servicePid); value = null; break;
      }
      case 'record': {
        // 新建/追加日志也绑定 fd；不跟随用户在运行目录中放入的链接。
        const fd = fs.openSync(task.file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
        try {
          const stat = fs.fstatSync(fd);
          if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()) throw new Error('运行日志不是独立普通文件。');
          fs.writeFileSync(fd, task.text);
        } finally { fs.closeSync(fd); }
        value = null; break;
      }
      case 'prune': {
        const { RunMaintenance } = await import('../maintenance/index.mjs');
        const maintenance = new RunMaintenance({ ...task.options, runtime: { ...task.options.runtime, isolated: false } });
        value = await maintenance.prune(task.now, task.dryRun); break;
      }
      default: throw new Error('未知用户文件操作。');
    }
    fs.writeFileSync(1, JSON.stringify(value)); fs.writeFileSync(3, '{}');
  }
} catch (error) {
  fs.writeFileSync(3, JSON.stringify({ error: error.message.slice(0, 1000), code: error.code }));
  process.exitCode = 1;
}
