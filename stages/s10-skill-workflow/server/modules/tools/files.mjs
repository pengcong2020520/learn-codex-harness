// 安全实现通过工厂注入，快照不依赖快照之外的相对 import。
export function createTools({ files }) {
  if (!files) throw new Error("缺少受限文件服务。");
  return files;
}
