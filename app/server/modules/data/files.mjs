import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { uploadInfo } from "../../../shared/uploads.mjs";
import { AppError } from "../../../shared/errors.mjs";
import { Parser } from "htmlparser2";
import { userFileOperation } from '../runtimes/user-files.mjs';


const MAX_BYTES = 256 * 1024;
export const MAX_MEDIA_BYTES = 128 * 1024 * 1024;
export function mediaFormat(content) {
  if (content.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (content[0] === 255 && content[1] === 216 && content[2] === 255) return 'jpeg';
  if (content.subarray(0, 4).equals(Buffer.from('RIFF')) && content.subarray(8, 12).equals(Buffer.from('WEBP'))) return 'webp';
  if (content.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  throw new Error('媒体正文不是支持的 png / jpeg / webp / mp4 格式。');
}

export function validateUpload(relative, content) {
  let info;
  try { info = uploadInfo(relative); } catch (error) { throw new AppError(error.message, 400); }
  if (!Buffer.isBuffer(content)) throw new AppError('上传正文必须是原始字节。', 400);
  if (content.length > info.limit) throw new AppError(info.image ? '图片不能超过 5 MiB。' : '文本不能超过 256 KiB。', 413);
  try {
    if (info.image) {
      if (`image/${mediaFormat(content)}` !== info.contentType) throw new Error();
    } else new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch { throw new AppError(info.image ? '文件头与图片扩展名不符。' : '文本必须是合法 UTF-8。', 400); }
  return info;
}

// HTML 解析器允许容错；只要求可解析且实际包含 html 或 body 元素。
export function validHtml(content) {
  try {
    let root = false, failed = false;
    const parser = new Parser({ onopentag(name) { if (name === "html" || name === "body") root = true; }, onerror() { failed = true; } });
    parser.end(content);
    return root && !failed;
  } catch { return false; }
}

// 这是受限文件工具，不是隔离同机恶意进程的 OS 沙箱。
// 不跟随符号链接，不覆盖文件；同步检查和操作之间不让出 JS 执行权。
export function createFileTools(
  projectRoot,
  { workspaceDir, sources, outputs, uid, assertCurrent = () => {} } = {},
) {
  const base =
    workspaceDir || path.join(fs.realpathSync(projectRoot), "workspace");
  const covers = (root, relative) =>
    relative === root || relative.startsWith(root + "/");
  const readable = (relative) =>
    sources &&
    sources.some(
      (source) =>
        source.actions.includes("read") && covers(source.locator, relative),
    );
  const browsable = (relative) =>
    readable(relative) ||
    (sources &&
      sources.some(
        (source) =>
          source.actions.includes("read") &&
          (!relative || source.locator.startsWith(relative + "/")),
      ));
  const writable = (relative) =>
    !covers("inputs/drafts", relative) && !sources?.some(source => source.readOnly && covers(source.locator, relative)) && (sources &&
    sources.some(
      (source) =>
        source.actions.includes("create") && covers(source.locator, relative),
    ) ||
    (outputs && covers(outputs.directory, relative)));
  function directory(file) {
    try {
      fs.mkdirSync(file, { mode: uid === undefined ? 0o700 : 0o2770 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("工作目录必须是真实目录，不能是符号链接。");
    if (uid !== undefined && process.getuid?.() === 0) fs.chownSync(file, uid, 1000);
    if (uid !== undefined) fs.chmodSync(file, 0o2770);
  }
  directory(base);

  for (const source of sources || []) {
    let info;
    try {
      info = fs.lstatSync(resolve(source.locator));
    } catch (error) {
      if (error.code === "ENOENT")
        throw new Error(
          `必需资料源目录不存在：${source.id}（${source.locator}）。请恢复资料目录或修正绑定。`,
        );
      throw error;
    }
    if (!info.isDirectory()) throw new Error(`资料源不是目录：${source.id}`);
  }

  // 只去掉目录的 ./ 前缀和末尾 /，不折叠内部空段或 ..。
  function normalize(relative, directory = false) {
    if (typeof relative !== "string") throw new Error("路径必须是字符串。");
    if (relative.length > 500) throw new Error("路径不能超过 500 个字符。");
    if (relative.includes("\\")) throw new Error("路径里有反斜杠，不允许；请使用 /。");
    if (/[\x00-\x1f\x7f]/.test(relative)) throw new Error("路径里有控制字符，不允许。");
    if (path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative))
      throw new Error("不允许绝对路径，请使用 workspace 内的相对路径。");
    if (directory) relative = relative.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
    const parts = relative ? relative.split("/") : [];
    if (parts.includes("..")) throw new Error("路径里有上级目录 ..，不允许。");
    if (parts.some(part => part.startsWith("."))) throw new Error("路径里有隐藏目录或点路径段，不允许。");
    if (parts.some(part => !part)) throw new Error("路径里有空路径段，不允许。");
    if (parts.some(part => part.includes(":"))) throw new Error("路径里有冒号，不允许。");
    if (parts.length > 12) throw new Error("路径不能超过 12 层。");
    return relative;
  }

  function resolve(
    relative = "",
    { createParents = false, file = false, binary = false, preview = false, upload = false, draft = false, report = false } = {},
  ) {
    relative = normalize(relative, !file);
    const parts = relative ? relative.split("/") : [];
    const format = path.extname(relative).slice(1).toLowerCase();
    // 新增文本格式仅供显式声明的产物使用，不能扩大上传、预览或其他资料目录的范围。
    const outputText = !draft && !report && !upload && !preview && !binary &&
      ["json", "js", "css"].includes(format) && outputs && covers(outputs.directory, relative) && outputs.formats.includes(format);
    if (file && (parts.length < 2 || (!outputText && !(draft ? /\.(json|md)$/ : report ? /\.json$/ : upload ? /\.(md|txt|png|jpeg|jpg|webp)$/i : preview ? /\.(html|png|jpeg|jpg|webp)$/i : binary ? /\.(png|jpeg|webp|mp4)$/i : /\.(md|txt|html)$/i).test(relative))))
      throw new Error(binary ? "当前只支持 png / jpeg / webp / mp4 文件。" : "当前只支持 .md、.txt 和 .html 文件。");
    let current = base;
    for (const [index, part] of ["", ...parts].entries()) {
      current = path.join(current, part);
      const last = index === parts.length;
      if (createParents && !last) directory(current);
      let stat;
      try {
        stat = fs.lstatSync(current);
      } catch (error) {
        if (last && createParents && error.code === "ENOENT") return current;
        throw error;
      }
      if (stat.isSymbolicLink() || (!last && !stat.isDirectory()))
        throw new Error("不允许通过符号链接或非目录路径访问文件。");
      if (last && file && (!stat.isFile() || stat.nlink !== 1))
        throw new Error("只允许普通文件，不允许设备、目录或硬链接。");
    }
    return current;
  }

  function persist(file, content) {
    try {
      fs.writeFileSync(file, content, {
        flag: "wx",
        mode: uid === undefined ? 0o600 : 0o660,
        flush: true,
      });
    } catch (error) {
      if (error.code === "EEXIST")
        throw new AppError("文件已存在，未覆盖，请换名后上传或写入。", 409);
      throw error;
    }
    if (uid !== undefined && process.getuid?.() === 0) fs.chownSync(file, uid, 1000);
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new Error("产物检查失败。");
  }

  function draftPath(name) {
    if (typeof name !== "string" || !/^[a-z0-9-]{1,64}\.(json|md)$/.test(name))
      throw new AppError("草稿名称须为 1–64 位小写字母、数字或连字符，并带 .json 或 .md 扩展名。", 400);
    const relative = `inputs/drafts/${name}`;
    if (!readable(relative)) throw new AppError("未授权访问这个资料范围。", 403);
    return relative;
  }

  return {
    workspace: base,
    write_draft({ name, content }) {
      assertCurrent();
      const relative = draftPath(name);
      if (!Buffer.isBuffer(content)) throw new AppError("草稿正文必须是原始字节。", 400);
      if (content.length > MAX_BYTES) throw new AppError("草稿不能超过 256 KiB。", 413);
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(content); }
      catch { throw new AppError("草稿必须是合法 UTF-8。", 400); }
      if (name.endsWith(".json")) {
        try { JSON.parse(text); } catch { throw new AppError("草稿 JSON 格式不正确。", 400); }
      }
      // 所有检查和 rename 同步完成；同一用户的分片路由保证写入在属主节点串行执行。
      const file = resolve(relative, { file: true, draft: true, createParents: true });
      const dir = path.dirname(file);
      if (!fs.existsSync(file) && fs.readdirSync(dir).filter(entry => /^[a-z0-9-]{1,64}\.(json|md)$/.test(entry)).length >= 200)
        throw new AppError("每个用户最多保存 200 个草稿，请覆盖已有草稿。", 409);
      if (fs.existsSync(file) && uid !== undefined && fs.lstatSync(file).uid !== uid)
        throw new AppError("草稿必须属于当前用户。", 403);
      const temp = path.join(dir, `.draft-${randomUUID()}`);
      try { persist(temp, content); fs.renameSync(temp, file); }
      finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
      return { path: relative, size: content.length };
    },
    read_draft({ name }) {
      assertCurrent();
      const relative = draftPath(name);
      const file = resolve(relative, { file: true, draft: true });
      if (uid !== undefined && fs.lstatSync(file).uid !== uid) throw new AppError("草稿必须属于当前用户。", 403);
      return this.read_file({ path: relative, max_chars: MAX_BYTES });
    },
    // 仅供设计工具调用，不登记为模型可直接调用的文件工具。
    design_path({ path: relative, package: packageDirectory = false }) {
      assertCurrent();
      relative = normalize(relative);
      if (!(packageDirectory ? /^outputs\/design\/[^/]+\/package-v[1-9]\d*$/.test(relative) : /^(inputs|outputs)\/.+\.html$/i.test(relative))) throw new Error('请使用 inputs/ 或 outputs/ 下的 HTML，代码包必须位于 outputs/design/<项目>/package-v<n>/。');
      if (!readable(relative)) throw new Error('未授权读取这个资料范围。');
      const owner = uid ?? fs.statSync(base).uid;
      // 0700 子目录只能由属主辅助进程检查；它会逐段拒绝链接并核对文件 uid。
      const isolated = process.getuid?.() === 0 && owner !== process.getuid();
      const file = isolated ? path.join(base, relative) : resolve(relative, { file: !packageDirectory });
      if (!isolated && packageDirectory && !fs.lstatSync(file).isDirectory()) throw new Error('代码包必须是真实目录。');
      return { file, uid: owner };
    },
    write_design_report({ path: relative, report }) {
      assertCurrent();
      relative = normalize(relative);
      if (!/^outputs\/design\/[^/]+\/qa\/[^/]+\.json$/.test(relative)) throw new Error('报告必须写入 outputs/design/<项目>/qa/。');
      if (!writable(relative)) throw new Error('未授权保存布局校验报告。');
      if (process.getuid?.() === 0 && uid !== undefined && uid !== process.getuid()) return userFileOperation(uid, 'write-design-report', { workspace: base, path: relative, report });
      const file = resolve(relative, { file: true, report: true, createParents: true });
      persist(file, JSON.stringify(report, null, 2) + '\n');
      return { path: relative };
    },
    write_upload({ path: relative, content }) {
      assertCurrent();
      validateUpload(relative, content);
      // 上传只向用户可读的 inputs 添加原始资料，不开放模型对只读资料的写权限。
      if (!readable(relative)) throw new AppError('未授权上传到这个资料范围。', 403);
      const file = resolve(relative, { file: true, upload: true, createParents: true });
      persist(file, content);
      return { path: relative, size: content.length, sha256: createHash('sha256').update(content).digest('hex') };
    },
    read_upload({ path: relative }) {
      assertCurrent();
      let info;
      try { info = uploadInfo(relative); } catch (error) { throw new AppError(error.message, 400); }
      if (!readable(relative)) throw new AppError('未授权读取这个资料范围。', 403);
      const file = resolve(relative, { file: true, upload: true });
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || (uid !== undefined && stat.uid !== uid)) throw new AppError('附件必须是当前用户的独立普通文件。', 400);
        if (stat.size > info.limit) throw new AppError('附件超过大小上限。', 400);
        const buffer = Buffer.alloc(info.limit + 1);
        let length = 0, count;
        while (length < buffer.length && (count = fs.readSync(fd, buffer, length, buffer.length - length, null))) length += count;
        const content = buffer.subarray(0, length);
        validateUpload(relative, content);
        return { path: relative, content, ...info };
      } finally { fs.closeSync(fd); }
    },
    check(relative, action, { binary = false } = {}) {
      assertCurrent();
      if (!(action === "create" ? writable(relative) : readable(relative)))
        throw new Error("未授权访问这个资料范围。");
      if (binary && (!outputs || !covers(outputs.directory, relative) || !outputs.formats.includes(path.extname(relative).slice(1).toLowerCase())))
        throw new Error("媒体只能写入 outputs 目录且格式必须声明。");
      return resolve(relative, {
        draft: action !== "create" && relative.startsWith("inputs/drafts/"), binary, file: true,
        createParents: action === "create",
      });
    },
    list_files({ path: relative = "" }) {
      assertCurrent();
      relative = normalize(relative, true);
      if (!browsable(relative)) {
        const ranges = sources?.filter(source => source.actions.includes("read")).map(source => source.locator) || [];
        throw new Error(`${relative || "."} 不在可浏览的范围内（未授权），可浏览的有：${ranges.join("、") || "无"}。`);
      }
      const entries = fs.readdirSync(resolve(relative), {
        withFileTypes: true,
      });
      return {
        path: relative || ".",
        entries: entries
          .filter(
            (entry) =>
              !entry.name.startsWith(".") &&
              browsable(relative ? `${relative}/${entry.name}` : entry.name),
          )
          .slice(0, 200)
          .map((entry) => {
            const stat = fs.lstatSync(path.join(base, relative, entry.name));
            return {
              size: stat.size, updatedAt: stat.mtime.toISOString(),
              name: entry.name,
              type: entry.isSymbolicLink()
                ? "blocked-link"
                : entry.isDirectory()
                  ? "directory"
                  : "file",
            };
          }),
        truncated: entries.length > 200,
      };
    },
    read_file({ path: relative, max_chars = 20000 }) {
      assertCurrent();
      if (!readable(relative))
        throw new Error(
          "未授权读取这个资料范围；产物写入权限不自动包含读取权限。",
        );
      const file = resolve(relative, { file: true, draft: relative.startsWith("inputs/drafts/") });
      const fd = fs.openSync(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES)
          throw new Error("只允许读取不超过 256 KiB 的普通文本文件。");
        // 有限读取，避免文件在检查后增长导致无限占用内存。
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (length > MAX_BYTES) throw new Error("文件超过 256 KiB。");
        const content = new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, length),
        );
        const source = sources
          ?.filter(
            (source) =>
              source.actions.includes("read") &&
              covers(source.locator, relative),
          )
          .sort((a, b) => b.locator.length - a.locator.length)[0];
        return {
          path: relative,
          content: content.slice(0, max_chars),
          truncated: content.length > max_chars,
          ...(sources
            ? {
                sourceId: source.id,
                revision: createHash("sha256")
                  .update(buffer.subarray(0, length))
                  .digest("hex"),
                locator: relative,
                status: "ready",
                updatedAt: stat.mtime.toISOString(),
              }
            : {}),
        };
      } finally {
        fs.closeSync(fd);
      }
    },
    read_preview({ path: relative }) {
      assertCurrent();
      if (!readable(relative)) throw new Error('未授权读取这个资料范围。');
      const file = resolve(relative, { file: true, preview: true });
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd), limit = /\.html$/i.test(relative) ? MAX_BYTES : MAX_MEDIA_BYTES;
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error('预览文件过大或不是普通文件。');
        const buffer = Buffer.alloc(stat.size + 1);
        const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (length !== stat.size) throw new Error('读取期间文件已变化。');
        return { path: relative, content: buffer.subarray(0, length) };
      } finally { fs.closeSync(fd); }
    },
    check_binary(relative, action = 'create') { return this.check(relative, action, { binary: true }); },
    read_binary({ path: relative }) {
      const file = this.check_binary(relative, 'read');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_MEDIA_BYTES) throw new Error('媒体超过 128 MiB 或不是普通文件。');
        const content = Buffer.alloc(stat.size + 1);
        const length = fs.readSync(fd, content, 0, content.length, 0);
        if (length !== stat.size) throw new Error('读取期间媒体已变化。');
        return { path: relative, content: content.subarray(0, length) };
      } finally { fs.closeSync(fd); }
    },
    write_binary({ path: relative, content }) {
      this.check_binary(relative);
      if (!Buffer.isBuffer(content) || !content.length || content.length > MAX_MEDIA_BYTES) throw new Error('媒体正文必须是 1 字节到 128 MiB 的 Buffer。');
      if (mediaFormat(content) !== path.extname(relative).slice(1).toLowerCase()) throw new Error('媒体正文与文件扩展名不符。');
      return this.write_file({ path: relative, content });
    },
    write_file({ path: relative, content }) {
      assertCurrent();
      if (!writable(relative)) throw new Error("未授权写入这个资料范围。");
      if (
        outputs &&
        !outputs.formats.includes(path.extname(relative).slice(1).toLowerCase())
      )
        throw new Error("产物格式不在允许列表中。");
      const binary = Buffer.isBuffer(content);
      if (binary) {
        this.check_binary(relative);
        if (!content.length || mediaFormat(content) !== path.extname(relative).slice(1).toLowerCase()) throw new Error('媒体正文与文件扩展名不符。');
      }
      if (Buffer.byteLength(content, "utf8") > (binary ? MAX_MEDIA_BYTES : MAX_BYTES))
        throw new Error(binary ? "媒体正文不能超过 128 MiB。" : "写入内容不能超过 256 KiB。");
      if (!binary && path.extname(relative).toLowerCase() === ".json") {
        try { JSON.parse(content); } catch { throw new AppError("产物 JSON 格式不正确。", 400); }
      }
      if (!binary && path.extname(relative).toLowerCase() === ".html" && outputs?.requiredChecks?.includes("format") && !validHtml(content))
        throw new Error("HTML 格式检查未通过：需要可解析且包含 html 或 body 元素。");
      const file = resolve(relative, { file: true, createParents: true, binary });
      persist(file, content);
      return {
        path: relative,
        bytes: Buffer.byteLength(content, "utf8"),
        created: true,
        ...(outputs
          ? {
              artifact: {
                locator: relative,
                revision: createHash("sha256").update(content).digest("hex"),
                format: path.extname(relative).slice(1),
                checks: ["file-exists", "format"],
              },
            }
          : {}),
      };
    },
  };
}
