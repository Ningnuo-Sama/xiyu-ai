/**
 * 主入口（local/custom：DNF 恋人系统专用大脑，极限精简版）
 *
 * 出口只有两个，全部走 DNF 游戏服务端：
 *   POST /game/chat  — 1:1 私聊（玩家 ↔ 恋人 NPC）
 *   POST /game/mail  — 游戏邮件（恋人主动来信/回信文本生成）
 *
 * 砍掉：微信 iLink、REST 多租户服务(api.mjs)、Web UI、账号/认证/计费、
 * 照片/语音/ASR/TTS、proactive 调度、cron 计划任务、admin。
 * 保留核心：SQLite 记忆/情绪/关系弧/好感度 + playground 回复管线。
 *
 * 鉴权：固定令牌 env GAME_TOKEN（header x-game-token），仅限本机游戏服务端调用。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import 'dotenv/config';
import express from 'express';
import { log } from './src/logger.mjs';
import { getDb } from './src/db.mjs';
import { gameRouter } from './src/game_dnf.mjs';

const PORT = Number(process.env.API_PORT) || 3366;
const TOKEN = String(process.env.GAME_TOKEN || '').trim();

const app = express();
app.use(express.json({ limit: '64kb' }));

// 固定令牌鉴权（health 豁免）
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!TOKEN) return res.status(503).json({ ok: false, error: 'GAME_TOKEN 未配置' });
  if (String(req.header('x-game-token') || '') !== TOKEN) {
    return res.status(401).json({ ok: false, error: 'token 无效' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, mode: 'dnf-brain' }));
app.use('/', gameRouter);

app.use((_req, res) => res.status(404).json({ ok: false, error: 'not found' }));
app.use((error, _req, res, _next) => {
  log('error', `[Game] 未捕获异常: ${error.message}`);
  res.status(500).json({ ok: false, error: error.message || 'internal error' });
});

getDb();

// 进程保活护栏：捕获未处理的 Promise 拒绝与异常，严防突发网络波动导致守护进程退出
process.on('unhandledRejection', (reason) => {
  log('warn', `[Main] 捕获到未处理的 Promise 拒绝（已静默拦截，服务保持常驻）: ${reason?.message || reason}`);
});
process.on('uncaughtException', (err) => {
  log('error', `[Main] 捕获到未处理异常: ${err?.message || err}`);
});

log('info', '[Main] DNF 大脑模式启动（出口：/game/chat 1:1私聊 + /game/mail 游戏邮件）');
app.listen(PORT, '127.0.0.1', () => log('info', `[Main] DNF 大脑已启动 port=${PORT}（仅监听本机）`));
