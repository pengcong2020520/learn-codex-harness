import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";


const MAX_BYTES = 256 * 1024;

// 这是受限文件工具，不是隔离同机恶意进程的 OS 沙箱。
// 不跟随符号链接，不覆盖文件；同步检查和操作之间不让出 JS 执行权。
export function createFileTools(
  projectRoot,
  { workspaceDir, sources, outputs, assertCurrent = () => {} } = {},
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
    !sources?.some(source => source.readOnly && covers(source.locator, relative)) && (sources &&
    sources.some(
      (source) =>
        source.actions.includes("create") && covers(source.locator, relative),
    ) ||
    (outputs && covers(outputs.directory, relative)));
  function directory(file) {
    try {
      fs.mkdirSync(file, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("工作目录必须是真实目录，不能是符号链接。");
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

  function resolve(
    relative = "",
    { createParents = false, file = false } = {},
  ) {
    if (
      typeof relative !== "string" ||
      relative.length > 500 ||
      /[\\\x00-\x1f\x7f]/.test(relative) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        "请使用 workspace 内的相对路径，例如 documents/result-v1.md。",
      );
    }
    const parts = relative ? relative.split("/") : [];
    if (
      parts.length > 12 ||
      parts.some(
        (part) => !part || part.startsWith(".") || part.includes(":"),
      )
    ) {
      throw new Error(
        "路径不能包含隐藏目录、上级目录或空路径段。",
      );
    }
    if (file && (parts.length < 2 || !/\.(md|txt)$/i.test(relative)))
      throw new Error("当前只支持 .md 和 .txt 文件。");
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

  return {
    workspace: base,
    check(relative, action) {
      assertCurrent();
      if (!(action === "create" ? writable(relative) : readable(relative)))
        throw new Error("未授权访问这个资料范围。");
      return resolve(relative, {
        file: true,
        createParents: action === "create",
      });
    },
    list_files({ path: relative = "" }) {
      assertCurrent();
      if (!browsable(relative)) throw new Error("未授权浏览这个资料范围。");
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
          .map((entry) => ({
            name: entry.name,
            type: entry.isSymbolicLink()
              ? "blocked-link"
              : entry.isDirectory()
                ? "directory"
                : "file",
          })),
        truncated: entries.length > 200,
      };
    },
    read_file({ path: relative, max_chars = 20000 }) {
      assertCurrent();
      if (!readable(relative))
        throw new Error(
          "未授权读取这个资料范围；产物写入权限不自动包含读取权限。",
        );
      const file = resolve(relative, { file: true });
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
    write_file({ path: relative, content }) {
      assertCurrent();
      if (!writable(relative)) throw new Error("未授权写入这个资料范围。");
      if (
        outputs &&
        !outputs.formats.includes(path.extname(relative).slice(1).toLowerCase())
      )
        throw new Error("产物格式不在允许列表中。");
      if (Buffer.byteLength(content, "utf8") > MAX_BYTES)
        throw new Error("写入内容不能超过 256 KiB。");
      const file = resolve(relative, { file: true, createParents: true });
      try {
        fs.writeFileSync(file, content, {
          flag: "wx",
          mode: 0o600,
          flush: true,
        });
      } catch (error) {
        if (error.code === "EEXIST")
          throw new Error(
            "文件已存在，未覆盖。请使用新版本文件名，例如 result-v2.md。",
          );
        throw error;
      }
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw new Error("产物检查失败。");
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
