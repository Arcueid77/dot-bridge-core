# dot-bridge-core

[简体中文](README.zh-CN.md) · [English](README.md)

已有 dot 桥的唯一共享实现，要求 Node.js >=24.15 且 <25。包中不含模型 API、平台 SDK、生产凭据、数据库或 Tunnel key。部署通过固定版本包使用，无需单独克隆此仓库。

## 提供的能力

- 严格的 HTTPS 回调传输、公网 DNS/IP 和 TLS 校验、loopback 聚合路由。
- 私有目录、文件、数据库、Windows ACL 与单机锁检查。
- 加密 SQLite 收件箱、发件箱、轮询游标、消息去重、订阅世代和优雅停止。
- 本人配对的专用入口：显式批准、临时口令或官方扫码、验证后独占保存，不覆盖旧凭据。
- 受保护的 SILK／音频转换、可选本地 Whisper、PDF／Office／文本摘录。
- 真实渐进回复、有界 typing 与处理反馈、同会话／话题／发言人近期上下文。
- 可选的长文分段计划与逐段确认、本人私聊状态／队列／订阅／取消命令。
- 绑定原消息的加密分块文件上传，以及按发起人、会话和话题核对的原生选项回传。
- 工作日与固定间隔提醒、暂停与恢复、发送历史和分页列表。

默认只有配对的本人私聊。Telegram／Discord 可显式配置群、成员白名单或全员、@／关键词／全消息触发与上下文范围。原 dot 的私有记忆由原平台管理，群任务必须禁止披露私聊记忆。

每个附件最多 5 MiB。原件、转写和截断摘录分开表达；私有下载引用和密钥只在加密状态中保留。处理前后和每次出站阶段都会重新核对授权。结果不明的发送保持 `uncertain`，升级、重启与重复工具调用都不会自动重发。

新字段与状态表采用增量方式；保留原 storage key、绑定、队列、去重和订阅。需要降级时先处理在途渐进回复，不能用旧数据库覆盖已收到的新消息。配置、MCP 接口与各平台差异见[渠道合同](docs/channel-provider-contract.md)和[总仓库配置说明](https://github.com/Arcueid77/dot-bridge/blob/main/docs/new-channels.md)。

原 dot 的暂停、会话重置和审批留在原平台；桥状态明确报告控制能力未接通，不调用未公开接口。


## 配置与接口

| 项目 | 用法 |
| --- | --- |
| 交互策略 | Telegram／Discord／微信使用 `DOT_BRIDGE_INTERACTION_POLICY_FILE`；飞书沿用自己的策略格式 |
| 接收范围 | 默认本人私聊；Telegram／Discord 的受控群显式配置并协调 `conversation=configured` 订阅 |
| 状态 | 共享渠道的 `get_<channel>_reply_status` 查询最终发送，处理提示租约独立；最终尚未排队时保持 `none` |
| 进度 | Telegram／Discord／QQ 传完整累计文本，飞书传新增文本；序号从 1 连续递增 |
| 订阅 | 共享渠道租期最多七天，实际以返回数据为准；原 dot／平台负责续订 |
| 原 dot 控制 | 暂停、会话重置、审批保持原平台操作流程 |

每个后端与路由器分别使用独立 service key，MCP 和内部上游均保持 loopback。官方 Tunnel 的一个 target 指向聚合路由器，并使用聚合 key 的文件引用。runtime key 用于运行 Tunnel，来源消息的授权仍由桥的已核对绑定与范围判断。

## 本地处理运行环境

受保护的 PDF／Office／音频处理目前使用 Linux 进程。准备 root 所有、服务用户不可写的 FFmpeg、Python 3、prlimit；PDF 提取需要主机安装 `pypdf`。文档工作进程通过管道接收数据并返回有界摘录；不将不完整摘录当作完整文件。

本地 Whisper 可选配置：

```dotenv
DOT_BRIDGE_AUDIO_TRANSCRIPTION=local-whisper
DOT_BRIDGE_WHISPER_BINARY=/protected/runtime/whisper-cli
DOT_BRIDGE_WHISPER_MODEL=/protected/runtime/ggml-base.bin
DOT_BRIDGE_AUDIO_GUARD=/protected/runtime/no-core-dump.so
```

保护程序、模型及父目录的属主和权限。`audio/no-core-dump.c` 构建的 guard 使子进程不可转储；共享私有锁目录配合 flock 串行识别。通道附件仍限 5 MiB、语音最多两分钟。运行资源不足、格式不可用或超时会返回提取状态，原件保持可用。

Windows 的私有文件检查需要已安装的 Python，可用 `DOT_BRIDGE_PYTHON` 指定绝对路径。Linux／Windows 是当前验证目标；macOS 尚未验证，欢迎试用并反馈。

## 开发与版本维护

```sh
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
npm run check
npm test
```

以已提交、干净的固定 SHA 打包，消费仓库记录 core 版本、源 SHA 和压缩包 SHA-256。同一发行组合使用同一份 core 包。文档修改维护提取清单的规范化哈希；安装和真实账号接入分别验证。

配置、凭据与数据留在源码目录外。升级先处理在途工作，保留原 key／数据库；七天逻辑清理与 journal、WAL、备份各自的保留策略分别管理。开发接口见[渠道合同](docs/channel-provider-contract.md)，部署见[统一入口](https://github.com/Arcueid77/dot-bridge)。
