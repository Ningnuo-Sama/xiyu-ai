/**
 * 主入口（local/custom 精简版：砍掉微信 iLink 轮询池）
 *
 * DNF 恋人系统改造：只保留 REST API + 主动消息调度 + 计划任务。
 * 微信/iLink 渠道整体移除；registerBotAccount 等保留 no-op 桩以兼容 api.mjs 的
 * setBotPoolHandle 注入。游戏渠道走 /api/companions/:id/playground-chat。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import 'dotenv/config';
import { getDb } from './src/db.mjs';
import { startApiServer, setBotPoolHandle } from './src/api.mjs';
import { startProactiveScheduler } from './src/proactive.mjs';
import { startPlanTasks } from './src/plan_tasks.mjs';
import { loadAdminCredentials } from './src/admin.mjs';
import { log } from './src/logger.mjs';

// ── 微信池 no-op 桩（local/custom: iLink 渠道已砍） ──────────────────────────
export function registerBotAccount() { return false; }
export function unregisterBotAccount() { return false; }
export function listBotPool() { return []; }

async function runLoop() {}

async function bootstrap() {
  getDb();
  log('info', '[Main] 数据库初始化完成');

  // 初始化管理员凭据（首次启动会生成并打印一次密码）
  loadAdminCredentials();

  // 启动 REST API
  startApiServer();
  setBotPoolHandle({ registerBotAccount, unregisterBotAccount, listBotPool });

  // 主动消息 + 计划任务（无微信绑定时自动跳过发送，仅积累素材）
  startProactiveScheduler();
  startPlanTasks();

  log('info', '[Main] local/custom 精简启动完成（微信渠道已砍，游戏渠道走 REST API）');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

process.on('SIGTERM', () => {
  log('info', '[Main] SIGTERM 收到，退出中...');
  setTimeout(() => process.exit(0), 1000);
});
process.on('SIGINT', () => {
  log('info', '[Main] SIGINT 收到，退出中...');
  setTimeout(() => process.exit(0), 1000);
});

bootstrap().catch(err => {
  log('error', `[Main] 启动失败: ${err.message}\n${err.stack}`);
  process.exit(1);
});
