# AI Provider Monitor v1.4.0

v1.4.0 集中在三件事上：通知通道状态看得见、日报去重标记不再丢、配置与凭据的生命周期收口。

## 核心修复

- **通知通道健康面板误报「未使用」**：钉钉等通道明明已启用且配置完整，面板仍显示「未使用」。原因是面板只遍历发送记录，而健康记录在启用后尚未产生、测试发送又不记账、且只存在内存里一重启就清空。现在按「开关 + 配置完整性」渲染五态，测试发送计入健康记录，记录落盘到 `notify-health.json`。
- **日报去重标记被归一化剥离**：`lastReportDay` 不在已知键白名单里，保存任意设置后该键被丢弃，导致同一天重复发送日报。现已纳入白名单并做 `YYYY-MM-DD` 校验，非法值清空（宁可多发一次也不永久漏发），且该键只在主进程维护，渲染层通过 `global:set` 写入会被拒绝。
- **凭据清除后残留旧健康状态**：清除某通道的 Webhook / Token / Key 时同步重置该通道健康记录，避免新配置沿用上一套凭据的绿灯或红灯。
- **测试发送结果不刷新界面**：`notify:test` 成功与失败都主动推送状态快照，点完测试按钮面板立即变绿或变红，不必等下一轮检测。

## 安全与校验

- 导入、合并还原与手工新增走同一套 Schema 校验：坏正则、非 HTTP(S) 地址、未知通知通道在入口拦下。
- 备份覆盖还原的 global 一律经过归一化：数值钳位、时间格式校验、未知键丢弃。
- 设置页所有敏感项与 Provider 的 API Key / 自定义请求头 / 专用代理均可从界面清除；留空仍表示不修改。
- Provider 代理地址在状态快照中掩码下发；敏感字段只下发 `*Configured` / `*Masked` 标志。

## 告警与统计

- **延迟劣化告警**：服务在线但连接延迟连续 N 轮超过阈值时推送，阈值与轮数可配，受静默时段、维护窗口与冷却约束。
- **故障升级提醒**：故障持续指定分钟数仍未恢复时重复推送，避免长时间故障只提醒一次。
- **未读告警逐条确认**：点击未读徽标打开列表，可逐条确认或一键全部确认。
- **SLA 报表**：统计页与导出报告（HTML / CSV / Excel）新增故障次数、MTTR、最长故障三项指标。

## 界面

- 通知页健康面板五态：`未使用` / `配置不完整` / `已启用 · 待发送` / `正常 · 最后成功 {t}` / `连续失败 {n} 次 · {t}`，鼠标悬停显示最后一条错误；状态变更只局部刷新面板，不会清空正在输入的密钥框。
- 批量编辑：勾选多个服务商后可批量修改轮循周期、变动上报开关、分组与代理设置。
- API Key 显隐与复制：编辑弹窗支持眼睛图标切换明文、一键复制。
- 导出默认不包含 API Key，勾选包含密钥时需二次确认；备份包含密钥时同样确认。

## 工程

- 新增 `tests/i18n-check.js`：扫描 `renderer/app.js` 的 `tx('…')` 与 `index.html` 的 `data-i18n`，缺键直接退出码 1。当前 150 键、缺失 0。
- 新增 `tests/ui-check.js` 健康面板六条 DOM 断言，其中一条是反向断言「已启用未发送时不再显示未使用」。
- `tests/unit-logic.js` 增加健康落盘与 `lastReportDay` 持久化两组用例。

## 验证

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 单元测试 | `node tests/unit-logic.js` | 25 passed / 0 failed |
| 模块冒烟 | `node tests/smoke.js` | 35 通过 / 0 失败 |
| 代码规范 | `npx eslint main.js preload.js src renderer scripts tests` | 退出码 0 |
| i18n 缺键 | `node tests/i18n-check.js` | 150 keys, missing 0 |
| 应用自检 | `npx electron . --smoke-test` | APP-SMOKE-OK |
| 渲染层自检 | `npx electron tests/renderer-check.js` | RENDERER-CHECK-OK，CSP 未拦截任何资源 |
| 界面行为 | `npx electron tests/ui-check.js` | UI-CHECK-OK |

打包与产物核验：

- `npm run dist` 生成 NSIS 与 Portable 两个 x64 包，退出码 0。
- `dist/win-unpacked/AI Provider Monitor.exe` 版本元数据为 `1.4.0` / `1.4.0.0`。
- 已比对 `app.asar` 与工作区：`main.js`、`preload.js`、`src/notifier.js`、`src/store.js`、`renderer/app.js`、`renderer/i18n.js` 六份文件 SHA-256 完全一致，确认产物由最终代码构建。
- 解包版以 `AIPM_DATA_DIR` 指向临时目录启动，日志确认数据目录自适应、每日自动备份与快捷键注册均正常，退出后无残留进程。
- 钉钉通道端到端核对：对模拟机器人 Webhook 发一次测试，健康记录 `{fails:0,lastOkAt}` 立即落盘到 `notify-health.json`，新进程读回一致，面板判定为「正常」。
- 打包过程中 `rcedit` 首次写版本资源报 `Unable to commit changes` 并重试，重试后版本信息写入成功（上表已核验）。

## 下载

- `AIProviderMonitor-1.4.0.exe`：Windows NSIS 安装包。
- `AIProviderMonitor-Portable-1.4.0.exe`：免安装便携版。
- `latest.yml` / `.blockmap`：自动更新元数据。
- `SHA256SUMS-1.4.0.txt`：安装产物校验值。

安装包暂未做代码签名，Windows SmartScreen 首次运行可能提示“未知发布者”。

## 升级说明

- 从 1.3.x 直接覆盖安装即可，配置格式版本自动迁移。
- 升级后首次打开通知页，已启用且配置完整的通道显示「已启用 · 待发送」，点一次「测试」即可看到绿灯与最后成功时间。
- 通道健康记录从本版本开始落盘，1.3.x 期间的历史发送记录不会补写。

## SHA-256

```text
794CBDDA1DBC220107E52B4705604FCCB54CD873B2C78994BEB6F61A688553C6  AIProviderMonitor-1.4.0.exe
23833C3020189E3B48C9A2A6BA205E2A45147D4E1F5F6D68713836B7A0FF2553  AIProviderMonitor-Portable-1.4.0.exe
```
