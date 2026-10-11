/**
 * 浏览器 playground —— 不经过 iLink / 微信，直接在网页里跟 companion 聊天。
 *
 * 目标：让未拿到腾讯 iLink/ClawBot 准入的用户也能完整体验 AI 人设、
 *      长期记忆、关系阶段、情绪/好感度演进。
 *
 * 与 bot.mjs 主管线的差异：
 *   - 不发微信、不跑 sendTyping、不拆段分发；直接整段 JSON 返回
 *   - 不处理图片/语音/媒体（playground 只接受文本）
 *   - 仍然写 companion_conversation_turns 让记忆系统正常工作
 *   - postProcess 仍然异步执行（好感度 + 心情 + 记忆提取 + 画像更新）
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import { generateReply, embedText, consumeReplyFailure, markReplyFailureInto, LLM_FALLBACK_REPLY } from './ai.mjs';
import {
  recallMemoriesSemantic, recallMemories, getUserProfile, getConversationContext,
  getDailySchedule, getRecentSchedules, getPersonaFacts, shanghaiDateKey,
  saveConversationTurn, getCompanionById, patchCompanion,
  getCompanionPreferencesForPrompt,
  recordSafetyEvent,
} from './db.mjs';
import { buildSystemPrompt } from './companion.mjs';
import { buildLongTermDigest } from './plan_tasks.mjs';
import {
  computeRelationshipStage, syncUpdateCompanionState, detectIntimacyOvereach,
  detectUserConfession, consumePendingCelebration, extractAndSaveMemories,
  extractAndUpdateUserProfile,
} from './memory.mjs';
import { safeOutboundReply, detectSafetyRisk, scrubPhotoImpersonation } from './moderation.mjs';
import { buildStickerPromptHint, hasStickers, parseStickerMarkers } from './stickers.mjs';
import {
  getEmotionStateWithDefaults, updateEmotionFromUserMessage,
  updateEmotionFromAssistantReply, buildEmotionPromptHint, getMissingLevel,
  getNeglectStage, buildReunionHint,
} from './emotion_state.mjs';
import { generateInnerMonologue, buildInnerOsHint } from './inner_os.mjs';
import { extractOpenLoops, detectAndResolveOpenLoops } from './open_loops.mjs';

/**
 * @param {object} companion 由调用方查好的 companion 行
 * @param {string} userText 用户输入（文本）
 * @param {object} [opts]
 * @param {boolean} [opts.probe=false] 探针模式：跑链路但零持久化（见下）
 * @param {object} [opts.failureSink] P0-B 请求级失败观测对象。传入后，若本次回复来自
 *   LLM 失败兜底（正文 = LLM_FALLBACK_REPLY），该对象会被写入 `{failed:true, reason}`；
 *   调用方据此把 `source` 标成 `api_fallback`。**请求级对象，天然无并发竞态**（见 ai.mjs 注释）。
 * @returns {Promise<{reply:string, segments:object[], state:object, apiFailed:boolean, apiFailureReason:string|null, neglectStage:string, stateUpdated:boolean}>}
 *   注：本函数**不再**在生成失败时 throw——生成失败会退回 LLM_FALLBACK_REPLY 并置
 *   `apiFailed=true`，由调用方按 source 契约决定是否换成本地语料（见 game_dnf.mjs）。
 *   这样做的原因：状态推进（好感/心情/阶段）不应因一次生成失败而丢掉。
 */
// probe（探针模式）：跑通整条对话链路（含 #310 的 inner-OS double-pass）但**零持久化**——
// 不写 conversation turns / memory / emotion / profile / safety / open loops / postProcess。
// 供 scripts/playground_probe.mjs 每日合成探针用（对外通道心跳），配合合成 companion id<0 双保险。
export async function playgroundChat(companion, userText, { probe = false, failureSink = null } = {}) {
  if (!companion) throw new Error('companion 不存在');
  const text = String(userText || '').trim();
  if (!text) throw new Error('userText 不能为空');
  if (text.length > 2000) throw new Error('userText 过长（>2000）');

  // 先留一句"他说的原话没变"，供下面的 last_user_reply_at 写回前判定
  const _prevLastUserReplyAt = companion.last_user_reply_at || null;

  // ── P0-A：写回「他刚刚真的说话了」 ─────────────────────────────────────────
  // 这是 companions.last_user_reply_at 在 DNF 链路上的**唯一写入点**。
  // 此前全仓只有 proactive_engine.mjs:321 的 recordUserReplied 会写，而它只在 proactive
  // 链路被调用 → DNF 链路该列恒 null → getNeglectStage / buildReunionHint / getMissingLevel
  // / runArcTimeTickBatch / checkProactiveDeadman 全部静默失效。
  // 刻意放在**生成之前**（而不是末尾）：真实玩家发过话就是事实，不该因为 LLM 挂掉、
  // 超时熔断或任何后续异常而丢失这个事实。放在这里也天然保证下面的重逢提示读到的
  // 是"本轮之前"的空窗（_prevLastUserReplyAt 已在函数入口留档）。
  // best-effort：写失败只记日志，绝不阻断回复。
  if (!probe) {
    try {
      patchCompanion(companion.id, { last_user_reply_at: new Date().toISOString() });
    } catch (e) {
      log('warn', `[Playground] last_user_reply_at 写回失败 companion=${companion.id}: ${e.message}`);
    }
  }

  // v1.10.6: 睡眠拦截（与微信端 bot.mjs 一致）。睡着了网页也不回复，前端显示"睡眠中"。
  // maybeSleepBlock 内含挽留延后逻辑：用户说"再陪陪我/别睡"等会延后入睡继续聊。
  if (!probe) {   // 探针跳过睡眠门：maybeSleepBlock 会初始化/写 sleep schedule，且探针不应被"睡着"早退
    try {
      const { maybeSleepBlock } = await import('./sleep.mjs');
      const gate = maybeSleepBlock({ companionId: companion.id, msgType: 'text', content: text });
      if (gate.blocked) {
        return { sleeping: true, reply: null, segments: [], state: null };
      }
    } catch (e) {
      log('warn', `[Playground] sleep gate error: ${e.message}`);
    }
  }

  // ── local/custom: minor_guard 未成年人检测已砍（单机私服无此场景）──────────

  // ── v1.9.0 #1 + v1.9.1: 安全风险检测 + 温度收紧 ──────────────────────────
  let userMsgSafetyLevel = 'none';
  try {
    const risk = detectSafetyRisk(text);
    userMsgSafetyLevel = risk.level;
    if (risk.level !== 'none' && !probe) {
      recordSafetyEvent({
        companionId: companion.id,
        userId: companion.user_id,
        level: risk.level,
        signals: risk.signals,
        sourceText: text,
      });
      log('warn', `[Safety] level=${risk.level} companion=${companion.id} signals=${risk.signals.join(',')}`);
    }
  } catch (e) {
    log('warn', `[Safety] detect failed companion=${companion.id}: ${e.message}`);
  }

  // ── 召回长期记忆 ───────────────────────────────────────────────────────────
  let memories = [];
  if (companion.memory_enabled) {
    try {
      const qEmb = await embedText(text);
      if (qEmb) {
        memories = recallMemoriesSemantic(companion.id, companion.user_id, qEmb, 7);
        if (memories.length === 0) {
          memories = recallMemories(companion.id, companion.user_id, text, 7);
        }
      } else {
        memories = recallMemories(companion.id, companion.user_id, text, 7);
      }
    } catch (e) {
      log('warn', `[Playground] semantic recall 失败: ${e.message}`);
      memories = recallMemories(companion.id, companion.user_id, text, 7);
    }
  }

  const userProfile = getUserProfile(companion.user_id, companion.id);
  const recentTurns = getConversationContext(companion.id, 10);
  const todayKey = shanghaiDateKey();
  const dailyRaw = getDailySchedule(companion.id, todayKey);
  const dailySchedule = dailyRaw ? { ...dailyRaw, date_key: todayKey } : null;
  const recentSchedules = getRecentSchedules(companion.id, todayKey, 3);
  const personaFacts = getPersonaFacts(companion.id);
  const longTermDigest = await buildLongTermDigest(companion.id, companion.user_id, { isPro: true });

  const stickerEnabled = !!companion.sticker_reply_enabled && hasStickers();
  const stickerHint = buildStickerPromptHint(stickerEnabled);

  // v1.5.2 PR E: 跟 bot.mjs 路径对齐 — 每条用户消息都重算 7 维情绪并喂回 prompt。
  // 之前 playground 完全跳过 emotion_state，导致：
  //   1. 浏览器对话时她情绪不演化
  //   2. dashboard 看到的 7 维状态因 playground 对话停滞
  //   3. playground 回复缺"她想念档"口吻
  let emotionState = getEmotionStateWithDefaults(companion.id);
  if (!probe) emotionState = updateEmotionFromUserMessage(companion.id, emotionState, text, { companion });
  const missingLevel = getMissingLevel(emotionState, companion.last_user_reply_at);
  const emotionHint = buildEmotionPromptHint(emotionState, { missingLevel });

  // v1.8.0 #3: preferences 结构化偏好账本
  const preferences = getCompanionPreferencesForPrompt(companion.id);

  // ── P0-A：冷落/重逢接进回复路径 ────────────────────────────────────────────
  // 用**本轮之前**的 last_user_reply_at（函数入口已留档为 _prevLastUserReplyAt）算冷落档，
  // 这正是"他多久没说话了"的语义。必须用留档值而不是重查 companion：本轮开头的写回
  // 已经把 DB 里的值刷成"现在"了，读它只会得到 0 秒空窗、重逢永不触发。
  let neglectStage = 'none';
  let reunionHint = '';
  try {
    neglectStage = getNeglectStage(_prevLastUserReplyAt, companion.attachment_style);
    reunionHint = buildReunionHint(neglectStage, companion.attachment_style, _prevLastUserReplyAt) || '';
  } catch (e) {
    log('warn', `[Playground] reunion hint 失败 companion=${companion.id}: ${e.message}`);
  }

  let systemPrompt = buildSystemPrompt(companion, {
    memories, userProfile, recentTurns, longTermDigest,
    promptMode: 'reply', dailySchedule, recentSchedules, personaFacts, preferences,
  }) + stickerHint + emotionHint + reunionHint;

  // 关系刚升级
  const celebration = probe ? null : consumePendingCelebration(companion.id);   // consume=写，探针跳过
  if (celebration) {
    systemPrompt += `\n\n【★ 重要：关系刚刚升级】\n刚刚你对他的好感度上升到了新的阶段：${celebration.from} → ${celebration.to}。\n这条回复要自然体现这种变化（比如更亲密的称呼、"突然觉得跟你聊得越来越来电"），但**不要直接说"我们升级关系了"**。`;
  }

  // 用户亲密词越界
  const stageNow = companion.relationship_stage || '陌生人';
  const intimacyOver = detectIntimacyOvereach(text);
  if (intimacyOver.has && (stageNow === '陌生人' || stageNow === '朋友')) {
    systemPrompt += `\n\n【★ 他用了过早的亲密词】当前 ${stageNow} 阶段；要害羞但不冷漠地委婉回避，留"以后熟了再说"钩子；多条 || 分段。`;
  }

  // 用户表白
  const userConfessed = detectUserConfession(text);
  if (userConfessed && !companion.user_confessed_at && !probe) {
    systemPrompt += `\n\n【★★ 他向你告白】必须接住。不能拒绝，不能转移话题。多条 || 分段。`;
    try {
      const newAff = Math.max(companion.affection_level || 0, 55);
      const newStage = computeRelationshipStage(newAff);
      patchCompanion(companion.id, {
        affection_level: newAff,
        relationship_stage: newStage,
        user_confessed_at: new Date().toISOString(),
      });
    } catch (e) {
      log('warn', `[Playground] 表白后处理失败: ${e.message}`);
    }
  }

  // history：playground 没有 wechat 历史，用 recent conversation turns 拼一份
  const history = recentTurns.slice(-10).map(t => ({
    role: t.role === 'assistant' ? 'assistant' : 'user',
    content: String(t.content || ''),
  }));

  // v1.8.0 #6: Inner OS 双重思考 —— 生成内心独白后注入 system prompt
  // 失败/跳过都不阻塞主流程
  const innerRes = await generateInnerMonologue({
    companion,
    userText: text,
    history,
    context: { accountId: null },  // playground 走 web 通道，没有 wechat account
  }).catch(() => null);
  // generateInnerMonologue 返回 { thought, struct } 对象——必须取 .thought（字符串），
  // 与 bot.mjs 一致。v1.21.0 改返回结构时此处漏改，曾把整个对象传 buildInnerOsHint
  // 致 .trim() 裸 500（网页通道断约 2 天）。
  if (innerRes?.thought) {
    systemPrompt += buildInnerOsHint(innerRes.thought);
  }

  let reply;
  let genThrow = null;
  try {
    reply = await generateReply(systemPrompt, history, text, {
      temperature: companion.temperature,
      max_tokens: companion.max_tokens,
      top_p: companion.top_p,
      safetyLevel: userMsgSafetyLevel,  // v1.9.1: high/medium 时收紧温度
    }, {
      // 探针模式必须传 null：探针用合成 companion（id=-1），一旦把该 id 交给
      // generateReply 的 ctx，provider 层就会往 `ai_usage_events` 写一条 id=-1 的记录，
      // 破坏"探针零污染"约束（playground_probe_smoke ⑦ 会红）。原实现根本不传 ctx，
      // 等价于 null；这里保持同一语义。failureSink 是普通对象，与 id 无关，照常传。
      companionId: probe ? null : companion.id,
      failureSink,
    });
  } catch (err) {
    // 这里兜的是"生成链路就地抛错"的极少数情形（例如 buildSystemPrompt / 模板层异常）。
    // 注意：**`generateReply` 自身从不 reject** —— 它内部就有 try/catch，provider 失败时
    // 一律 `return LLM_FALLBACK_REPLY`（见 ai.mjs）。所以"provider 挂了"在本函数里表现为
    // **成功返回一句固定兜底句**，而不是异常。
    //
    // 由此，DNF 适配层（game_dnf.mjs）的两条降级路径各有其真实触发条件（t13 复核后钉死）：
    //   · 路径①`api_fallback`：provider 快速失败（无 key / 4xx / 5xx / 连接被拒）→ 本函数
    //     正常返回兜底句 + failureSink.failed=true → 适配层标 `api_fallback`（Go 丢弃正文）；
    //   · 路径②`local`：本函数在 `CHAT_API_TIMEOUT_MS` 预算内**没返回**（provider 悬挂/慢回包）
    //     → game_dnf 的 `Promise.race` 超时 → onlineResult=null → 回落本地语料并标 `local`。
    //     **这条路径是可复现的**（门禁用"黑洞端点 + 短超时"确定性触发），不是死代码。
    genThrow = err;
    log('error', `[Playground] generateReply 失败 companion=${companion.id}: ${err.message}`);
    // 仍然不 rethrow：DNF 适配层需要一个**结构完整**的结果（它自己按 source 分流），
    // 且本轮的状态写回（好感/心情）不应因一次生成失败而丢失。下方统一走兜底句再返回。
    reply = null;
  }
  // P0-A + P0-B 的行为约定：只要玩家说了话，本轮就必须产出「可用的回复 + 已推进的状态」。
  // 生成失败时用一句通用兜底承接（DNF 适配层会按 source=api_fallback 决定是否换成本地语料）；
  // 关键是不能让状态写回被这次失败吞掉——否则好感/心情会停在原地（正是旧实现的隐性缺陷）。
  if (genThrow) {
    // 把"上游抛出的失败"补记进请求级 sink，让 DNF 适配层能拿到失败原因
    markReplyFailureInto(failureSink, String(genThrow.message || 'llm_failed'));
  }
  if (!reply) {
    // 与 ai.mjs 共用同一份文案（LLM_FALLBACK_REPLY），避免两处硬编码漂移
    reply = LLM_FALLBACK_REPLY;
  }
  // 失败判定：两条路径合流——① generateReply 内部吞掉的失败（写了 sink/map）
  // ② provider 层向上抛的失败（已在上方补记进 sink）。
  const aiFailure = (failureSink?.failed || genThrow)
    ? { failed: true, reason: String(failureSink?.reason || genThrow?.message || 'llm_failed').slice(0, 200) }
    : consumeReplyFailure(companion.id);
  reply = safeOutboundReply(reply);
  reply = scrubPhotoImpersonation(reply, companion.id);   // #281：playground 无照片链路，同罩

  // v1.5.2 PR E: assistant reply 后也走情绪更新（mood drift / energy 恢复等），跟 bot.mjs 对齐
  try {
    if (!probe) updateEmotionFromAssistantReply(companion.id, emotionState, reply, { companion });
  } catch { /* 情绪更新失败不影响主链路 */ }

  // ── P0-A：把「好感推进」从异步后处理提到响应之前 ───────────────────────────
  // 原实现把 syncUpdateCompanionState 放在下面的 fire-and-forget IIFE 里（虽因它是同步
  // 函数而在同一 turn 内生效，但依赖"IIFE 内无前置 await"这一隐式前提，脆弱且难断言）。
  // 移到此处后：① 响应里的 mood/affection/stage 一定是本次生成后的最新值；
  // ② 记忆抽取等真正的慢操作仍留在异步块里，不阻塞响应。
  let stateUpdated = false;
  if (!probe) {
    try {
      syncUpdateCompanionState(companion, text, reply);
      stateUpdated = true;
    } catch (e) {
      log('warn', `[Playground] state update 失败 companion=${companion.id}: ${e.message}`);
    }
  }

  // 拆段（与 bot.mjs 同款 || 拆分），并把 [STICKER:xxx] 标记原样保留在 segments 里
  const segments = String(reply).split(/\s*(?:\|\||｜｜)\s*/g).map(s => s.trim()).filter(Boolean);
  // 把 sticker marker 解析成 { type:'sticker', file_url } 让前端直接显示
  const richSegments = segments.map(seg => {
    const { text: t, stickers } = parseStickerMarkers(seg);
    return {
      text: t || null,
      stickers: stickers.map(s => ({
        tag: s.picked?.emotion || (s.picked?.tags && s.picked.tags[0]) || s.picked?.id || 'sticker',
        url: s.picked?.fileUrl || s.picked?.url || null,  // 可能没有 URL；前端 fallback 显示文字标签
      })),
    };
  });

  // 写入对话历史，让长期记忆系统能继续工作（探针模式零持久化，整段跳过）
  if (!probe) {
    try {
      saveConversationTurn(companion.id, 'user', text, companion.chat_mode_active);
      saveConversationTurn(companion.id, 'assistant', reply, companion.chat_mode_active);
    } catch (e) {
      log('warn', `[Playground] saveConversationTurn 失败: ${e.message}`);
    }

    // v1.8.0 #4: open loops —— 启发式 resolve 立即跑（不调 LLM，快）
    try { detectAndResolveOpenLoops(companion.id, text); }
    catch (e) { log('warn', `[Playground] resolve loop: ${e.message}`); }

    // 后处理（异步，不阻塞响应）：记忆提取 + open loops 抽取。
    // 注：syncUpdateCompanionState（好感/阶段/心情）已在上方提前同步执行（P0-A），
    // 不在这里重复调用——这是响应里的状态能"不慢一轮"的前提。
    (async () => {
      try {
        if (companion.memory_enabled) {
          await extractAndSaveMemories(companion.id, companion.user_id, text, reply);
          await extractAndUpdateUserProfile(companion.id, companion.user_id, text);
          extractOpenLoops(companion.id, text, reply).catch(err =>
            log('warn', `[Playground] extract loop: ${err.message}`)
          );
        }
      } catch (e) {
        log('warn', `[Playground] postProcess 失败: ${e.message}`);
      }
    })();
  }

  // 返回最新 companion 状态给前端实时显示。
  // P0-A：syncUpdateCompanionState 已同步执行完，这里重查拿到的就是本次生成后的最新值。
  const after = getCompanionById(companion.id) || companion;

  return {
    reply,
    segments: richSegments,
    state: {
      mood: after.current_mood,
      affection_level: after.affection_level,
      relationship_stage: after.relationship_stage,
    },
    // P0-A/B 透出给 DNF 适配层：
    //   apiFailed     —— 本次回复是否来自 LLM 失败兜底（决定 source 是 api 还是 api_fallback）
    //   neglectStage  —— 本轮判定出的冷落档（诊断/日志用）
    //   stateUpdated  —— 状态写回是否成功（诊断用）
    apiFailed: !!aiFailure.failed,
    apiFailureReason: aiFailure.reason || null,
    neglectStage,
    stateUpdated,
  };
}
