# AI Provider Monitor v1.3.0

v1.3.0 聚焦探测能力、安全边界、告警策略和运行可观测性，并补齐配置持久化与打包验证。

## 核心修复

- “启动即检测”关闭时仍会正常建立周期轮循，不再连带禁用自动调度。
- 单模型探测正确继承 Provider / 全局 TLS 校验设置。
- Provider 新增、更新、删除、启停、全局设置、备份还原和导入均检查持久化结果；写入失败时回滚内存状态并向界面提示。
- 统一 Provider 输入校验，仅允许 HTTP/HTTPS，限制字段长度、探测上限及自定义 JSON 格式。
- 加载、还原和导入时修复无效或重复 Provider ID。
- Webhook 响应体限制为 1 MiB；日志采用短周期批量落盘并在退出时同步刷盘。
- 全局设置 IPC 增加字段白名单，未知字段不会写入配置。

## 安全边界

- API Key、自定义请求头和敏感全局通知配置不再通过公共状态明文下发到渲染进程。
- Electron 渲染进程启用 sandbox，并限制新窗口和外部导航。
- 编辑秘密字段时支持“留空保持原值”。

## 探测与性能

- 支持自定义模型列表路径、Bearer / 自定义 Header / 无鉴权及自定义请求头。
- 重试支持 `Retry-After`，连续失败达到阈值后自动熔断；手动检测仍可绕过熔断。
- 支持 Chat、Embeddings、Completions 能力矩阵探测。
- 支持包含文本和 JSON 路径响应断言。
- 记录单模型耗时、平均探测延迟和 P95。
- 支持正则模型忽略规则，被忽略模型不进入探测、统计和模型变动基线。
- 可选 OpenAI 兼容 SSE 流式探测，记录首 Token 延迟与估算 token/s；每轮只额外探测一个已验证模型。

## 告警与维护

- Provider 可指定通知通道路由；留空时继续广播所有已启用通道。
- 维护窗口支持日期、星期和每日时间段组合匹配。
- 可配置配额查询端点、剩余额度 JSON 路径和低配额告警阈值；配额查询失败不影响健康状态。
- 低配额告警遵循维护窗口、静默时段和冷却策略。
- 未读告警不再因窗口获得焦点自动消失，需要用户显式确认。

## 界面与可观测性

- Provider 表单增加鉴权、能力矩阵、断言、模型忽略、配额和流式性能设置。
- Provider 列表可查看下一次计划检测时间。
- 详情页显示剩余配额、首 Token 延迟和流式吞吐。
- 公开自监控状态增加熔断信息。

## 验证

- 关键 JavaScript 文件通过 `node --check`。
- 针对性单元测试：13 passed / 0 failed。
- Windows NSIS 与 Portable 打包成功，构建退出码为 0。
- 解包版与 Portable 产物 `--smoke-test` 均通过。
- ASAR 内版本和关键文件已核验。

## 下载

- `AIProviderMonitor-1.3.0.exe`：Windows NSIS 安装包。
- `AIProviderMonitor-Portable-1.3.0.exe`：免安装便携版。
- `latest.yml` / `.blockmap`：自动更新元数据。
- `SHA256SUMS-1.3.0.txt`：安装产物校验值。

安装包暂未做代码签名，Windows SmartScreen 首次运行可能提示“未知发布者”。

## SHA-256

```text
0E18893EF4405BC304D6146A61D5049111C7C937B740E73EFF535C69DFD45382  AIProviderMonitor-1.3.0.exe
BFFC3C3A2E15CB0CD00667B2F59B69B204298B033B2CC9013368A93C82309625  AIProviderMonitor-Portable-1.3.0.exe
```
