# 课程网站与阶段演示

课程网站与教学工作台包含 s00–s18 十九个阶段；机制课程 s01–s18 共 52 节。工作台连接 s03–s11，s12–s18 提供独立部署说明。

在仓库根目录运行：

```bash
npm --prefix course ci && npm --prefix course run web
```

课程包无 npm 依赖，只使用 Node 内置模块。浏览器访问终端显示的地址；工作台用法见 [web/README.md](web/README.md)，服务器部署见 [deploy/README.md](deploy/README.md)。

```bash
npm --prefix course test
npm --prefix course run test:web
npm --prefix course run course:check
```

`test` 执行离线用例；`test:web` 还会监听本地端口并用已安装的 Chrome 运行浏览器测试，可设置 `CHROME_PATH`。没有 Chrome 时浏览器用例显示跳过。课程更新用 `npm --prefix course run course:build`。
