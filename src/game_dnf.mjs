/**
 * DNF 恋人系统游戏适配器（local/custom）
 *
 * 仅两个出口：
 *   POST /game/chat — 1:1 私聊：{ npc, text } → { reply, sleeping }
 *   POST /game/mail — 游戏邮件：{ npc, hint? } → { title, body }
 *
 * 角色解析：按 NPC 名字匹配 companions 表（DNF 假人恋人，如 软糖小桃子/奶盖小团子）。
 * 复用 playground 管线：情绪状态、记忆、关系弧、安全护栏全部生效。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import { Router } from 'express';
import { getAllActiveCompanions } from './db.mjs';
import { playgroundChat } from './playground.mjs';
import { buildSystemPrompt } from './companion.mjs';
import { generateReply } from './ai.mjs';

export const gameRouter = Router();

function findCompanion(npc) {
  const name = String(npc || '').trim();
  if (!name) return null;
  const all = getAllActiveCompanions() || [];
  return all.find(c => (c.name || '').trim() === name)
      || all.find(c => (c.name || '').includes(name))
      || null;
}

// ── POST /game/chat：1:1 私聊 ────────────────────────────────────────────────
gameRouter.post('/game/chat', async (req, res) => {
  const npc = req.body?.npc;
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'text 不能为空' });
  if (text.length > 2000) return res.status(400).json({ ok: false, error: 'text 过长（>2000）' });

  const c = findCompanion(npc);
  if (!c) return res.status(404).json({ ok: false, error: `恋人 NPC 不存在: ${npc}` });

  try {
    const r = await playgroundChat(c, text);
    return res.json({
      ok: true,
      npc: c.name,
      reply: r.reply ?? null,
      sleeping: !!r.sleeping,
      mood: r.state?.mood ?? null,
      affection: r.state?.affection_level ?? null,
      relationship_stage: r.state?.relationship_stage ?? null,
    });
  } catch (e) {
    log('error', `[Game] chat npc=${c.name}: ${e.message}`);
    return res.status(500).json({ ok: false, error: e.message || 'AI 生成失败' });
  }
});

// ── POST /game/mail：游戏邮件文本生成 ────────────────────────────────────────
gameRouter.post('/game/mail', async (req, res) => {
  const npc = req.body?.npc;
  const hint = String(req.body?.hint ?? '').trim().slice(0, 500);

  const c = findCompanion(npc);
  if (!c) return res.status(404).json({ ok: false, error: `恋人 NPC 不存在: ${npc}` });

  try {
    const personaPrompt = buildSystemPrompt(c, { promptMode: 'reply' });
    const instruction = [
      '现在你要给冒险家写一封塞拉邮局的简短信件（游戏内邮件）。',
      '严格按以下格式输出，不要输出任何其他内容：',
      '第一行：`标题：<不超过16字的邮件标题>`',
      '第二行起：正文（50~120字，符合你的人设和当下关系，口语自然）',
      hint ? `本次来信背景/由头：${hint}` : '',
    ].filter(Boolean).join('\n');

    const mail = await generateReply(personaPrompt, [], instruction, { max_tokens: 800 }, { companionId: c.id });
    const raw = String(mail || '').trim();
    const m = raw.match(/标题[：:]\s*(.+)\s*\n?([\s\S]*)/);
    return res.json({
      ok: true,
      npc: c.name,
      title: (m?.[1] || '来自她的信').trim().slice(0, 32),
      body: (m?.[2] || raw).trim(),
    });
  } catch (e) {
    log('error', `[Game] mail npc=${c.name}: ${e.message}`);
    return res.status(500).json({ ok: false, error: e.message || 'AI 生成失败' });
  }
});
