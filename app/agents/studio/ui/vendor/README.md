# 浏览器静态依赖

- `marked.mjs`：`marked@17.0.6/lib/marked.esm.js` 的逐字节副本；许可证见 `marked-LICENSE.md`。
- `validators.mjs`：从 `studio-contract/schemas/` 经已有 Ajv 的 standalone 导出生成；包含 Ajv 自带的 Unicode 长度函数及相等判断函数。许可证见 `ajv-LICENSE.md`、`equal-LICENSE.md`。

页面直接加载这些文件，部署与运行不需要构建。修改契约后，在仓库根目录运行 `node app/scripts/studio-validators.mjs`，再运行 `node --test app/tests/studio-ui.test.mjs` 核对生成结果与依赖文件。不得手改生成文件，也不要引入浏览器运行时编译或外部 CDN。
