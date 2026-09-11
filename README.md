# AI Provider Monitor

一款基于 **Electron** 的 AI 服务商（AI Provider）状态与可用模型监控桌面应用。采用 iOS 风格界面设计，支持按服务商自定义周期自动轮循检测连接状态与模型可用性，并在**模型发生变动**时通过微信、QQ、钉钉实时推送通知。

适用于企业内部 AI 网关、OpenAI 兼容中转站、本地推理服务（vLLM / Ollama / One-API 等）的可用性巡检与模型变更监控。

---

## 目录

- [系统功能](#系统功能)
- [界面预览](#界面预览)
- [系统架构](#系统架构)
- [实现方案](#实现方案)
- [技术特点](#技术特点)
- [安装与运行](#安装与运行)
- [操作使用说明](#操作使用说明)
- [项目结构](#项目结构)
- [常见问题](#常见问题)

---

## 系统功能

### 1. 服务商管理

| 功能 | 说明 |
|------|------|
| 新增 / 编辑 | 供应商名称、URL、API Key、轮循周期、模型变化上报开关、备注 |
| 删除 | 单个删除（带确认弹窗） |
| 全选 / 反选 | 一键全选、反选当前筛选结果 |
| 批量删除 | 多选后批量删除，带确认提示 |
| 批量手动检测 | 对选中服务商立即触发一轮检测 |
| 搜索 | 按名称 / URL / 备注 实时过滤 |
| 启用开关 | 临时停用某个服务商的周期轮循（保留配置） |
| API Key 保护 | 界面仅显示掩码（`sk-R****pB9d`），编辑留空表示不修改 |

每个 AI Provider 由以下字段构成：

| 字段 | 必填 | 说明 |
|------|------|------|
| 供应商名称 | ✅ | 自定义显示名称 |
| URL | ✅ | API 根地址（自动补全 `https://`，去除尾部 `/`），如 `https://api.openai.com` |
| API Key | ❌ | Bearer Token，用于 `/v1/models` 与 `/v1/chat/completions` 鉴权 |
| 轮循周期 | ✅ | 秒为单位（最低 5 秒），到达周期自动检测 |
| 模型变化上报 | ✅ | 开启后，模型数量或可用状态变化时触发通知 |
| 备注 | ❌ | 自由文本 |

### 2. 轮循检测引擎

- **连接状态**：请求 `/v1/models`，判定 在线 / 异常 / 离线 三态，并记录延迟（ms）
- **模型列表**：兼容 OpenAI（`data[].id`）、Ollama（`models[].name`）、纯数组三种响应格式
- **模型可用性**：对每个模型发送最小 `chat/completions` 请求（`max_tokens=1`），2xx 或可路由的 4xx 判为可用；404 / 401 / 403 / 429 / 5xx / 超时分别给出具体失败原因
- **状态语义**：

| 状态 | 判定条件 | 含义 |
|------|----------|------|
| 🟢 在线 up | 至少 1 个模型可用 | 服务正常 |
| 🟠 异常 degraded | 连接成功但所有模型不可用 | 服务在但模型全挂 |
| 🔴 离线 down | 连接失败（网络/超时/DNS） | 服务不可达 |

- 每轮探测数量默认上限 8 个，超出部分标记为「未探测」，避免大模型列表拖慢周期

### 3. 变动通知

当某服务商「模型变化上报」开启，且本轮检测的 **状态或可用模型集合** 与上一轮不同（新增可用 / 失去可用 / 状态翻转）时，向已启用的通道推送变化详情：

- **微信**：企业微信群机器人 Webhook
- **QQ**：OneBot v11 HTTP 服务（NapCat / Lagrange / go-cqhttp），支持私聊与群聊、access_token 鉴权
- **钉钉**：自定义群机器人 Webhook，支持官方**加签**安全设置

三个通道相互独立、可同时开启，任一通道失败不影响其它通道。

### 4. 仪表盘

- 在线 / 异常 / 离线 / 可用模型总数 四张统计卡
- 「最近检测」活动流（最近 8 条，含状态、可用率、错误信息）
- **双击任意条目**打开该服务商状态详情

### 5. 服务商状态详情

- 状态横幅：三态配色 + 可用率 + 延迟
- 元信息：URL、API Key 掩码、轮循周期、最近检测时间、备注、连接错误
- 可用模型标签云（点击复制模型名）
- 不可用 / 未探测列表：**每个模型旁显示具体失败原因**（模型不存在 404 / 鉴权失败 / 速率受限 / 服务端错误 / 超时 / 未探测）
- **双击服务商列表行任意位置**即可打开详情

### 6. 日志

- 运行日志实时滚动（新增服务商、检测开始/完成、通知成功/失败、配置变更等）
- 按级别着色（info / warn / error / debug）
- 同时落盘到数据目录 `logs/aipm-YYYYMMDD.log`

### 7. 系统集成

- 系统托盘常驻：显示主界面 / 立即检测全部 / 退出；关闭窗口仅隐藏到托盘
- 单实例锁：重复启动自动唤起已有窗口
- 快捷键：`Ctrl+R` 立即检测全部、`F5` 重载界面、`F12` 开发者工具、`Ctrl+Q` 退出

---

## 界面预览

```
┌─────────────────────────────────────────────────────────────┐
│ ⌘ Provider Monitor                                          │
│ ┌─────────┐  仪表盘                                          │
│ │ 仪表盘   │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐   │
│ │ 服务商 2 │  │ 🟢 在线 │ │ 🟠 异常 │ │ 🔴 离线 │ │ ⚡ 模型 │   │
│ │ 通知     │  └────────┘ └────────┘ └────────┘ └────────┘   │
│ │ 日志     │  最近检测                                       │
│ ├─────────┤  ● Provider A     8/8 模型可用      在线 10:35   │
│ │ 运行检测 │  ● Provider B     0/3 模型可用      异常 10:36   │
│ │ 数据目录 │                                                  │
└─────────────────────────────────────────────────────────────┘
```

iOS 风格设计语言：SF 系统字体栈、毛玻璃侧栏、圆角卡片（16px）、iOS 原生配色（`#0a84ff` 蓝 / `#30d158` 绿 / `#ff9f0a` 橙 / `#ff453a` 红）、iOS 开关与复选框控件、脉冲状态动画、模态缩放过渡、Toast 轻提示。全部图标为手绘 24×24 高精度线性 SVG（stroke 1.8，SF Symbols 风格），**无任何 emoji**。

---

## 系统架构

```
┌──────────────────────────────────────────────────────────────┐
│                        Electron 应用                          │
│                                                              │
│  ┌─────────────── 主进程 (main.js) ────────────────┐          │
│  │                                                 │          │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │          │
│  │  │ store.js │  │scheduler │  │  notifier.js │   │          │
│  │  │ 数据持久化│←─│  调度器   │→ │  通知发送     │───┼──→ 微信   │
│  │  └──────────┘  └────┬─────┘  └──────────────┘   │───→ QQ    │
│  │                     ↓                            │───→ 钉钉  │
│  │  ┌──────────┐  ┌──────────┐                     │          │
│  │  │ logger.js│  │detector.js│──→ Provider API     │          │
│  │  │ 日志系统  │  │ 检测引擎  │   (/v1/models 等)   │          │
│  │  └──────────┘  └──────────┘                     │          │
│  └──────────────────────┬──────────────────────────┘          │
│                         │ IPC (contextBridge)                 │
│  ┌──────────────────────┴──────────────────────────┐          │
│  │            渲染进程 (preload.js 沙箱桥接)          │          │
│  │                                                 │          │
│  │  index.html + styles.css + app.js + icons.js    │          │
│  │  仪表盘 / 服务商 / 通知 / 日志 四视图 SPA          │          │
│  └─────────────────────────────────────────────────┘          │
└──────────────────────────────────────────────────────────────┘
```

### 进程职责划分

| 进程 | 文件 | 职责 |
|------|------|------|
| 主进程 | `main.js` | 应用生命周期、窗口/托盘管理、IPC Handler 注册、检测结果落库与变动判定 |
| 主进程模块 | `src/store.js` | providers.json 读写（原子 JSON 持久化），便携版/安装版数据目录自适应 |
| 主进程模块 | `src/scheduler.js` | 每 Provider 独立定时器、并发池（默认 4）、手动检测去重、周期变更热重载 |
| 主进程模块 | `src/detector.js` | HTTP(S) 探测引擎：模型列表拉取、逐模型可用性探测、失败原因分类 |
| 主进程模块 | `src/notifier.js` | 三通道通知：企业微信 / OneBot v11 QQ / 钉钉加签 |
| 主进程模块 | `src/logger.js` | 内存环形缓冲（600 条）+ 按天落盘 + 实时订阅推送 |
| 预加载脚本 | `preload.js` | contextBridge 暴露类型安全的 `window.aipm` API（`contextIsolation: true`，`nodeIntegration: false`） |
| 渲染进程 | `renderer/*` | 无框架原生 SPA：视图切换、状态渲染、事件委托、弹窗/Toast |

### IPC 通道清单

| 通道 | 方向 | 说明 |
|------|------|------|
| `state:get` / `state-changed` | R→M / M→R | 全量状态快照拉取与推送 |
| `provider:add` / `update` / `delete` / `deleteMany` | R→M | 服务商 CRUD |
| `provider:checkNow` / `checkAll` | R→M | 手动检测（批量/全部） |
| `provider:toggleEnabled` | R→M | 启用/停用轮循 |
| `global:set` | R→M | 全局通知与检测选项 |
| `notify:test` | R→M | 通道测试消息 |
| `logs:get` / `log:line` | R→M / M→R | 日志拉取与实时推送 |
| `open:path` | R→M | 打开数据/日志目录 |

---

## 实现方案

### 检测流水线（detector.js）

```
detect(provider)
  ├─ GET  {base}/v1/models          ← Bearer 鉴权，20s 超时
  │    ├─ 失败 → status=down, error="连接失败: ..."
  │    └─ 成功 → 提取模型列表（OpenAI/Ollama/数组格式自适应）
  │
  └─ 对前 probeLimit(=8) 个模型并行 POST /v1/chat/completions
       body: { model, messages:[{role:"user",content:"ping"}], max_tokens:1 }
       ├─ 2xx                    → 可用
       ├─ 400 / 413 / 422        → 可用（请求已路由到模型，仅参数被拒）
       ├─ 404                    → 不可用「模型不存在」
       ├─ 401 / 403              → 不可用「鉴权失败或无权限」
       ├─ 429                    → 不可用「请求速率受限」
       ├─ 5xx                    → 不可用「服务端错误」
       ├─ 超时                    → 不可用「探测请求超时」
       └─ 超出上限                → 不可用「未探测」
```

### 变动判定与通知触发（main.js）

```
applyResult(provider, result):
  prev = snapshot(provider)                    // {status, modelsAvailable}
  prevKey = prev.status + sorted(prev.models)
  nextKey = result.status + sorted(result.models)
  modelChanged = prevKey !== nextKey           // 状态或模型集合任一变化
  if modelChanged && provider.notifyOnModelChange && prev:
      notifyModelChange(全局配置, provider, prev, provider)
```

通知消息示例：

```
【AI Provider 模型变动】
服务商：Provider B
状态：up → degraded　可用模型 0/3
失去可用：gpt-5.6-terra, gpt-5.6-luna
时间：2026/9/11 10:56:03
```

### 三通道通知实现（notifier.js）

| 通道 | 端点 | 请求体 | 鉴权 |
|------|------|--------|------|
| 企业微信 | 群机器人 Webhook | `{ msgtype:"text", text:{ content } }` | key in URL |
| QQ (OneBot v11) | `{base}/send_private_msg` 或 `/send_group_msg` | `{ user_id \| group_id, message }` | `Authorization: Bearer <token>`；校验响应 `retcode===0` |
| 钉钉 | 自定义机器人 Webhook | `{ msgtype:"text", text:{ content } }` | 加签：`timestamp + "\n" + secret` 的 HMAC-SHA256 Base64 附到 URL；校验响应 `errcode===0` |

### 调度器设计（scheduler.js）

- **每 Provider 一个绝对定时器**：周期变更即时重置，避免漂移；执行完一轮后从最新配置重新计算下轮间隔
- **并发池**：全局默认 4 并发（可配 1–16），队列 + 去重（同一 Provider 检测中不接受重复手动触发）
- **停用语义**：`enabled=false` 取消定时器但保留配置，重新启用后恢复

### 数据持久化（store.js）

- 存储位置：`%APPDATA%/ai-provider-monitor/providers.json`
  - 便携版（Portable）：自动切换到 exe 同级 `AIPM-Data/` 目录（U 盘随行）
  - 支持 `AIPM_DATA_DIR` 环境变量覆盖（测试隔离用）
- 写入策略：全量 JSON 序列化 + `JSON.stringify(…, null, 2)`，检测结果每次落库

### 安全模型

- `contextIsolation: true` + `nodeIntegration: false`，渲染进程无法触达 Node API
- CSP：`default-src 'self'`，杜绝外部脚本注入
- API Key 仅存本地 JSON，界面传输已掩码，`publicProvider()` 序列化时剥离明文
- 所有渲染层插入点经过 `escapeHtml()` HTML 转义，防 XSS

---

## 技术特点

1. **零运行时第三方依赖** — 主进程业务代码纯 Node 内置模块（http/https/crypto/fs），无 Express/Axios/DB，攻击面小、打包体积小
2. **三态语义判定** — 区分「服务挂」（down）与「模型全挂」（degraded），这是普通探活工具缺失的关键信号
3. **失败原因可解释** — 每个不可用模型都带人类可读原因，而非简单布尔
4. **格式自适应** — 同时兼容 OpenAI / Ollama / 数组三种模型列表响应
5. **精确变动检测** — 对「状态 + 可用模型排序集合」做键比对，新增/失去模型精准推送，不重复打扰
6. **可测试架构** — 检测/调度/通知/存储全部模块化，冒烟测试用 mock HTTP 服务器覆盖 11 个场景；提供 `--smoke-test` 应用级自检
7. **便携部署** — Portable 版数据随 exe 目录走，即拷即用
8. **纯 Node 生成图标** — SDF 有符号距离场算法绘制圆角方块 + 心电折线，输出多尺寸 ICO（16/32/48/64/256），无图像处理依赖
9. **iOS 风格手绘 SVG 图标集** — 25+ 图标统一 24×24 viewBox / stroke 1.8 / round cap，SF Symbols 视觉规格
10. **数据随行** — 单文件 JSON 存储，可直接备份/迁移/手工编辑

---

## 安装与运行

### 环境要求

- Windows 10/11 x64（本程序打包目标平台）
- 开发模式需要 Node.js ≥ 18

### 方式一：安装版（推荐）

1. 运行 `dist/AIProviderMonitor-1.0.0.exe`
2. 按向导选择安装目录（默认安装到用户目录）
3. 完成后从桌面 / 开始菜单启动「AI Provider Monitor」

### 方式二：便携版

直接运行 `dist/AIProviderMonitor-Portable-1.0.0.exe`，无需安装。数据保存在 exe 同级 `AIPM-Data/` 目录，整个目录拷贝到 U 盘即可随行。

### 方式三：开发模式

```bash
# 安装依赖（注意：若全局 npm 配置了 omit=dev 需加 --include=dev）
npm install --include=dev

# 若 Electron 二进制下载缓慢，用镜像补装
npm_config_electron_mirror=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js

# 启动应用
npm start

# 运行测试
npm test                # 模块冒烟测试（11 用例，mock HTTP 服务器）
npm run smoke           # Electron 应用级自检

# 打包（NSIS 安装包 + 便携版）
npm run dist
```

---

## 操作使用说明

### 1. 添加服务商

1. 切换到「服务商」页签，点击右上角 **新增服务商**
2. 填写：
   - **供应商名称**：如 `OpenAI` / `内部网关`
   - **URL**：API 根地址，如 `https://api.openai.com` 或 `http://192.168.1.100:3000`
   - **API Key**：服务方的密钥（本地 Ollama 等无鉴权服务可留空）
   - **轮循周期**：默认 60 秒
   - **模型变化时上报**：开启后模型变动会推送通知
   - **备注**：可选
3. 保存后立即纳入轮循

### 2. 手动检测

- **单个**：列表行右侧 ↻ 按钮
- **批量**：勾选多个 → 工具栏「检测」按钮
- **全部**：菜单栏 文件 → 立即检测全部（或 `Ctrl+R`）、仪表盘右上角「检测全部」、托盘菜单「立即检测全部」

### 3. 批量管理

- **全选**：工具栏勾选框；**反选**：一键反转当前选择
- 批量删除与批量检测都作用于当前勾选集合，删除需二次确认
- 搜索框支持名称 / URL / 备注 模糊过滤（全选/反选仅作用于筛选可见项）

### 4. 查看模型详情

- 点击列表中服务商**名称**，或**双击行任意位置**、双击仪表盘最近检测条目
- 弹窗中：绿色标签为可用模型，红色条目为不可用模型及其失败原因；点击任意模型名复制到剪贴板

### 5. 配置微信通知（企业微信群机器人）

1. 在 PC 端微信打开一个**企业微信群**（没有可自行创建内部群）
2. 群右上角 **「…」→ 群机器人 → 添加机器人**，创建并命名（如「状态监控」）
3. 复制弹出的 Webhook 地址（形如 `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx`）
4. 粘贴到 通知 → 微信 → Webhook 地址，打开开关，点击 **发送测试消息** 验证

### 6. 配置 QQ 通知（OneBot v11）

1. 准备一个 QQ 小号作为机器人，部署任一 OneBot v11 实现：
   - [NapCat](https://github.com/NapNeko/NapCatQQ)（推荐，Windows 友好）
   - [Lagrange.OneBot](https://github.com/LagrangeDev/Lagrange.Core)
   - go-cqhttp（已停维护但仍可用）
2. 在机器人端**开启 HTTP 服务端**（NapCat `servers.httpServers` / go-cqhttp `servers.http`），监听端口默认 `5700`
3. 机器人配置了 `access_token` 的话，同步填入程序「Access Token」栏
4. 程序内填写：**机器人 HTTP 服务地址**（如 `http://127.0.0.1:5700`）、**上报目标**（QQ 号或群号）、**上报类型**（私聊/群聊）
5. 打开开关，点击 **发送测试消息** 验证

### 7. 配置钉钉通知（自定义机器人）

1. 钉钉群 → 群设置 **「…」→ 机器人 → 添加机器人 → 自定义（通过 Webhook 接入）**
2. 安全设置三选一（推荐**加签**）：
   - **加签**：复制 `SEC` 开头密钥填入程序「加签密钥 SECRET」栏
   - **自定义关键词**：填入 `监控`（本程序消息标题含该词，直接命中）
   - **IP 地址段**：填写本机公网 IP
3. 复制 Webhook 地址（形如 `https://oapi.dingtalk.com/robot/send?access_token=xxxx`）
4. 粘贴到 通知 → 钉钉 → Webhook 地址，打开开关，点击 **发送测试消息** 验证

> 三种通知通道相互独立，可同时启用；某通道故障不影响其它通道推送。服务商必须单独打开「模型变化时上报」开关才会推送。

### 8. 检测选项

- **启动时自动开始检测**：应用启动即按各服务商周期开始轮循
- **并发检测数**：同时检测的服务商数量上限（1–16），服务商多且周期短时可调大

### 9. 日志

- 切换到「日志」页签实时查看运行日志，右上角可关闭自动滚动、打开日志目录
- 日志文件按天滚动：`%APPDATA%/ai-provider-monitor/logs/aipm-YYYYMMDD.log`

### 10. 托盘与退出

- 点击窗口 ✕ 仅隐藏到系统托盘（后台持续轮循），托盘双击或右键「显示主界面」恢复
- 真正退出：托盘右键 → 退出，或菜单 文件 → 退出（`Ctrl+Q`）

---

## 项目结构

```
AIProviderMonitor/
├── main.js                  # Electron 主进程入口：窗口/托盘/IPC/结果处理
├── preload.js               # contextBridge 预加载桥接
├── package.json             # 依赖与 electron-builder 打包配置
├── src/                     # 主进程业务模块
│   ├── store.js             #   JSON 持久化（providers.json）
│   ├── scheduler.js         #   周期调度器（定时器 + 并发池）
│   ├── detector.js          #   检测引擎（模型列表 + 逐模型探测）
│   ├── notifier.js          #   微信 / QQ / 钉钉 通知
│   └── logger.js            #   日志（内存缓冲 + 按天落盘 + 订阅）
├── renderer/                # 渲染进程（无框架 SPA）
│   ├── index.html           #   四视图布局 + 三个弹窗
│   ├── styles.css           #   iOS 风格设计系统
│   ├── app.js               #   状态渲染与交互逻辑
│   └── icons.js             #   手绘 SVG 图标集（25+）
├── scripts/
│   └── gen-icons.js         # SDF 算法生成应用图标（PNG/ICO）
├── tests/
│   ├── smoke.js             # 模块冒烟测试（11 用例，mock 服务器）
│   └── app-smoke.js         # Electron 应用级自检（--smoke-test）
├── build/
│   ├── icon.ico             # 多尺寸应用图标
│   └── icon.png             # 256×256 PNG
└── dist/                    # 打包产物
    ├── AIProviderMonitor-1.0.0.exe          # NSIS 安装包
    └── AIProviderMonitor-Portable-1.0.0.exe # 便携版
```

## 数据文件格式

```json
{
  "global": {
    "notifyWeixinEnabled": true,
    "weixinWebhook": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx",
    "notifyQQEnabled": false,
    "qqWebhook": "",
    "qqTarget": "",
    "qqTargetType": "private",
    "qqToken": "",
    "notifyDingtalkEnabled": true,
    "dingtalkWebhook": "https://oapi.dingtalk.com/robot/send?access_token=xxx",
    "dingtalkSecret": "SECxxx",
    "autoStartCheckOnLaunch": true,
    "concurrency": 4
  },
  "providers": [
    {
      "id": 1789094153749,
      "name": "xxx",
      "url": "http://xxx.xxx.xxx.xxx:3000",
      "apiKey": "sk-...",
      "intervalSec": 300,
      "notifyOnModelChange": true,
      "note": "",
      "enabled": true,
      "status": "up",
      "modelsTotal": 8,
      "modelsAvailable": ["model-a", "model-b"],
      "modelsUnavailable": [],
      "modelDetails": [{ "id": "dead-model", "ok": false, "note": "模型不存在（HTTP 404）" }],
      "checkedAt": 1789094153726,
      "lastError": null,
      "modelChanged": false
    }
  ]
}
```

---

## 常见问题

**Q: 检测显示「在线」但可用模型为 0？**
状态为「异常（degraded）」：服务本身可达、能返回模型列表，但所有模型探测失败。展开详情查看每个模型的具体原因（最常见是 API Key 无权限或额度耗尽）。

**Q: 探测会影响服务商计费吗？**
每轮对每个模型发送一次 `max_tokens=1` 的最小请求，消耗极小。若模型很多且在意成本，可接受只拉列表不探测的折中（当前版本探测上限 8 个/轮已控制请求量）。

**Q: 通知收到了但钉钉提示 sign not match？**
「加签密钥 SECRET」与服务商机器人安全设置中的密钥不一致，或机器人实际使用的是关键词/IP 白名单校验却误填了密钥栏。两种校验方式二选一。

**Q: QQ 测试消息失败 retcode=xxx？**
确认 OneBot 实现的 HTTP 服务已开启且端口正确；`access_token` 两端一致；上报目标 QQ 号/群号正确且机器人有权限发送。

**Q: 关闭窗口后程序还在运行？**
是有意设计——关闭仅隐藏到托盘，后台轮循继续。彻底退出请使用托盘菜单或 `Ctrl+Q`。

**Q: 数据备份与迁移？**
复制 `%APPDATA%/ai-provider-monitor/` 整个目录（便携版为 exe 同级 `AIPM-Data/`），包含全部配置与日志。

---

## 许可证

MIT
