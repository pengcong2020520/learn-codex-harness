# 协调面离线实验

运行 `npm run lesson -- list`，再按 lease、watch、election、fencing、isolation、service 顺序实验。每课打印问题、断言、解释与边界，实际执行同一生产模块的注入客户端测试。

替身不会访问 etcd，真实 KeepAlive、Election 的时序和 Watch 重连仍须单独运行 `ETCD_TEST_ENDPOINT=... npm run test:coordination`。
