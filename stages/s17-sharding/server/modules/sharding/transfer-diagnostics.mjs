// Bounded subprocess diagnostics only; never serialize execFile's command/message.
export const STDERR_LIMIT = 2048;
const boundedText = value => Buffer.from(value).subarray(0, STDERR_LIMIT).toString('utf8').replace(/\uFFFD$/, '');
export function stderrCollector() {
  let data = Buffer.alloc(0);
  return {
    append(chunk) {
      if (data.length < STDERR_LIMIT) data = Buffer.concat([data, Buffer.from(chunk).subarray(0, STDERR_LIMIT - data.length)]);
    },
    get text() { return data.toString('utf8'); },
  };
}
export function subprocessFailure(error, { kind, phase, stderr = '', exitCode = error.code, signal = error.signal }) {
  // Retain paths and known diagnostic categories, discard arbitrary child text/content.
  const raw = boundedText(stderr || '');
  const paths = raw.match(/(?:^|[\s:'"])(?:\.?\.?)\/[\w./@+-]+/gm) || [];
  const reasons = ['Permission denied', 'Operation not permitted', 'Cannot open', 'Cannot stat',
    'Cannot mkdir', 'Cannot utime', 'Cannot change ownership', 'Cannot change mode',
    'Unexpected EOF', 'This does not look like a tar archive', 'No such file or directory',
    'File exists', '迁移属主不匹配', '迁移拒绝链接和特殊文件', '迁移文件名含控制字符']
    .filter(reason => raw.includes(reason));
  error.subprocessDiagnostic = { kind, phase, exitCode: Number.isInteger(exitCode) ? exitCode : null,
    signal: /^SIG[A-Z]+$/.test(signal || '') ? signal : null,
    stderr: boundedText([...reasons, ...paths.map(p => p.trim().replace(/^[:'"]/, ''))].join('\n')) };
  return error;
}
