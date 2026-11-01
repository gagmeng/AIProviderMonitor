# AI Provider Monitor v1.5.0

v1.5.0 是一轮架构与体验的双升级：主进程完成模块化拆分，新增全局暂停、日志管理、90 天可用率色条、分组折叠与拖拽排序、空状态引导、托盘逐服务商菜单六项能力。

## 架构

- **main.js 模块化拆分**：从约 1350 行瘦身为约 600 行，只保留生命周期、窗口、托盘、未读队列、状态快照与 IPC 装配。全部 IPC handler 按域拆入 `src/ipc/` 六个模块（providers / global / history / backup / transfer / misc），通过统一的 ctx（db 访问器 / 持久化 / 状态推送 / 调度器）注入依赖；状态报告三件套（CSV / 自包含 HTML / Excel）迁至 `src/report.js`。行为零变更，全部回归与 E2E 兜底。

## 新功能

- **全局暂停检测**：托盘菜单勾选项与仪表盘按钮一键暂停全部自动轮循；手动检测不受影响。暂停期间到期的定时器转入 30 秒低频轮询（不检测、不丢服务商），恢复时全部重挂、错过周期的立即补检。暂停为内存态，重启后自动恢复检测。
- **日志页管理**：级别下拉（debug/info/warn/error）与按服务商过滤（匹配日志行 `[名称]` 标记），与关键字过滤三者叠加；底部「日志文件」卡片列出磁盘文件（大小 / 时间），支持删除单个文件——新 IPC `logs:deleteFile` 只接受 `aipm-YYYYMMDD.log(.N)` 命名规则，路径穿越直接拒绝。
- **90 天可用率色条**：详情弹窗新增 status-page 风格色条，每天一格（绿 ≥99% / 橙 ≥90% / 红 / 灰 = 无数据），悬浮显示当日可用率与样本数；数据来自新聚合 `history.perDay` 与 IPC `history:perDay`。
- **分组折叠 + 拖拽排序**：服务商工具条新增「分组」开关，按 group 分节显示（未分组垫底），节头显示在线数并支持折叠；无筛选的扁平列表中按行首手柄拖拽重排，`provider:reorder` 校验 ID 集合完整性（重复 / 缺失 / 多余均拒绝）后整体落盘，前端乐观更新、失败回滚。
- **空状态三步引导**：无服务商时仪表盘给出「新增第一个服务商 → 配置通知渠道 → 完成首轮检测」向导，每步带直达按钮与完成态绿勾。
- **托盘菜单增强**：右键菜单逐服务商显示状态与可用模型数（超过 15 个折叠为汇总行），点击唤起主窗口并直达该服务商详情。

## 界面优化

- 服务商列表选择列从 44px 加宽到 66px，拖拽手柄与勾选框拉开间距（8px），手柄图标缩小至 13px 并降低对比度。
- 手柄常驻占位：分组视图 / 筛选状态下不可拖拽时位置保留，勾选框不左右跳动。

## 验证

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 单元测试 | `node tests/unit-logic.js` | 31 passed / 0 failed（新增暂停补检、perDay 聚合 2 用例） |
| 模块冒烟 | `node tests/smoke.js` | 35 通过 / 0 失败 |
| 代码规范 | `npx eslint main.js preload.js src renderer scripts tests` | 退出码 0 |
| i18n 缺键 | `node tests/i18n-check.js` | 178 keys, missing 0 |
| 应用自检 | `npx electron . --smoke-test` | APP-SMOKE-OK |
| 渲染层自检 | `npx electron tests/renderer-check.js` | RENDERER-CHECK-OK |
| 界面行为 | `npx electron tests/ui-check.js` | UI-CHECK-OK |
| 真应用 E2E | CDP 驱动完整应用（独立数据目录 + 隔离 userData） | 25 passed / 0 failed |

E2E 覆盖（新增 8 项）：暂停/恢复状态翻转、仪表盘暂停按钮文案、排序合法重排与非法 ID 拒绝、perDay 返回当日数据、日志文件列表、路径穿越与不存在文件删除被拒、新 UI 资产齐备、空态引导退出；前 17 项（v1.4.1 回归）对拆分后的 IPC 全链路重跑通过。

打包与产物核验：

- `npm run dist` 生成 NSIS 与 Portable 两个 x64 包，退出码 0（rcedit 无重试，版本一次写入成功）。
- `dist/win-unpacked/AI Provider Monitor.exe` 版本元数据为 `1.5.0` / `1.5.0.0`。
- 已比对 `app.asar` 与工作区：主进程 5 个模块、`src/ipc/` 全部 6 个 handler、渲染层 3 个文件与图标资产共 18 份文件 SHA-256 完全一致，asar 内 `package.json` 版本为 1.5.0。
- 解包版以 `AIPM_DATA_DIR` + 隔离 `--user-data-dir` 启动，日志确认数据目录自适应、快捷键注册与每日自动备份正常，验证后按 PID 清理无残留进程。
- 界面间距调整经真实实例截图核验（四服务商同视角）。

## 下载

- `AIProviderMonitor-1.5.0.exe`：Windows NSIS 安装包。
- `AIProviderMonitor-Portable-1.5.0.exe`：免安装便携版。
- `latest.yml` / `.blockmap`：自动更新元数据。
- `SHA256SUMS-1.5.0.txt`：安装产物校验值。

安装包暂未做代码签名，Windows SmartScreen 首次运行可能提示“未知发布者”。

## 升级说明

- 从 1.4.x 直接覆盖安装即可，配置格式无迁移。
- 全局暂停为内存态：重启后自动恢复检测，属预期行为。
- 拖拽排序结果写入 `providers.json` 的服务商顺序，随配置持久化。

## SHA-256

```text
48A91E9A7599A133D3017D01236623C0EEC80D81B11F11CB01E99F536EC93055  AIProviderMonitor-1.5.0.exe
A9E89E7DA9F0DC13E723EECC8C369A651E556660388D0D1C84CDC185D9EE8B30  AIProviderMonitor-Portable-1.5.0.exe
```
