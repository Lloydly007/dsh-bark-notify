# dsh-bark-notify

[![license](https://img.shields.io/github/license/Lloydly007/dsh-bark-notify)](LICENSE)
[![version](https://img.shields.io/github/package-json/v/Lloydly007/dsh-bark-notify)](package.json)

DeepSeek Harness（DSH）的 Bark 推送插件：对话回合结束时给手机推一张卡片；可选在 agent 等你选择 / 批准、以及后台任务结束时推。

**English.** Bark push notifications for DeepSeek Harness: a card when a turn finishes, optional cards when the agent waits for a choice or approval and when a background job settles. Devices and every card parameter are configured in Settings → Plugins → Bark notify; config edits apply on the next push.

## 功能

- **回合完成 / 出错**：`turn/end` 为 `completed` 推 ✅，`error` / `max-tokens` 推 ❌；你自己按停、打断、子代理回合不推。
- **等你回应**：`ask_user_question` 推「❓ 等你选择」（带问题、标题和选项），工具要权限确认时推「🔐 等你批准」（带原因和工具名）。
- **后台任务（可选，默认关闭）**：只推没人 `await` 的 job 结算，跳过 teardown 和子代理任务，可设最短时长。
- **卡片内容**：会话标题或第一条真人消息作副标题，最后一条回复作摘要；时长按事件自己的 `time` 计算。
- **可靠投递**：网络错误、超时、429、5xx 自动重试（默认 1 次）；按 bark-server 返回的 `data[]` 逐台核对，失效 key 会告警且只显示前 6 位。
- **所有参数可在 GUI 改**：设置 → 插件 → **Bark 通知**。启用开关、设备 key 也在每次推送时重新读取，改完下一次推送生效。

## 安装

要求：DSH Desktop 已初始化 profile；手机安装 [Bark](https://apps.apple.com/app/bark-customed-notifications/id1403753865) 并拿到设备 key。

### 从 GitHub 安装

```powershell
dsh plugin --profile desktop add https://github.com/Lloydly007/dsh-bark-notify.git
```

（其他 profile 把 `desktop` 换成你的 profile 名。）也可以在 设置 → 插件 → 安装 里填 `https://github.com/Lloydly007/dsh-bark-notify.git`。装完重启一次 DSH Desktop，设置 → 插件 → **Bark 通知** 里填服务器和设备 key。

### 本地开发

```powershell
git clone https://github.com/Lloydly007/dsh-bark-notify.git
cd dsh-bark-notify
npm install
node simulate.mjs   # 63 项仿真，不惊动手机
```

把仓库 link 进 profile（在 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 里加 `"dsh-bark-notify": "link:<仓库绝对路径>"`），或让插件管理器按本地路径安装，然后重启 DSH。

## 配置

- **服务器**：默认 `https://api.day.app`；可填自建 bark-server，结尾斜杠会自动去掉，`host:port` 会自动补 `https://`。
- **设备 key**：每行一个；一台一个 key，同 key 去重。仓库里的 `cordis.patch.yml` 故意不带任何 key，安装后在设置页填。
- **改动立即生效**：设置页写的是 profile patch 层的 volatile 配置，插件每次推送重新读；只有改 `index.js` / `client.js` 代码后才需要重启或重载插件。
- 完整字段见设置页，或下面的参数表。

## 触发口径

| 事件 | 作用 |
|---|---|
| `session/event` → `turn/start` | 开一个回合，记录事件自己的 `time` |
| `session/event` → `user/message`（`source.kind` 为 `user` 或 `schedule`） | 标记「人发起的回合」，顺手取标签；其它来源（runtime-context / time-context / skill-catalog）只用于跳过 |
| `session/event` → `assistant/message` | 留最后一条回复的摘要（Markdown 剥离版 + 原文版） |
| `session/event` → `turn/end` | `completed` → ✅；`error` / `max-tokens` → ❌；`aborted` / `interrupted` / `blocked` / `forked` 静默 |
| `session/event` → `tool/call`（`ask_user_question`） | ❓ 等你选择：回合没结束，必须单独推 |
| `session/event` → `approval/asked` | 🔐 等你批准：带 `reason` 与 `toolName` |
| `ctx.jobs.events` → `settled`（可选） | 🛠 后台任务完成 / ❌ 后台任务失败：只推 `awaited !== true` 且 `cause !== 'teardown'` 的主会话任务 |
| `session/disposed` | 清掉该会话的未完结回合 |

**不触发**：子代理会话、用户自己按停/打断、没有用户消息开启的回合、短于 `minTurnSeconds` 的回合；`notifyOnQuestion` / `notifyOnApproval` 关掉后对应的「等你回应」卡不推；后台任务卡默认关闭。

## 卡片

- 标题：`✅ 对话完成` / `❌ 对话出错` / `❓ 等你选择` / `🔐 等你批准` / `🛠 后台任务完成` / `❌ 后台任务失败`
- 副标题：`<会话标签> · 2 分 13 秒`。标签优先 `sessionTitle` 服务的会话标题 → 该会话自己的第一条真人消息 → 本轮短句。
- 正文：最后一条回复摘要（默认 80 字）；`markdown` 关闭时剥掉标记，打开时原样交给 App 渲染。提问卡是 `【问题标题】问题 + 选项`；批准卡是原因 + 工具名；任务卡是命令/标签 + 失败详情。

## Bark 参数

字段名、类型、取值按 Bark 官方参数参考（[params.md](https://github.com/Finb/Bark/blob/master/docs/params.md)、[bark-server API V2](https://github.com/Finb/bark-server/blob/master/docs/API_V2.md)）：

| 官方参数 | 本插件字段 | 说明 |
|---|---|---|
| `device_keys` | `deviceKeys` | 数组，一次推多台；去重后放进同一个请求 |
| `level` | `level` | `active` / `timeSensitive` / `passive` / `critical` |
| `volume` | `volume` | 0–10，仅 `level=critical` 时发出 |
| `call` | `call` | 开 = 发 `"1"`，铃声循环约 30 秒 |
| `sound` | `sound` | 铃声名；内置 32 个在设置页做成 datalist |
| `group` | `group` | 同组推送在通知中心与历史里归到一起 |
| `icon` / `image` | `icon` / `image` | 图标 / 展开可见的大图 |
| `badge` | `badge` | `-1` 不发、`0` 清角标、`>0` 设为该数字 |
| `isArchive` | `isArchive` | 开 = `"1"`、关 = `"0"`（都会发） |
| `ttl` | `ttl` | 历史保留秒数 |
| `id` | `collapse` + `collapseId` | 同一个 `id` 替换上一条；`collapseId` 支持 `{session}` / `{kind}` / `{turn}` 占位 |
| `url` / `action` | `url` / `action` | 点击跳转 / 点击行为：`alert`、`none`、空 = 默认 |
| `copy` | `copy` | 复制内容，留空复制正文 |
| `markdown` | `markdown` | 开 = 发 `markdown` 字段（`body` 被忽略） |

未实现：`ciphertext` / `iv`（端到端加密）、`delete`（删除指定通知）。本插件自己的参数：`server`、`notifyOnSuccess`、`notifyOnFailure`、`notifyOnQuestion`、`notifyOnApproval`、`notifyOnJobSuccess`、`notifyOnJobFailure`、`minTurnSeconds`、`minJobSeconds`、`preview`、`previewChars`、`trace`、`retries`、`timeoutMs`、`logFile`、`logMaxBytes`、`enabled`。

## 诊断

- `trace`：把 `turn/start`、`user/message`、`turn/end`、提问/批准、后台任务结算写进 Host 日志。
- `logFile`：每次推送/事件一行；超过 `logMaxBytes`（默认 1 MiB）把旧文件改名为 `.1` 再继续写。
- `node selftest.mjs <key> …`：真推一张自检卡到指定设备（会响手机）。
- `node simulate.mjs`：63 项分支仿真，打到本机假 bark 服务器，不惊动手机。

## 兼容与限制

- 在 DSH Desktop（2026-10）上验证；其他版本未测试。
- 公开 bark-server 一次最多 10 个 `device_keys`，自建不限；本插件把所有 key 放进同一个请求。
- 设备 key 只存在本机 profile patch 里，不写进仓库、不进日志；日志里的 key 只保留前 6 位。
- 一个回合只推一张完成卡；后台任务卡与回合卡可能先后各推一张，这是预期行为。

## License

MIT
