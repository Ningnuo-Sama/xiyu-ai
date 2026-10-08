# xiyu-ai → DNF 恋人系统大脑 · 接手报告

> 日期：2026-10-09 · 分支：`local/custom` · 状态：**骨架完成，LLM 渠道未接，端到端未验收**

## 1. 项目定位

把开源 AI 陪伴框架 [dimang01/xiyu-ai](https://github.com/dimang01/xiyu-ai)（上游 ★36，Node + SQLite）砍成
**DNF 恋人系统专用大脑**：无 UI、无账号、无微信，只暴露两个出口给 ACT12 游戏服务端：

| 出口 | 路由 | 入参 | 出参 |
|---|---|---|---|
| 1:1 私聊 | `POST /game/chat` | `{npc, text}` | `{reply, sleeping, mood, affection, relationship_stage}` |
| 游戏邮件 | `POST /game/mail` | `{npc, hint?}` | `{title, body}`（塞拉邮局格式） |

- 监听 `127.0.0.1:3366`（仅本机），鉴权固定令牌：header `x-game-token`，值在 `.env` 的 `GAME_TOKEN`
- 健康检查：`GET /health`（免鉴权）
- NPC 按名字匹配 `companions` 表（如 软糖小桃子 / 奶盖小团子）

## 2. 路径与 Git

| 项 | 值 |
|---|---|
| 源码 | `D:\GitHub\xiyu-ai`（浅克隆 depth=50） |
| 远端 | `origin → github.com/dimang01/xiyu-ai`（仅上游，无用户远端） |
| 分支 | `local/custom`（全部本地定制在此）；上游 `main` 未动 |
| 提交链 | `d3b80b7` 依赖白名单 → `62d145f` 极限砍成 DNF 大脑 → `9123f95` 砍 minor_guard |
| 启动 | `node index.mjs`（workdir: `D:\GitHub\xiyu-ai`） |
| 端口登记 | `D:\GitHub\PORTS.md` 已登记 3366 |

## 3. 已砍内容（相对上游）

- ❌ 微信 iLink 全渠道（轮询池/凭据/限速队列/bot.mjs 入口）
- ❌ `api.mjs` 多租户 REST 服务（账号/邮件验证/计费/管理后台/Web UI/Prompt 调试面板）
- ❌ proactive 主动调度、cron 计划任务（"主动找你"由 DNF 服务端自行调 mail 实现）
- ❌ 照片/自拍/语音/ASR/TTS/贴纸
- ❌ minor_guard 未成年人检测（playground.mjs 活跃路径；api/bot 中引用为死代码未动）

**保留的核心管线**（`/game/chat` 走 `playgroundChat` 全链路）：
7 层记忆 + 语义召回、情绪状态机、关系弧/好感度推进、persona_guard 人设守护、
moderation 危机干预（detectCrisisLevel）、睡眠门（sleeping 时返回 `sleeping:true` 不回复）。
`safe_mode` 字段保留但恒为 0（无写入方）。

## 4. 本地文件（不进 Git）

- `.env`：`API_PORT=3366`、`AUTH_MODE=local`、`GAME_TOKEN=dnf-local-dev-token`
- `.admin-credentials`：首次启动生成的管理员凭据（本形态已不用 admin，可删）
- `data/`（SQLite）：运行时生成

## 5. 验证状态（如实）

| 项 | 结果 |
|---|---|
| `npm install` + better-sqlite3 重建 | ✅ |
| `node --check` 全部入口/新文件 | ✅ |
| 真实启动 + `/health` | ✅ `{"ok":true,"mode":"dnf-brain"}` |
| 鉴权（无/错 token → 401，NPC 不存在 → 404） | ✅ |
| **LLM 真实对话/邮件端到端** | ❌ **未验收**（chat provider 未配置） |
| 上游 `npm run check:imports` | 上游 Windows 路径 bug（`D:\D:\` 双前缀），非本次改动 |

## 6. 下一步（按序）

1. **接 LLM**：`.env` 配 chat provider 指向本地 CLIProxyAPI 网关（OpenAI 兼容）。
   参考字段：`CHAT_PROVIDER` / `CHAT_BASE_URL` / `CHAT_API_KEY_NAME` / `CHAT_MODEL`（详见 `.env.example`）。
2. **造恋人角色**：启动后向 DB 写入/或临时借用 setup 流程创建 companion（名字 = DNF 假人名），
   人设写进 persona；验证 `getAllActiveCompanions` 能查到。
3. **端到端验收**：`POST /game/chat` 真实聊 3 轮（确认记忆/好感度推进）+ `POST /game/mail` 出一封信。
4. **DNF 服务端接入**：私聊包 → `/game/chat`；恋人来信 → `/game/mail`；亲密度显示读 `affection`/`relationship_stage`。
5. （可选）上游同步：`git fetch origin && git rebase origin/main` 到候选分支，冲突预计集中在 `playground.mjs`。

## 7. 已知边界 / 风险

- **记忆按 NPC 存、不按玩家存**：单机端（≈单玩家）没问题；多玩家需给管线加 playerId 维度。
- 上游活跃更新中（handoff 文档式协作），锁当前 SHA 再定制；rebase 需回归第 5 节验收。
- `getAllActiveCompanions` 的 SQL JOIN 了 users/wechat_accounts，无绑定时靠 LEFT JOIN 返回——
  创建角色时若要求 account 绑定字段，注意补占位（验收时确认）。
- LLM key 属付费资源：接入与测试遵循"付费操作提前请示"。
