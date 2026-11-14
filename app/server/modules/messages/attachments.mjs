import { uploadInfo } from '../../../shared/uploads.mjs';
import { AppError } from '../../../shared/errors.mjs';

export async function readAttachments(paths = [], files) {
  if (!Array.isArray(paths) || paths.length > 4) throw new AppError('attachments 必须是最多 4 个路径的数组。', 400);
  const result = [];
  for (const [index, locator] of paths.entries()) {
    try {
      uploadInfo(locator);
      if (!files) throw new Error('当前服务未提供工作区附件读取。');
      result.push(await files.read_upload({ path: locator }));
    } catch (error) {
      // 不暴露底层绝对路径；始终指出用户需要修正的附件序号。
      const reason = error.status ? error.message : '文件不存在、不可读取或不是当前用户的普通文件。';
      throw new AppError(`attachments 第 ${index + 1} 项：${reason}`, 400);
    }
  }
  return result;
}

export function attachInput(input, attachments, spec) {
  if (attachments.some(file => file.image) && !(spec?.inputs || ['text']).includes('image'))
    throw new AppError('当前模型不支持看图，请在 config/models.json 为支持图片输入的模型标注 inputs，或换用这样的模型', 400, 'MODEL_IMAGE_UNSUPPORTED');
  const result = [...input];
  const notes = attachments.filter(file => !file.image).map(file => `用户上传了文件：${file.path}（可用 read_file 读取）`);
  if (notes.length) {
    const index = result.findIndex(item => item.type === 'text');
    if (index >= 0) result[index] = { ...result[index], text: `${result[index].text}\n${notes.join('\n')}` };
    else result.push({ type: 'text', text: notes.join('\n'), text_elements: [] });
  }
  for (const file of attachments) if (file.image)
    result.push({ type: 'image', url: `data:${file.contentType};base64,${file.content.toString('base64')}` });
  return result;
}
