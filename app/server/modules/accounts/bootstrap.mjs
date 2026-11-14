// 与向导共用纯数据编解码，不能引入数据库依赖；固定格式避免 Compose 插值哈希中的 $。
function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'hash,username'
    || typeof value.username !== 'string' || !/^[a-z0-9._-]{1,64}$/.test(value.username)
    || typeof value.hash !== 'string' || !/^scrypt\$32768\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(value.hash)) throw new Error('格式无效');
  return value;
}
export function encodeBootstrap(value) {
  return Buffer.from(JSON.stringify(validate(value))).toString('base64url');
}
export function decodeBootstrap(encoded) {
  try {
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) throw new Error();
    return validate(JSON.parse(bytes.toString('utf8')));
  } catch { throw new Error('AGENT_ADMIN_BOOTSTRAP 格式无效，请重新运行配置向导生成；内容未显示。'); }
}
