// 浏览器、命令行与服务端共用文件名和类型约束；正文校验只在服务端完成。
export const UPLOAD_TYPES = Object.freeze({ md: 'text/markdown', txt: 'text/plain', png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', webp: 'image/webp' });
export function uploadInfo(locator) {
  if (typeof locator !== 'string' || !/^inputs\/uploads\/[A-Za-z0-9\p{Script=Han}_-][A-Za-z0-9\p{Script=Han}_.-]*$/u.test(locator))
    throw new Error('路径必须是 inputs/uploads/文件名；文件名只允许字母、数字、中文、-、_、.，不能以 . 开头。');
  const name = locator.slice('inputs/uploads/'.length), extension = name.split('.').at(-1).toLowerCase();
  if ([...name].length > 100) throw new Error('文件名长度必须为 1–100 个字符。');
  const contentType = Object.hasOwn(UPLOAD_TYPES, extension) ? UPLOAD_TYPES[extension] : null;
  if (!contentType || !name.includes('.')) throw new Error('只允许 md、txt、png、jpeg、jpg、webp 文件。');
  const image = contentType.startsWith('image/');
  return { contentType, image, limit: image ? 5 * 1024 * 1024 : 256 * 1024 };
}
