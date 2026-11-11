# V1.6.0 七项 P1 缺陷修复记录

日期：2026-11-10。对应 `PROJECT_REVIEW_1.6.0_2026-11-10.md` 中的 D01、D02、D03、D07、D08、D14、D15。

> 发布状态：以上修复最初在 1.6.0 版本号下完成并验证，随后随 **v1.6.1** 正式发布，见 [v1.6.1 修改摘要与发布说明](RELEASE_NOTES_1.6.1.md)。下文 2026-11-10 的验证记录与 `dist-v1.6.0-p1` 构建产物保留为当时基线。

## 修复内容

| 编号 | 修复后的行为 | 主要实现 |
| --- | --- | --- |
| D01 | HTTP 200 中的业务错误、空对象、空 choices、空向量不再判定推理成功。工具调用、推理内容、合法的长度截断响应和显式自定义断言仍可通过。 | `src/detector.js` 增加按 chat/completions/embeddings/custom 的最小协议校验，再执行用户断言；显式 reachable 兼容策略保留。 |
| D02 | 修改 URL、凭据、鉴权、断言、探测或网络配置后，取消旧检测、清除旧状态/模型基线/熔断并安排补检。旧结果不会写入状态、历史或新代次告警。名称、备注、周期修改不废弃正常结果。 | `src/detectionConfig.js` 集中管理检测配置指纹；调度器在完成时校验指纹和 revision；编辑、批量修改、导入、备份还原、全局配置接入保存事务。保存失败回滚且不中断原检测；旧通知回执也校验 revision。 |
| D03 | 可解析但结构错误的配置进入原有只读保护流程，不会被空列表覆盖；原文件保留，并尝试建立 `.corrupt-*` 副本。 | `src/store.js` 检查 providers 数组、数组内对象及 global 对象结构；缺文件的新安装与合法空数组正常加载。 |
| D07 | 合并旧版或稀疏备份只修改显式提供的配置；未提供的启用状态、探测方式、维护、SLO、路由与凭据继续保留。显式 false、null、空数组可以覆盖对应配置。 | `providerConfigPatch` 区分字段缺失与默认值；新增记录补齐默认值；运行态不可从备份合并；空凭据沿用原有保留规则。 |
| D08 | 默认导出移除 URL userinfo 和敏感查询参数；界面状态、日志、通知、自定义通知 URL 占位符及检测错误脱敏。实际请求继续使用原始配置。 | `src/redact.js` 统一处理大小写、重复参数与编码参数名；URL/模型/探测/配额路径统一覆盖。表单中的 `***` 保留已有凭据，普通参数可修改；删除凭据参数或填写新值可替换。完整含密钥导出和完整备份仍保留真实配置。克隆移除 URL 凭据。 |
| D14 | 迟到的密钥回显、连接测试和保存回执不能污染另一个编辑会话。等待回显时手动输入、清空或关闭眼睛，也不会被旧值覆盖。 | 编辑会话、表单修改、密钥修改和测试请求分别编号；回调验证当前会话及表单快照；新弹窗重置按钮；关闭、Esc、遮罩及外部 class 关闭均使旧请求失效。 |
| D15 | 部分通道恢复失败后，再次故障建立新的 incident；不会被旧的全局 inAlarm 阻断。成功通道在已确认事件重试时跳过，迟到回执不能覆盖较新的通道状态。 | incident 与交付状态分开，按通道保存事件顺序/送达状态；同服务商通知顺序发送；持久化重试、旧运行态迁移、静默时段、路由调整与通道重新启用保持可补发。 |

## 验证

测试使用独立临时数据目录和隐藏 Electron 窗口；协议与通知通过 localhost 模拟端点及虚构凭据验证。

| 检查 | 结果 |
| --- | --- |
| `npm test` | 35 项通过 |
| `npm run test:unit` | 31 项通过 |
| `npm run test:regression` | 35 项通过，新增 9 项针对本轮缺陷的回归场景 |
| `npm run test:integration` | 22 项通过，新增配置变更事务、脱敏编辑、真实 IPC 延迟和多通道顺序交付场景 |
| `npm run app-test` | 通过 |
| `npm run renderer-test` | 通过，无运行错误及 CSP 拦截 |
| `npm run ui-check` | 通过，含三种宽度、深浅主题、中英文、表格容器、弹窗及键盘交互 |
| `npm run lint` / `npm run i18n-check` / `git diff --check` | 通过 |
| `npm run test:package -- dist-v1.6.0-p1` | 通过，37 份源码/资源与最终工作区一致；解包版及便携版隐藏启动、真实 IPC、界面操作和正常退出 |

## 本地构建

使用已安装且版本匹配的 Electron 45.2.3 运行时，避免重复联网下载：

```powershell
npm run dist -- --config.electronDist=node_modules/electron/dist --config.directories.output=dist-v1.6.0-p1 --publish never
npm run test:package -- dist-v1.6.0-p1
```

安装版与便携版分别位于 `dist-v1.6.0-p1/AIProviderMonitor-1.6.0.exe`、`dist-v1.6.0-p1/AIProviderMonitor-Portable-1.6.0.exe`。原 `dist-v1.6.0/` 发布文件保留。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| AIProviderMonitor-1.6.0.exe | 126322009 | `AD557E64EE10EBAD047638C6CE15301F455E9A65CBE8BD999DA4A1D0FA877D0A` |
| AIProviderMonitor-Portable-1.6.0.exe | 112897683 | `CE73BE4BA030637EB922C25AA9A46332D9C1FECFE72D7C3F549B87C5FAD28001` |

本次范围为上述七项 P1。原审查中的 P2/P3、跨日维护日期归属及新功能建议仍需后续处理；完整备份/含密钥导出继续遵循其已有凭据语义。
