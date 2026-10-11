/**
 * DNF 恋人系统游戏适配器（local/custom）
 *
 * 仅两个出口（供 ACT12 服务端 / dnf-robot-act12 接入）：
 *   POST /game/chat — 1:1 私聊：{ npc, text, event_type? } → { reply, sleeping, mood, affection, relationship_stage, source }
 *   POST /game/mail — 游戏邮件：{ npc, hint?, attach_item_id? } → { title, body, attachment, source }
 *
 * 核心设计原则：
 *   1. 角色解耦：直接从 companions 表按名字匹配（软糖小桃子 / 奶盖小团子），零微信/零租户依赖。
 *   2. 双轨降级：API 优先（1.5s 快速超时熔断），超时/断网/无 key 瞬间退本地 0ms 女玩家短句语料。
 *   3. 道具合规：塞拉邮局邮件仅支持 60 版本真实可交易道具（+11/+12 生锈的武士刀垫子、炉岩碳强化材料、无色、泉水、圣经）。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDb, parseCompanionRow } from './db.mjs';
import { playgroundChat } from './playground.mjs';
import { buildSystemPrompt } from './companion.mjs';
import { generateReply } from './ai.mjs';

export const gameRouter = Router();

// 超时门限：4.0秒内未完成则快速熔断切本地，既给在线大模型充足生成时间，又符合真人打字延迟（“对方正在输入中…”）
const CHAT_TIMEOUT_MS = Number(process.env.CHAT_API_TIMEOUT_MS || 4000);

// ── 0. `source` 取值契约（与 Go 侧对齐；改动前先读这段） ───────────────────────
/**
 * `source` 是大脑告诉游戏服务端「这条回复是怎么来的」的唯一凭据，Go 侧据此决定
 * 是否丢弃并改走自己的兜底池。取值域**冻结为 7 个**（评审 B-1：早期方案只列 5 个，
 * 漏掉了大脑既有的 `proactive_shuffle` 和 Go 侧既有的 `fallback`，会把两条既有路径
 * 判成未知值）：
 *
 * | 值                  | 谁产出        | 含义（**看正文是什么，不看"有没有失败"**） | Go 侧处置        |
 * |---------------------|--------------|--------------------------------------|------------------|
 * | `api`               | 大脑 /game/chat | LLM 真实生成成功                      | 正常转录          |
 * | `api_fallback`      | 大脑 /game/chat | LLM 调用失败，**正文是固定兜底句**（"走神"那句） | **丢弃**，走本地池 |
 * | `local`             | 大脑 /game/chat | **正文是本地语料**（含"在线路径整体失败后回落本地"这种情况） | 正常转录 |
 * | `proactive_shuffle` | 大脑 /game/chat | 主动问候短路（洗牌袋直出），**语义等价 local** | 正常转录 |
 * | `sleeping`          | 大脑 /game/chat | 她处于睡眠时段，未回复                | 按「她睡了」处理，不转录 |
 * | `error`             | 大脑 /game/chat | 请求本身失败（无 NPC / 入参非法）      | **丢弃**          |
 * | `go_fallback`       | **仅 Go 侧**  | Go 自己兜底（`client.go` 的 `Source:"fallback"`） | 不出现在大脑响应里，仅用于日志/去重 |
 *
 * **两条容易搞反的语义（定调 §17 已冻结，改动前先读）**：
 *   · `api_fallback` 的判据是「**正文是固定兜底句**」→ Go 必须丢弃。
 *   · `local` 的判据是「**正文是本地语料**」→ Go 正常转录；**"在线失败后回落到本地语料"
 *     仍属 `local`**。此时"LLM 此刻不可用"这个信息由 `source_reason`（如
 *     `online_path_failed`）与计数承载——**不能靠把好内容错标成 `api_fallback` 来表达**，
 *     否则 Go 会把本来可用的本地语料当垃圾丢掉，比不改还糟。
 *
 * **未知值降级规则（硬约定）**：任何不在上表内的值，一律按 `api_fallback` 处理
 * （=「不认识 ⇒ 不许当成功」）。大脑侧由 `normalizeSource()` 强制兜住，保证自己
 * 永不产出未知值；同时这条规则是写给 Go 侧的对齐要求。
 */
export const SOURCE = {
  API: 'api',
  API_FALLBACK: 'api_fallback',
  LOCAL: 'local',
  PROACTIVE_SHUFFLE: 'proactive_shuffle',
  SLEEPING: 'sleeping',
  ERROR: 'error',
  GO_FALLBACK: 'go_fallback',
};

const SOURCE_VALUES = new Set(Object.values(SOURCE));

/**
 * 把任意值收敛到契约取值域内。**未知值一律降级为 api_fallback**——宁可让 Go 侧
 * 多走一次本地兜底，也不能让一个不认识的状态被当成"在线成功"。
 * @param {string} value
 * @returns {string} 契约内的 source
 */
export function normalizeSource(value) {
  const v = String(value ?? '').trim();
  if (SOURCE_VALUES.has(v)) return v;
  log('warn', `[Game] 未知 source "${v}" → 按 ${SOURCE.API_FALLBACK} 降级处理（契约见 SOURCE 常量表）`);
  return SOURCE.API_FALLBACK;
}

// ── 0.0 `source_reason` 取值域冻结（t13 F-3 / F-6） ──────────────────────────
/**
 * `source_reason` 是**给消费方（Go 侧）用的机器可读标记**，与"给人看的错误原文"是两回事。
 *
 * 修复背景（t13 F-3，实测复现）：原实现把 `failureSink.reason`（原始 provider 错误串）
 * 直接塞进响应 `source_reason`，实测泄漏内部信息：
 *   `source_reason = "OpenAI Compatible (自定义) 需要 OPENAI_COMPATIBLE_API_KEY，请在 .env 或 /app/setup.html 中配置"`
 * —— 里面含 `.env` 路径、`API_KEY` 变量名与 provider 名。这是**响应体不该出现**的内容。
 *
 * 现冻结为下面的**封闭枚举**：`source_reason` 只会是这几个值之一（或缺失）。
 * 原始错误文本仍然保留在**服务端日志**里（供运维定位），但绝不出响应体。
 */
export const SOURCE_REASONS = {
  /** 路径①：LLM 调用失败，正文是固定兜底句（"走神"那句）。Go 应丢弃正文、走恋人本地池。 */
  LLM_FAILED: 'llm_failed',
  /** 路径②：在线路径整体失败/超时 → 已回落**本地语料**（正文可用）。 */
  ONLINE_PATH_FAILED: 'online_path_failed',
  /** 睡眠门命中：她睡了，未生成任何内容。 */
  SLEEP_GATE: 'sleep_gate',
  /** 邮件：收到的 scenario 未注册，已可见降级为 offline_care。 */
  UNKNOWN_SCENARIO: 'unknown_scenario_not_registered',
  /** 邮件：正文超通道预算，已被可见截断。 */
  MAIL_LIMIT_CLAMPED: 'mail_limit_clamped',
  /** 兜底值：调用方传了无法识别的 reason（绝不放行未知值）。 */
  UNKNOWN: 'unknown',
};

const SOURCE_REASON_VALUES = new Set(Object.values(SOURCE_REASONS));

/**
 * 把任意值收敛到 `source_reason` 枚举内。
 * **不做"原文透传"**：非枚举值一律收敛为 `unknown`，并把原值只写进日志——
 * 这样即使上游某天又把错误原文传进来，也不会泄漏到响应体。
 * @param {string} value
 * @returns {string} 枚举内的 reason
 */
export function normalizeSourceReason(value) {
  const v = String(value ?? '').trim();
  if (SOURCE_REASON_VALUES.has(v)) return v;
  if (v) log('warn', `[Game] 非枚举 source_reason 已收敛为 ${SOURCE_REASONS.UNKNOWN}（原值仅留在服务端日志，不入响应体）`);
  return SOURCE_REASONS.UNKNOWN;
}

// ── 0.1 语料加载失败的可见化（评审 B-4） ──────────────────────────────────────
// 原实现 `catch { return 旧缓存 }` 是完全静默的：语料 JSON 写坏了、被就地编辑成非法
// 格式时，服务表现为「还在用旧语料」且**一条日志都没有**，直接导致"改了语料看不见
// 效果且没人报错"。这里补两件确定性的事：
//   ① 每次都打 WARN（含文件路径与错误原因），让"改了不生效"在日志里一眼可见；
//   ② 只在内容哈希变化时打，避免坏文件把日志刷爆（同一份坏内容只喊一次）。
const _corpusWarnSeen = new Map();   // filePath -> 上次告警的内容指纹

function warnCorpusFallback(kind, filePath, err, sha1) {
  const prev = _corpusWarnSeen.get(filePath);
  if (prev === sha1) return;          // 同一份坏内容已喊过，不重复刷
  _corpusWarnSeen.set(filePath, sha1);
  const cacheState = prev === undefined ? '（本次首次失败）' : '（内容又变了）';
  const message = `${kind} 加载失败${cacheState}，已回落旧缓存：${filePath} — ${err?.message || err}`;
  // 同时进「日志」（给人看）与「进程内计数」（给门禁断言看）。
  // 只靠日志断言是不可靠的：logger 走 createWriteStream 异步刷盘，
  // 测试进程可能在 flush 前就断言；进程内计数才是确定性的观测口。
  log('warn', `[Game] ${message}`);
  _corpusLoadFailures.push({ at: Date.now(), kind, filePath, message });
  if (_corpusLoadFailures.length > 100) _corpusLoadFailures.shift();
}

const _corpusLoadFailures = [];   // 最近若干次语料加载失败（供门禁/诊断断言）

/** 语料加载失败观测口（只读）。返回最近 N 条失败记录，含 message 与 filePath。 */
export function getCorpusLoadFailures() { return _corpusLoadFailures.slice(); }

/** 供诊断/门禁断言：查看某个语料当前生效的缓存（含 mtime），不触发重新加载。 */
export function peekCorpusCache(name) {
  const c = corpusCache[name];
  return c ? { mtime: c.mtime, data: c.data } : null;
}

// ── 1. 角色解析（完全解绑微信，直接查 SQLite companions 表） ──────────────────
function findCompanion(npc) {
  const name = String(npc || '').trim();
  if (!name) return null;
  const db = getDb();
  let row = db.prepare('SELECT * FROM companions WHERE name = ?').get(name);
  if (!row) {
    row = db.prepare('SELECT * FROM companions WHERE name LIKE ?').get(`%${name}%`);
  }
  return row ? parseCompanionRow(row) : null;
}

// ── 2. 本地女玩家短句语料矩阵（0ms 降级兜底，字数严格 < 15 字） ─────────────
// ★ 禁用称呼清零（t13 F-4）：E 类红线（硬红线文件 §5 行 105）要求"**不得硬编码任何固定称呼**"，
// 一律用可注入变量或省略称呼。本池是 `source=local` 路径的**正文来源**，玩家直接可见，
// 故必须干净：已移除「哥哥」×2（原 greeting/carry 条目）与「搬砖」×1（见下条注）。
// 需要称呼处改用 `{player_nickname}`（t30 已实现注入；缺省降级为「你」，句子仍然通顺）。
const GAMER_GIRL_CHAT_FALLBACK = {
  peach: { // 软糖小桃子（女元素，软萌黏人，手残求带）
    equip_broken: [
      // 「搬砖」按红线文件 §6 行 124 属**不约束**的年代词表（恋人语料按 C 类放开），
      // 此处仅为满足 t13 F-4 的"清零"要求而改成同义且更贴年代的「刷图」，非合规必需。
      "摸摸头不哭……明天带你刷图攒钱！",
      "呜呜碎了呀？旧的不去新的不来嘛抱抱~",
      "笨蛋别难过啦，我把私房金币都给你！"
    ],
    carry: [
      "好呀好呀！带我刷一把悬空城嘛好不好~",
      "等我下，我马上飞过来找你！",
      "呜呜我黑猫老放空，快来带我QAQ"
    ],
    greeting: [
      "在呢在呢！刚才在西海岸看海吹风呢~",
      "你终于上线啦OvO！",
      "在的在的！是不是想我啦嘻嘻~"
    ],
    jealous: [
      "呜呜你刚才跟谁组队呢……都不理我QAQ",
      "刚才站在赫顿玛尔跟谁打字呢！哼！",
      "你是不是有别的固定队了……委屈QAQ"
    ],
    default: [
      "嘻嘻，听你的~",
      "今天天气真好，一起去刷图嘛！",
      "背包又快装不下装备啦。",
      "走位手残了，快来救救我QAQ",
      "等我喝口草莓奶茶，马上就来！"
    ]
  },
  tuanzi: { // 奶盖小团子（女召唤，奶凶傲娇，口嫌体正直，缺蓝要哄）
    equip_broken: [
      "早就叫你收手别找凯丽！现在哭了吧，活该笨蛋~",
      "碎啦？谁叫你不拿我给你的武士刀垫着！",
      "……笨死算了，喏，把这把垫子拿去垫垫气！"
    ],
    carry: [
      "……好吧，勉强陪你刷一把，不许嫌我走位慢！",
      "哼，又缺输出了才想起找我？走啦进图！",
      "笨蛋狂战跑那么快干嘛，等等本姑娘！"
    ],
    greeting: [
      "叫我干嘛？才没有特意等你呢，我刚看动漫。",
      "在呢在呢，有话快说！",
      "哼，怎么才上线，我都等半小时了。"
    ],
    jealous: [
      "找你的女枪手去，理我干嘛！",
      "刚才站街跟谁打字聊那么欢呢？哼，不理你了！",
      "有本事以后都别找我组队！"
    ],
    default: [
      "笨蛋，少废话快进图！",
      "手都按酸了，等我喝口水。",
      "……知道啦知道啦，别催！",
      "又没蓝了！包里有泉水没，快给我！",
      "哼，今天刷图本姑娘输出第一！"
    ]
  }
};

// ── 2.1 外置语料动态热更加载器（基于 mtime 自动热重载，无需重启服务） ─────────
// CORPUS_DIR 可用环境变量覆盖。默认值保持原样（`path.resolve('data/dnf_corpus')`，相对
// 进程工作目录），零行为变化；覆盖能力是给测试用的——热更/坏文件/扩容门禁的自动化必须
// 能在**临时目录**里跑，绝不能去写生产语料 `data/dnf_corpus/`。
const CORPUS_DIR = process.env.CORPUS_DIR
  ? path.resolve(process.env.CORPUS_DIR)
  : path.resolve('data/dnf_corpus');
const corpusCache = {
  peach: { mtime: 0, data: null },
  tuanzi: { mtime: 0, data: null },
  heika: { mtime: 0, data: null },
  mail: { mtime: 0, data: null }
};

// 洗牌袋（Shuffle Bag）：保证一个周期内零连续重复，吃透完整 40 条语料
const shuffleBags = {
  peach: [],
  tuanzi: [],
  heika: []
};

function getNextShuffleItem(roleKey, items) {
  if (!items || !items.length) return null;
  if (!shuffleBags[roleKey] || shuffleBags[roleKey].length === 0) {
    shuffleBags[roleKey] = [...items].sort(() => Math.random() - 0.5);
  }
  return shuffleBags[roleKey].pop();
}

function loadCorpusHot(name) {
  const filePath = path.join(CORPUS_DIR, `${name}_corpus.json`);
  // t13 F-5：去重键必须是**文件内容**的 sha1，不是"错误文本"的 sha1。
  // 反例（旧实现会重复刷屏）：同一份坏内容、但每次抛出的错误消息文本略有不同
  //（例如 JSON.parse 的 position/column 随环境或前缀变化）→ 错误 sha1 每次不同 →
  // 每次请求都告警一遍。"同一份坏内容只喊一次"才是想要的语义。
  let raw = null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (corpusCache[name]?.data && corpusCache[name].mtime === stat.mtimeMs) {
      return corpusCache[name].data;
    }
    raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    // ★ 热更必须同时作废洗牌袋（t38 修抖动断言时发现的真缺陷）：
    // 洗牌袋里存的是**上一版语料**抽剩下的条目。若 mtime 变了却不清袋，新写入的条目
    // 要等旧袋里的条目全部抽完才会出现——表现为"语料改了但新句子迟迟不生效"，
    // 且让"热更后新条目已生效"这类断言变成时序竞争（偶发红）。
    // 袋子的语义是"一轮内不重复"，重载即新一轮，清空是正确的。
    if (Array.isArray(shuffleBags[name])) shuffleBags[name] = [];
    corpusCache[name] = { mtime: stat.mtimeMs, data: parsed };
    return parsed;
  } catch (err) {
    // B-4：不再静默。文件存在却解析/读取失败 = 语料写坏了，必须可见（见 warnCorpusFallback）
    if (fs.existsSync(filePath)) {
      warnCorpusFallback(`语料 ${name}`, filePath, err, corpusContentFingerprint(raw, filePath, err));
    }
    return corpusCache[name]?.data || null;
  }
}

function loadMailTemplatesHot() {
  const filePath = path.join(CORPUS_DIR, 'mail_templates.json');
  let raw = null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (corpusCache.mail?.data && corpusCache.mail.mtime === stat.mtimeMs) {
      return corpusCache.mail.data;
    }
    raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    corpusCache.mail = { mtime: stat.mtimeMs, data: parsed };
    return parsed;
  } catch (err) {
    // B-4：同 loadCorpusHot —— 邮件模板写坏必须可见，不能"改了没生效还一声不吭"
    if (fs.existsSync(filePath)) {
      warnCorpusFallback('邮件模板', filePath, err, corpusContentFingerprint(raw, filePath, err));
    }
    return corpusCache.mail?.data || null;
  }
}

/**
 * 告警去重指纹（t13 F-5）：**优先用文件内容**的 sha1；只有内容读不出来时（读盘就失败了）
 * 才退化到"路径 + 错误文本"的 sha1，保证仍然有去重能力而不是每次都喊。
 */
function corpusContentFingerprint(raw, filePath, err) {
  const basis = (raw === null || raw === undefined)
    ? `READFAIL:${filePath}:${String(err?.message || err)}`
    : String(raw);
  return crypto.createHash('sha1').update(basis).digest('hex');
}

function getLocalGamerGirlReply(companion, text, eventType = null) {
  let roleKey = 'peach';
  if (companion.name.includes('团子')) roleKey = 'tuanzi';
  else if (companion.name.includes('黑咖') || companion.name.includes('助手')) roleKey = 'heika';

  const hotData = loadCorpusHot(roleKey);
  const t = String(text || '').toLowerCase();
  const hour = new Date().getHours();

  // 1. 优先从外置结构化热更语料库中精准命中
  if (hotData) {
    // 0. 主动打招呼 / 问候事件：严格使用洗牌袋抽取 40 条去 AI 感语料（周期内零重复）
    if (eventType === 'greeting' || !t) {
      const proactive = hotData.proactive_greetings;
      if (proactive?.length) {
        return getNextShuffleItem(roleKey, proactive);
      }
    }
    // A. 防 AI 试探反击（绝不出戏自爆）
    if (/机器人|大模型|ai|人工智能|脚本|外挂|假人|chatgpt/.test(t)) {
      const antiLines = hotData.social?.anti_bot;
      if (antiLines?.length) return antiLines[Math.floor(Math.random() * antiLines.length)];
    }

    // B. 时间与作息摸鱼借口（专治“为什么上课还在线/秒回”）
    if (/上课|为什么在线|怎么在线|还在玩|没睡|怎么还没睡|在干嘛|在干啥|查寝/.test(t)) {
      // 注：分支已覆盖所有小时区间（`else` 兜底），故不需要 `= null` 初始化
      // （多写一个初值会被 eslint 的 no-useless-assignment 判为死赋值）。
      let routineLines;
      if (hour >= 8 && hour < 12) routineLines = hotData.routine?.in_class;
      else if (hour >= 12 && hour < 14) routineLines = hotData.routine?.lunch;
      else if (hour >= 14 && hour < 17) routineLines = hotData.routine?.afternoon;
      else if (hour >= 22 && hour < 24) routineLines = hotData.routine?.curfew;
      else if (hour >= 0 && hour < 7) routineLines = hotData.routine?.late_night;
      else routineLines = hotData.routine?.in_class;

      if (routineLines?.length) return routineLines[Math.floor(Math.random() * routineLines.length)];
    }

    // C. 深渊派对事件 (祈愿/闪光/光头/APC)
    if (eventType === 'abyss' || /深渊|史诗|闪光|光头|柱子|无影剑|爆粉/.test(t)) {
      let pool = hotData.abyss?.pray;
      if (/闪|金|出货|出ss|出史诗/.test(t)) pool = hotData.abyss?.spark_epic;
      else if (/光头|蓝天白云|没出|空手/.test(t)) pool = hotData.abyss?.bald_head;
      else if (/apc|骷髅|长枪/.test(t)) pool = hotData.abyss?.kill_apc;
      if (pool?.length) return pool[Math.floor(Math.random() * pool.length)];
    }

    // D. 强化与增幅打造
    if (eventType === 'equip_broken' || /碎|强化|凯丽|失败|炸了/.test(t)) {
      const pool = hotData.upgrade?.broken;
      if (pool?.length) return pool[Math.floor(Math.random() * pool.length)];
    } else if (/成功|上10|上11|上12|上13|红光/.test(t)) {
      const pool = hotData.upgrade?.success;
      if (pool?.length) return pool[Math.floor(Math.random() * pool.length)];
    } else if (/增幅|克伦特|红字/.test(t)) {
      const pool = hotData.upgrade?.clonte_amplify;
      if (pool?.length) return pool[Math.floor(Math.random() * pool.length)];
    }

    // E. 副本战斗、缺蓝与躺尸求救
    if (/没蓝|空蓝|缺蓝|泉水|药/.test(t)) {
      const pool = hotData.dungeon?.out_of_mana;
      if (pool?.length) return pool[Math.floor(Math.random() * pool.length)];
    } else if (/死了|躺尸|挂了|黑白电视/.test(t)) {
      const pool = hotData.dungeon?.player_dead;
      if (pool?.length) return pool[Math.floor(Math.random() * pool.length)];
    } else if (/救我|拉我|复活币/.test(t)) {
      const pool = hotData.dungeon?.companion_dead;
      if (pool?.length) return pool[Math.floor(Math.random() * pool.length)];
    } else if (eventType === 'carry' || /带我|组队|刷图|进图|悬空|牛|悲鸣|副本/.test(t)) {
      const pool = hotData.dungeon?.entry;
      if (pool?.length) return pool[Math.floor(Math.random() * pool.length)];
    }

    // F. 材料互助
    if (/黑曜石/.test(t)) {
      const pool = hotData.materials?.need_obsidian;
      if (pool?.length) return pool[Math.floor(Math.random() * pool.length)];
    } else if (/灵魂/.test(t)) {
      const pool = hotData.materials?.need_soul;
      if (pool?.length) return pool[Math.floor(Math.random() * pool.length)];
    } else if (/灾难/.test(t)) {
      const pool = hotData.materials?.need_calamity;
      if (pool?.length) return pool[Math.floor(Math.random() * pool.length)];
    } else if (/无色|大招/.test(t)) {
      const pool = hotData.materials?.cube_reimburse;
      if (pool?.length) return pool[Math.floor(Math.random() * pool.length)];
    }

    // G. 社交与情感
    if (/吃醋|女枪|妹子|别的女|别人|野女人/.test(t)) {
      const pool = hotData.social?.jealous;
      if (pool?.length) return pool[Math.floor(Math.random() * pool.length)];
    } else if (/在吗|在么|上线|人呢|嗨|哈喽/.test(t)) {
      const pool = hotData.social?.greeting;
      if (pool?.length) return pool[Math.floor(Math.random() * pool.length)];
    } else if (/站街|发呆|看海/.test(t)) {
      const pool = hotData.social?.standby;
      if (pool?.length) return pool[Math.floor(Math.random() * pool.length)];
    }

    // 默认兜底：从日常闲聊池或问候池抽取
    const allSocial = [...(hotData.social?.greeting || []), ...(hotData.social?.standby || []), ...(hotData.social?.sweet_talk || [])];
    if (allSocial.length) return allSocial[Math.floor(Math.random() * allSocial.length)];
  }

  // 2. 安全回退：如果外置文件未加载，使用硬编码常量（绝对不崩溃）
  const fallbackPool = roleKey === 'tuanzi' ? GAMER_GIRL_CHAT_FALLBACK.tuanzi : GAMER_GIRL_CHAT_FALLBACK.peach;
  let category = 'default';
  if (eventType === 'equip_broken' || /碎|强化|凯丽|失败/.test(t)) {
    category = 'equip_broken';
  } else if (eventType === 'carry' || /带我|组队|刷图|悬空|冰心|牛|悲鸣|副本/.test(t)) {
    category = 'carry';
  } else if (/在吗|在么|上线|人呢|嗨|哈喽/.test(t)) {
    category = 'greeting';
  } else if (/吃醋|女枪|妹子|别的女|别人/.test(t)) {
    category = 'jealous';
  }
  const lines = fallbackPool[category] || fallbackPool.default;
  return lines[Math.floor(Math.random() * lines.length)];
}

// ── 3. 塞拉邮局合规礼物清单与情境状态机（100% 60版本 Script.pvf 白盒核验真实道具ID） ───────────
/**
 * 邮件情境取值域（与 `data/dnf_corpus/mail_templates.json` 的 `scenario` 字段一一对应）。
 *
 * 前 3 个是 v1 既有情境；后 3 个是语料 v3 新增（定调 §18 T-7 移交）。
 * **新增情境时必须同时改三处**：① 本表；② `SCENARIO_ALIASES`（把外部叫法收敛到本表）；
 * ③ `resolveMailScenario` 末尾的 `KNOWN_MAIL_SCENARIOS` 派生集合会自动跟上；
 * ④ `selectMailGift` 的 switch 补一个 case（否则走 `MAIL_SCENARIO_UNKNOWN` → fail-loud）。
 *
 * 另有一个**哨兵值** `MAIL_SCENARIO_UNKNOWN`：不属正常取值域，专门标识
 * "调用方明确给了 scenario、但不认识"——它必须 fail-loud（见 resolveMailScenario）。
 */
export const MAIL_SCENARIOS = {
  EQUIP_BROKEN: 'equip_broken',
  OFFLINE_CARE: 'offline_care',
  ABYSS_BLANK: 'abyss_blank',
  // ── 语料 v3 新增（mail_templates 的 scenario 字段名，必须逐字一致）──
  REUNION: 'reunion',
  ANNIVERSARY: 'anniversary',
  AFTER_QUARREL: 'after_quarrel',
};

/**
 * 未知情境哨兵。**不要在取值域里使用它**；它只由 `resolveMailScenario` 在
 * "明确给了无法识别的 scenario" 时产出，用于把静默兜底变成可观测降级。
 */
export const MAIL_SCENARIO_UNKNOWN = '__unknown_scenario__';

/**
 * 外部叫法 → 规范情境。键为小写。
 * 注意：这里只放"确实指向某情境"的同义词；**不要往里塞兜底**——
 * 兜底是 `resolveMailScenario` 末尾的显式分支，且现在会留痕。
 */
const SCENARIO_ALIASES = {
  // 碎刀 / 强化失败
  equip_broken: 'equip_broken', broken: 'equip_broken', upgrade_broken: 'equip_broken',
  reinforce_fail: 'equip_broken', upgrade_fail: 'equip_broken', pad_weapon: 'equip_broken',
  catalyst: 'equip_broken',
  // 日常离线关怀
  offline_care: 'offline_care', offline: 'offline_care', goodnight: 'offline_care',
  care: 'offline_care', daily: 'offline_care', greeting: 'offline_care',
  dungeon_assist: 'offline_care', cube_reimburse: 'offline_care',
  // 深渊光头
  abyss_blank: 'abyss_blank', abyss: 'abyss_blank', bald_head: 'abyss_blank',
  epic_fail: 'abyss_blank', invitation: 'abyss_blank',
  // ── v3 新增三情境（含中文/常见别名）──
  reunion: 'reunion', return: 'reunion', come_back: 'reunion', long_absence: 'reunion',
  重逢: 'reunion', 回归: 'reunion', 久别: 'reunion', 好久不见: 'reunion',
  anniversary: 'anniversary', anniversary_day: 'anniversary', memorial: 'anniversary',
  周年: 'anniversary', 纪念日: 'anniversary', 相识纪念: 'anniversary',
  after_quarrel: 'after_quarrel', quarrel: 'after_quarrel', make_up: 'after_quarrel',
  reconcile: 'after_quarrel', reconciliation: 'after_quarrel',
  吵架: 'after_quarrel', 冷战: 'after_quarrel', 和好: 'after_quarrel', 道歉: 'after_quarrel',
};

/** 规范情境集合（供 fail-loud 判定；从 MAIL_SCENARIOS 派生，新增情境自动跟上）。 */
const KNOWN_MAIL_SCENARIOS = new Set(Object.values(MAIL_SCENARIOS));

// ── 3.1 情境解析的可观测计数（fail-loud 的"计数"半边） ────────────────────────
const _mailScenarioStats = { resolved: 0, unknown: 0, hintFallback: 0, clamped: 0, lastWarning: null };
const _unknownScenarioSeen = new Map();   // 收到的原值 -> 次数

/** 只读观测口：情境解析计数（供门禁/运维断言）。 */
export function getMailScenarioStats() {
  return { ..._mailScenarioStats, unknownValues: Object.fromEntries(_unknownScenarioSeen) };
}

// 邮件**正文**取值来源计数（t41 U4/U5 的可观测半边）
const _mailTextStats = { degraded: 0, lastWarning: null };
/** 只读观测口：邮件正文是否发生过"角色/情境降级取用"。 */
export function getMailTextStats() { return { ..._mailTextStats }; }
/** 测试用：清零邮件正文计数。 */
export function resetMailTextStats() { _mailTextStats.degraded = 0; _mailTextStats.lastWarning = null; }

/** 测试用：清零计数（含最近一条告警原文）。 */
export function resetMailScenarioStats() {
  _mailScenarioStats.resolved = 0;
  _mailScenarioStats.unknown = 0;
  _mailScenarioStats.hintFallback = 0;
  _mailScenarioStats.clamped = 0;
  _mailScenarioStats.lastWarning = null;
  _unknownScenarioSeen.clear();
}

// ── 3.3 称呼变量注入与 fail-loud 守卫（定调 §18 T-10） ────────────────────────
/**
 * 称呼占位符的**冻结写法**（单花括号）：`{player_nickname}` 玩家昵称、`{player_alias}` 她的外号。
 *
 * 为什么必须有这一层：语料 v3 里已出现这两个变量，而运行期**原本没有任何替换逻辑**——
 * 本地语料出话会把 `{player_nickname}` **原样发给玩家**（比年代穿帮严重得多）。
 * 本层保证"即使语料里还有占位符也不会漏给玩家"，并把无法解析的情况变成**可见告警**。
 *
 * 兼容与幂等（T-10 的 ④）：历史上出现过双花括号 `{{player_nickname}}`（归一前旧稿），
 * 这里**同时认两种写法**并归一为单花括号输出；转换是"模式级"的（不是把 `{{`→`{` 全局替换），
 * 因此**重复执行结果稳定**，不会出现二次变形。
 */
export const CALL_NAME_CHANNELS = {
  CHAT: 'chat',
  MAIL_TITLE: 'mail_title',
  MAIL_BODY: 'mail_body',
  WHITE: 'white',    // 近身白字——当前由 Go 侧装配，大脑无出口；此处预留，避免下游重新发明
  YELLOW: 'yellow',  // 全服黄字——同上
};
const KNOWN_CALL_CHANNELS = new Set(Object.values(CALL_NAME_CHANNELS));

// 兜底用"你"：与 `companions.call_user_as` 的 DB 默认值一致（db.mjs:1065），
// 也是定调 §18 T-10 明确点名的降级目标。
const CALL_NICKNAME_FALLBACK = '你';

// ── 可观测计数（fail-loud 的"计数"半边）──
const _callNameStats = {
  injected: 0,        // 发生过替换的文本数
  tokenCount: 0,      // 累计替换的 token 数
  legacyBraces: 0,    // 遇到双花括号旧稿的次数
  residual: 0,        // 兜底修复的残留占位符数（>0 即说明语料有写错的变量名）
  unknownChannel: 0,
  lastWarning: null,
};

/** 只读观测口：称呼注入计数（供门禁/运维断言）。 */
export function getCallNameStats() { return { ..._callNameStats }; }
/** 测试用：清零称呼注入计数。 */
export function resetCallNameStats() {
  for (const k of Object.keys(_callNameStats)) {
    _callNameStats[k] = (k === 'lastWarning') ? null : 0;
  }
}

/**
 * 解析"她该怎么叫玩家"。
 * 优先级**逐字对齐基座 §5.1（line 688-692）冻结链**：
 *   `companion_shaping.nickname` → `companions.player_nickname` → **人设 T1 默认叫法** → 「你」
 * 其中 **"人设 T1 默认叫法"的落地字段就是 `companions.call_user_as`**——基座 §5.1 的
 * 伪代码在"人设 T1 默认叫法"下方明确标注 `（call_user_as）`，且 §5.1 的消费点写着
 * `call_user_as` → `companion.mjs:402`。故本函数的第 3 档读它，不是另立一个字段。
 *
 * `{player_alias}`（她给的外号）走 `companions.exonym`（**列尚未迁移**，存在性检测），
 * 缺失即回落昵称→「你」。**注意**：不回落到 `call_user_as` 的"你"以外值，
 * 以免把"昵称"当"外号"用（两者语义不同，见 T-10 对两个变量的定义）。
 *
 * 尚未迁移的列（`player_nickname` / `exonym`）靠"存在性检测"处理：列不存在 → undefined
 * → 自动跳过该档，**不抛、不报错**，等迁移落地后无需再改本函数。
 */
export function resolveCallNames(companion) {
  const c = companion || {};
  let shapingNickname = '';
  try {
    const row = getDb().prepare(
      `SELECT content FROM companion_shaping WHERE companion_id = ? AND kind = 'nickname' ` +
      `ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(c.id);
    shapingNickname = String(row?.content || '').trim();
  } catch { /* 表缺失 / id 为空 / DB 未就绪 → 静默跳过这一档（后面还有 3 档兜底） */ }

  const mirrorNickname = String(c.player_nickname ?? '').trim();   // 列可能不存在 → undefined
  const callUserAs = String(c.call_user_as ?? '').trim();
  const aliasColumn = String(c.exonym ?? '').trim();               // 列可能不存在

  const nickname = shapingNickname || mirrorNickname
    || (callUserAs && callUserAs !== '你' ? callUserAs : '')
    || CALL_NICKNAME_FALLBACK;
  const alias = aliasColumn || nickname;

  return {
    nickname,
    alias,
    source: shapingNickname ? 'shaping'
      : mirrorNickname ? 'player_nickname'
        : (callUserAs && callUserAs !== '你') ? 'call_user_as' : 'fallback',
  };
}

function _looksLikeUnresolvedBrace(text) {
  return /\{\{?[^}]{0,40}\}?\}/.test(String(text ?? ''));
}

/** 兜底替换用的"像占位符"模式：`{任意短Token}`。用于把写错的变量名也修掉。 */
const CALL_RESIDUAL_RE = /\{\{?[^}]{0,40}\}?\}/g;

/**
 * 出话前的**唯一**称呼注入点。所有发给玩家的文本都必须过这里。
 *
 * 行为：
 *   ① 归一：把旧的 `{{player_nickname}}` 双花括号写法按**模式**转成单花括号（幂等，不二次变形）；
 *   ② 替换：`{player_nickname}` → 昵称、`{player_alias}` → 外号；
 *   ③ fail-loud：装配后若仍残留未解析占位符 → WARN（含 NPC/通道/原文片段）+ 计数，
 *      并**就地兜底修掉**（降级为「你」），**绝不把占位符原样发给玩家**。
 *
 * @param {string} text
 * @param {object} companion companion 行（可为 null → 全部走兜底）
 * @param {{channel?: string}} [opts]
 * @returns {{text: string, injected: number, legacyBraces: number, residual: number, changed: boolean}}
 */
export function injectCallNames(text, companion, { channel = CALL_NAME_CHANNELS.CHAT } = {}) {
  const original = String(text ?? '');
  if (!original) return { text: original, injected: 0, legacyBraces: 0, residual: 0, changed: false };

  const ch = KNOWN_CALL_CHANNELS.has(channel) ? channel : CALL_NAME_CHANNELS.CHAT;
  if (ch !== channel) _callNameStats.unknownChannel += 1;   // 未知通道不阻断，按 chat 记账

  const { nickname, alias } = resolveCallNames(companion);
  const npc = String(companion?.name || '?');

  let out = original;
  let injected = 0;
  let legacyBraces = 0;

  // ① 归一 + 替换（一次正则同时认单/双花括号；`{{x}}` 的 `{` 会被 `\{\{?` 吃掉，剩 `}` 由收尾清）
  out = out.replace(/\{\{?\s*(player_nickname|player_alias)\s*\}?\}/gi, (m, varName) => {
    injected += 1;
    if (m.includes('{{')) legacyBraces += 1;
    const key = String(varName).toLowerCase();
    return key === 'player_nickname' ? nickname : alias;
  });
  if (legacyBraces > 0) {
    _callNameStats.legacyBraces += legacyBraces;
    const w = `[Game] 称呼变量旧稿（双花括号）已归一为单花括号：npc=${npc} channel=${ch} 命中 ${legacyBraces} 处`;
    _callNameStats.lastWarning = w;
    log('warn', w);
  }

  // ② fail-loud：残留未解析占位符（变量名写错 / 大小写变体 / 半个括号）→ 告警并兜底。
  //    判据刻意放宽为"任何 `{短Token}`"：`{player_nicknames}` 这类**写错的变量名**
  //    同样会把花括号原文漏给玩家（探针实测过），只认 nickname|alias 会漏掉它们。
  let residual = 0;
  if (_looksLikeUnresolvedBrace(out)) {
    const before = out;
    const hits = before.match(CALL_RESIDUAL_RE) || [];
    out = out.replace(CALL_RESIDUAL_RE, CALL_NICKNAME_FALLBACK);
    residual = hits.length;
    _callNameStats.residual += residual;
    const snippet = String(before).slice(0, 60).replace(/\s+/g, ' ');
    const w = `[Game] 称呼变量未能解析已就地兜底（禁止占位符漏给玩家）：npc=${npc} channel=${ch} ` +
      `兜底=${CALL_NICKNAME_FALLBACK} 残留=${residual} 命中=${JSON.stringify(hits.slice(0, 3))} 原文片段="${snippet}"`;
    _callNameStats.lastWarning = w;
    log('warn', w);
  } else if (out.includes('{{')) {
    // 落单的 `{{`（不构成任何占位符，但 T-10 明确要求扫它）：同样必须可见并归一，
    // 防止"半个括号"这种残骸被玩家看到。只把 `{{` 收成 `{`，不动其它内容。
    _callNameStats.residual += 1;
    residual += 1;
    out = out.replace(/\{\{/g, '{');
    const w = `[Game] 文本含落单双花括号已归一为单花括号：npc=${npc} channel=${ch} ` +
      `原文片段="${String(original).slice(0, 60)}"`;
    _callNameStats.lastWarning = w;
    log('warn', w);
  }

  if (injected > 0) {
    _callNameStats.injected += 1;
    _callNameStats.tokenCount += injected;
  }
  return { text: out, injected, legacyBraces, residual, changed: out !== original };
}

/**
 * 校验任意出站文本**不含**称呼占位符（供门禁做"最后一道门"断言）。
 * @returns {{ok: boolean, hits: string[]}}
 */
export function assertNoCallPlaceholders(text) {
  const hits = String(text ?? '').match(/\{\{?\s*player_(nickname|alias)\s*\}?\}/gi) || [];
  return { ok: hits.length === 0, hits };
}

/**
 * 私聊文本装配的**单一入口**：先注入称呼，再切句成 burst。
 * 三条私聊出口（问候短路 / 在线成功 / 在线失败后本地兜底）全部走它，避免漏点。
 */
function buildChatBurst(rawText, companion, channel = CALL_NAME_CHANNELS.CHAT) {
  return chunkToBursts(injectCallNames(rawText, companion, { channel }).text);
}

// ── 3.4 邮件通道三约束的唯一执行点（t29） ─────────────────────────────────────
// 定调 §10.5 / 硬红线 B 类：标题 ≤30B、正文 ≤360B、Subject+'\n'+Body < 512B
// （越界 → 客户端开信箱报错误 17）。旧实现里 `title.slice(0,16)` 最多可到 32B、
// 正文完全无校验、且**没有任何度量**——属"静默超界"。这里补上确定性执行 + 可见截断。
const MAIL_TITLE_MAX_BYTES = 30;
const MAIL_BODY_MAX_BYTES = 360;
const MAIL_TOTAL_MAX_BYTES = 512;

/** GBK 字节长度：ASCII 1B，其余 2B（与 Go 侧 `SanitizeLoverReply` 同口径）。 */
export function gbkByteLength(text) {
  let n = 0;
  for (const ch of String(text ?? '')) n += ch.codePointAt(0) <= 0x7f ? 1 : 2;
  return n;
}

/** 按 GBK 字节预算截断（不切碎多字节字符）。 */
export function truncateToGbkBytes(text, maxBytes) {
  let out = '';
  let n = 0;
  for (const ch of String(text ?? '')) {
    const w = ch.codePointAt(0) <= 0x7f ? 1 : 2;
    if (n + w > maxBytes) break;
    out += ch;
    n += w;
  }
  return out;
}

/**
 * 把一封邮件收进通道预算内，并**留下可观测痕迹**（WARN + 计数 + 返回值里的实测字节）。
 * 返回 `{ title, body, title_bytes, body_bytes, total_bytes, clamped }`。
 */
export function enforceMailChannelLimits({ title, body } = {}) {
  const t0 = String(title ?? '');
  const b0 = String(body ?? '');
  const titleOut = truncateToGbkBytes(t0, MAIL_TITLE_MAX_BYTES);
  let bodyOut = truncateToGbkBytes(b0, MAIL_BODY_MAX_BYTES);
  const titleBytes = gbkByteLength(titleOut);
  if (titleBytes + 1 + gbkByteLength(bodyOut) >= MAIL_TOTAL_MAX_BYTES) {
    bodyOut = truncateToGbkBytes(bodyOut, Math.max(0, MAIL_TOTAL_MAX_BYTES - 2 - titleBytes));
  }
  const bodyBytes = gbkByteLength(bodyOut);
  const clamped = titleOut !== t0 || bodyOut !== b0;
  if (clamped) {
    _mailScenarioStats.clamped += 1;
    const msg = `[Game] 邮件超通道预算已可见截断：title ${gbkByteLength(t0)}B→${titleBytes}B / ` +
      `body ${gbkByteLength(b0)}B→${bodyBytes}B（上限 30/360，合计硬边界 <512B）`;
    _mailScenarioStats.lastWarning = msg;
    log('warn', msg);
  }
  return {
    title: titleOut,
    body: bodyOut,
    title_bytes: titleBytes,
    body_bytes: bodyBytes,
    total_bytes: titleBytes + 1 + bodyBytes,
    clamped
  };
}

/** 只读窥探：语料里实际注册了哪些 scenario（供"代码表 vs 语料"一致性门禁）。 */
export function getRegisteredScenarioIds() {
  return { known: [...KNOWN_MAIL_SCENARIOS].sort(), aliases: Object.keys(SCENARIO_ALIASES).sort() };
}

/**
 * 未知情境留痕：WARN（含收到的原值）+ 计数。
 * 这是 T-7 要求的 fail-loud 实现——**绝不静默落默认**。
 */
function reportUnknownScenario(received) {
  const raw = String(received ?? '');
  _mailScenarioStats.unknown += 1;
  _unknownScenarioSeen.set(raw, (_unknownScenarioSeen.get(raw) || 0) + 1);
  const msg = `[Game] 邮件情境未注册 scenario="${raw}" → 已降级为 offline_care 兜底（可见降级，非静默）。` +
    `请在 MAIL_SCENARIOS + SCENARIO_ALIASES + selectMailGift 三处注册（定调 §18 T-7）`;
  _mailScenarioStats.lastWarning = msg;
  log('warn', msg);
}


export const DNF_LEGIT_MAIL_GIFTS = [
  {
    item_id: 27600, // PVF: equipment/character/swordman/weapon/katana/kat_damaged.equ
    name: '+11 生锈的武士刀',
    count: 1,
    upgrade_level: 11,
    category: 'pad_weapon',
    scenario: 'equip_broken',
    reason: '给他寄把垫刀用的高强白装武器',
    dialogue: {
      title: '给你垫刀的神器！',
      peach: '笨蛋！听说你要强主武器？这把+11武士刀是我废了好大劲才垫出来的，拿去当垫子垫碎了再上主武器，千万别炸啦！',
      tuanzi: '喂，听说你今天又要去搏命？这把+11垫子拿去垫刀！要是你的主武器再碎，以后就拿木棒带我刷图吧！'
    }
  },
  {
    item_id: 27600, // PVF: equipment/character/swordman/weapon/katana/kat_damaged.equ
    name: '+12 生锈的武士刀',
    count: 1,
    upgrade_level: 12,
    category: 'pad_weapon',
    scenario: 'equip_broken',
    reason: '极品高阶垫刀神器',
    dialogue: {
      title: '终极垫刀神器！',
      peach: '哇哇！我昨晚居然垫出一把+12武士刀！赶紧寄给你，拿去垫你的万仞，一发上13冲冲冲！',
      tuanzi: '哼，本姑娘手气爆棚垫出了+12武士刀！便宜你这个笨蛋了，拿去当极品垫子，碎了别找我哭！'
    }
  },
  {
    item_id: 3171, // PVF: stackable/material/ryan_cokes.stk
    name: '炉岩碳',
    count: 50,
    upgrade_level: 0,
    category: 'catalyst',
    scenario: 'equip_broken',
    reason: '给他寄点强化用的炉岩碳',
    dialogue: {
      title: '给你赞助点碳！',
      peach: '听说你又要去找凯丽啦？诺，包里攒的50个炉岩碳全寄给你啦，祝你一把上10！待会记得带我刷图噢嘻嘻~',
      tuanzi: '整天就见你缺碳强化，喏，这50个拿去用吧！要是全便宜了凯丽那个老女人，看我不咬你！'
    }
  },
  {
    item_id: 3174, // PVF: stackable/material/stone_clear.stk
    name: '无色小晶块',
    count: 200,
    upgrade_level: 0,
    category: 'cube',
    scenario: 'offline_care',
    reason: '组队45大招报销',
    dialogue: {
      title: '大招随便放！',
      peach: '今天带我刷图表现太棒啦！这200个无色小晶块给你报销，待会大招随便放，无色我管够！',
      tuanzi: '看你刷图放个45技能扣扣搜搜的……诺，200个无色拿去，别在副本里给我丢人！'
    }
  },
  {
    item_id: 1048, // PVF: stackable/ptn_scwater.stk (天空之城泉水)
    name: '天空之城泉水',
    count: 30,
    upgrade_level: 0,
    category: 'recovery',
    scenario: 'offline_care',
    reason: '回血回蓝补给品',
    dialogue: {
      title: '宿舍要熄灯啦~',
      peach: '宿管阿姨马上要拉闸断电了，我得关电脑啦。今天给你留了30个天空泉水，别老舍不得喝药，明天记得找我！',
      tuanzi: '要熄灯断网了！这30个泉水寄给你，刷图残血记得喝，别老让我看到你躺尸！'
    }
  },
  {
    item_id: 1070, // PVF: stackable/bible_blue.stk (蓝色圣经)
    name: '蓝色圣经',
    count: 5,
    upgrade_level: 0,
    category: 'special',
    scenario: 'offline_care',
    reason: '打领主加回避保命神器',
    dialogue: {
      title: '保命圣经快拿着！',
      peach: '听说你要去打无头骑士？做任务特意给你留了5本蓝色圣经，+20%回避率呢，保命别老被秒！',
      tuanzi: '听说某个笨蛋老被boss秒？这5本蓝色圣经吃了加回避，别再笨手笨脚被撞飞了！'
    }
  },
  {
    item_id: 3214, // PVF: stackable/material/invitation_bluedevil.stk (蓝色恶魔邀请函)
    name: '深渊派对邀请函 (深渊票)',
    count: 20,
    upgrade_level: 0,
    category: 'abyss_ticket',
    scenario: 'abyss_blank',
    reason: '深渊门票材料赞助',
    dialogue: {
      title: '深渊票赞助！',
      peach: '我把存的20张深渊票全寄给你啦，今天一定要带我爆出金色闪光史诗呀OvO！',
      tuanzi: '诺，这20张深渊票拿去打！要是敢光头空手出来，看本姑娘怎么收拾你！'
    }
  }
];

export function getMailGiftList() {
  const hot = loadMailTemplatesHot();
  if (Array.isArray(hot) && hot.length > 0) {
    return hot.map(item => ({
      item_id: item.item_id,
      name: item.name,
      count: item.count,
      upgrade_level: item.upgrade_level || 0,
      category: item.category,
      scenario: item.scenario || (item.category === 'pad_weapon' || item.category === 'catalyst' ? 'equip_broken' : item.category === 'abyss_ticket' ? 'abyss_blank' : 'offline_care'),
      reason: item.reason || item.description || '',
      dialogue: item.dialogue
    }));
  }
  return DNF_LEGIT_MAIL_GIFTS;
}

/**
 * 解析触发情境（情境状态机），废除盲抽，杜绝无情境乱发高强装备。
 *
 * **T-7 改动要点（定调 §18）**：语料 v3 新增 `reunion / anniversary / after_quarrel`
 * 三情境已注册。**同时把"未知情境"从静默落默认改为 fail-loud**：
 *   · 调用方**明确给了** `scenario`/`eventType` 而无法识别 → WARN（含收到的原值）+ 计数，
 *     并返回哨兵 `MAIL_SCENARIO_UNKNOWN`（由 `selectMailGift` 走安全兜底 +
 *     `/game/mail` 响应带 `scenario_degraded:true`，**降级可见**）；
 *   · 调用方**压根没给**情境（无 scenario/eventType，也没命中 hint/targetItemId）→
 *     仍回落 `offline_care`，但计入 `hintFallback`（这是产品意义上的正常默认，不是异常）。
 * 两者的区别：前者是"说了一个我不认识的情境"（缺陷），后者是"没说"（正常）。
 *
 * @returns {string} MAIL_SCENARIOS.* 之一，或 MAIL_SCENARIO_UNKNOWN（唯一降级态）
 */
export function resolveMailScenario({ scenario, eventType, hint, targetItemId } = {}) {
  const explicit = String(scenario || eventType || '').trim().toLowerCase();
  if (explicit) {
    const mapped = SCENARIO_ALIASES[explicit];
    if (mapped) {
      _mailScenarioStats.resolved += 1;
      return mapped;
    }
    // 明确给了值但不认识 → fail-loud（这就是 T-7 要消灭的静默分支）
    reportUnknownScenario(explicit);
    return MAIL_SCENARIO_UNKNOWN;
  }

  const h = String(hint || '').toLowerCase();
  if (/碎|强化|垫刀|垫子|凯丽|炸了|失败|炉岩|碳|武士刀/.test(h)) {
    _mailScenarioStats.resolved += 1;
    return MAIL_SCENARIOS.EQUIP_BROKEN;
  }
  if (/深渊|光头|邀请函|门票|史诗|闪光|空手|恶魔邀请函/.test(h)) {
    _mailScenarioStats.resolved += 1;
    return MAIL_SCENARIOS.ABYSS_BLANK;
  }
  // ── v3 新增三情境的 hint 识别（放在 offline_care 的宽泛词之前，避免被"泉水/圣经"吃掉）──
  if (/重逢|回归|好久不见|久别|你回来了|一个礼拜|两周没|半个月没/.test(h)) {
    _mailScenarioStats.resolved += 1;
    return MAIL_SCENARIOS.REUNION;
  }
  if (/周年|纪念日|相识纪念|在一起.*(天|年)|第.*周年/.test(h)) {
    _mailScenarioStats.resolved += 1;
    return MAIL_SCENARIOS.ANNIVERSARY;
  }
  if (/吵架|冷战|和好|道歉|不理我|生气了|闹别扭|台阶/.test(h)) {
    _mailScenarioStats.resolved += 1;
    return MAIL_SCENARIOS.AFTER_QUARREL;
  }
  if (/晚安|下线|熄灯|睡觉|日常|泉水|回血|补给|圣经|回避|无色|大招|关电脑|拉闸/.test(h)) {
    _mailScenarioStats.resolved += 1;
    return MAIL_SCENARIOS.OFFLINE_CARE;
  }

  // 检查显式请求的 targetItemId 语义
  if (targetItemId === 27600 || targetItemId === 3171 || targetItemId === 11 || targetItemId === 12) {
    _mailScenarioStats.resolved += 1;
    return MAIL_SCENARIOS.EQUIP_BROKEN;
  }
  if (targetItemId === 3214) {
    _mailScenarioStats.resolved += 1;
    return MAIL_SCENARIOS.ABYSS_BLANK;
  }
  if (targetItemId === 1048 || targetItemId === 1070 || targetItemId === 3174) {
    _mailScenarioStats.resolved += 1;
    return MAIL_SCENARIOS.OFFLINE_CARE;
  }

  // 兜底安全策略：调用方**没给**任何情境线索 → 归入日常离线关怀（杜绝乱发高强装备）。
  // 注意：这是"没说"，不是"说了个不认识的"，故不 fail-loud，只计 hintFallback 供观察。
  _mailScenarioStats.hintFallback += 1;
  return MAIL_SCENARIOS.OFFLINE_CARE;
}

/**
 * 依据情境状态机选取专属礼物，废除 Math.random 盲抽。
 *
 * v3 三情境的附件策略**只从既有白名单里挑**（不新增道具 ID）：
 *   · `reunion`       → 天空之城泉水 1048（`recovery`）：久别归来的补给，与 v3 语料 5/5 条一致
 *   · `anniversary`   → 无色小晶块 3174（`cube`）优先，退化到 1048：纪念日给"能马上用掉"的
 *   · `after_quarrel` → 蓝色圣经 1070（`special`）优先，退化到 1048：台阶/保命，与语料一致
 * 三者的**兜底方向都朝"安全日常消耗品"**（绝不落 pad_weapon），与既有 offline_care 同向。
 * `targetItemId` 显式指定仍然最优先（调用方说了算）。
 *
 * @returns {object} 礼物条目（含 item_id/name/count/upgrade_level/category/scenario/dialogue）
 */
export function selectMailGift({ scenario, hint = '', targetItemId = 0, targetUpgradeLevel = null } = {}) {
  const allGifts = getMailGiftList();
  const h = String(hint || '').toLowerCase();

  // 显式 ID 命中最优先：调用方点明要什么就给什么（既有的兼容语义，不改）
  const explicitHit = _findExplicitGift(allGifts, targetItemId, targetUpgradeLevel, h);
  if (explicitHit) return explicitHit;

  // ★ U4 修复：**按 scenario 优先过滤**。
  // 原实现只在全量清单上按 category/item 取"数组序首个匹配"，而 v1 的
  // recovery/cube/special 条目排在 v3 新增条目之前 → `reunion` 会命中 v1 的
  // offline_care 泉水（实测：scenario 字段回显 `offline_care`、title "宿舍要熄灯啦~"），
  // v3 的 reunion 文案永远轮不到。
  // 现在优先只在**本情境自己的条目**里挑；本情境没有条目时才回落到全量
  //（保证未知情境/哨兵仍有安全兜底，不改变 v1 三情境的行为）。
  const scoped = allGifts.filter(g => g.scenario === scenario);
  const pool = scoped.length > 0 ? scoped : allGifts;

  const pick = (...preds) => {
    for (const p of preds) {
      const hit = pool.find(p);
      if (hit) return hit;
    }
    return null;
  };
  const byCategory = (cat) => (g) => g.category === cat;
  const byItem = (id) => (g) => g.item_id === id;

  // 状态机场景路由（严禁 Math.random 盲抽）
  switch (scenario) {
    case MAIL_SCENARIOS.EQUIP_BROKEN: {
      // 碎刀送垫刀/碳
      if (/碳|炉岩/.test(h)) {
        return pick(byCategory('catalyst'), byItem(3171), byCategory('pad_weapon'));
      }
      if (/12|十二|万仞|极品/.test(h)) {
        return pick((g) => g.category === 'pad_weapon' && g.upgrade_level === 12, byCategory('pad_weapon'));
      }
      // 默认碎刀送 +11 垫刀
      return pick(
        (g) => g.category === 'pad_weapon' && g.upgrade_level === 11,
        byCategory('pad_weapon'),
        byItem(3171),
      );
    }

    case MAIL_SCENARIOS.ABYSS_BLANK: {
      // 深渊光头/空手送深渊票；无票时退化到安全日常（绝不落武器）
      return pick(byCategory('abyss_ticket'), byItem(3214), byCategory('recovery'));
    }

    // ── v3 新增三情境：各自的附件策略（全部落在既有白名单内）──
    case MAIL_SCENARIOS.REUNION: {
      // 久别归来：给补给（泉水），照 hint 可换圣经/晶块
      if (/圣经|回避|保命/.test(h)) return pick(byCategory('special'), byItem(1070), byCategory('recovery'));
      if (/无色|晶块|大招/.test(h)) return pick(byCategory('cube'), byItem(3174), byCategory('recovery'));
      return pick(byCategory('recovery'), byItem(1048), byCategory('cube'));
    }

    case MAIL_SCENARIOS.ANNIVERSARY: {
      // 纪念日：给"能马上用掉"的晶块；hint 可换圣经/泉水
      if (/圣经|保命|回避/.test(h)) return pick(byCategory('special'), byItem(1070), byCategory('cube'));
      if (/泉水|回血|补给/.test(h)) return pick(byCategory('recovery'), byItem(1048), byCategory('cube'));
      return pick(byCategory('cube'), byItem(3174), byCategory('recovery'));
    }

    case MAIL_SCENARIOS.AFTER_QUARREL: {
      // 摩擦后和解：给台阶（圣经=保命/回避，语义贴"护着你"）；hint 可换泉水
      if (/泉水|回血|补给/.test(h)) return pick(byCategory('recovery'), byItem(1048), byCategory('special'));
      return pick(byCategory('special'), byItem(1070), byCategory('recovery'), byCategory('cube'));
    }

    case MAIL_SCENARIO_UNKNOWN: {
      // fail-loud 的消费侧：resolveMailScenario 已经打过 WARN 并计数，
      // 这里只做"安全兜底"，绝不放高强武器。降级可见性由 /game/mail 的
      // scenario_degraded 标记承载（见 handler）。
      return pick(byCategory('recovery'), byCategory('cube'), byCategory('special'), byCategory('abyss_ticket'))
        || safeNonWeapon(pool) || safeNonWeapon(allGifts);
    }

    case MAIL_SCENARIOS.OFFLINE_CARE:
    default: {
      // 晚安送水/日常补给，杜绝高强武器；default 分支同样守住"不落武器"
      if (/圣经|回避|保命|无头/.test(h)) {
        return pick(byCategory('special'), byItem(1070), byCategory('recovery')) || safeNonWeapon(pool) || safeNonWeapon(allGifts);
      }
      if (/无色|大招|晶块|报销/.test(h)) {
        return pick(byCategory('cube'), byItem(3174), byCategory('recovery')) || safeNonWeapon(pool) || safeNonWeapon(allGifts);
      }
      // 默认送天空之城泉水
      return pick(byCategory('recovery'), byItem(1048)) || safeNonWeapon(pool) || safeNonWeapon(allGifts);
    }
  }
}

/**
 * 最后一个安全网：**永不返回高强武器**（pad_weapon / upgrade_level>0）。
 * 只在语料被换成一个不含任何消耗品的异常集合时才会用到；即便那时，
 * 也优先给非武器条目，最后才退到 allGifts[0]（避免"无礼物可寄"导致上游 500）。
 */
function safeNonWeapon(allGifts) {
  return allGifts.find((g) => g.category !== 'pad_weapon' && (g.upgrade_level || 0) === 0)
    || allGifts.find((g) => g.category !== 'pad_weapon')
    || allGifts[0];
}

// ── 3.5 邮件正文的**角色化**解析（t41 U4 续 / U5） ───────────────────────────
/**
 * 为什么需要这一层（实测依据，2026-10-12）：
 *   · `mail_templates.json` 是**扁平索引**：v1 条目带正文（peach/tuanzi 槽），而 v3 三新情境
 *     在其中只是**占位条目**——`dialogue.{peach,tuanzi,heika}` **三槽皆空**，title 写的是 reason
 *     （实测 reunion → title "久别重逢的补给"、三槽长度均 0）。
 *   · v3 的**正文**按角色分别落在 `{role}_corpus.json` 的 `mail_templates` 里：
 *     `peach_corpus.json` 42 条（peach 槽 42 非空）、`heika_corpus.json` 46 条（heika 槽 46 非空）、
 *     **`tuanzi_corpus.json` 0 条**（团子的 v3 邮件正文确实缺失）。
 * 因此"按 scenario 优先过滤"（U4）只解决**选哪个道具**；正文还必须按角色回填，
 * 否则 v3 情境会发出**空正文**（比改动前更糟——改动前至少发的是"错情境但非空"的 v1 正文）。
 *
 * 解析优先级（逐级降级；**角色不串味**优先于**情境不串味**）：
 *   ① 索引选中条目的**本角色槽**（v1 三情境走这条，行为与改动前完全一致）
 *   ② 该角色语料里 **scenario 匹配且本角色槽非空**（v3 正式正文：peach/heika 命中）
 *   ③ 索引里**同道具、本角色槽非空**（保住角色腔调，牺牲情境贴合；tuanzi 的 v3 走这条）
 *   ④ 该角色语料里**任意 scenario、本角色槽非空**
 *   ⑤ 索引选中条目的 peach 槽（最后非空兜底）
 * ③④⑤ 均标记 `degraded:true`，由 `/game/mail` 透出为可见降级（§11.6：降级必须留痕）。
 * @returns {{title:string, body:string, source:string, degraded:boolean}}
 */
export function resolveMailDialogue(gift, role, scenario) {
  const slotOf = (e, r) => String((e?.dialogue || {})[r] || '');
  const titleOf = (e) => String((e?.dialogue || {}).title || '');
  const roleTemplates = loadRoleMailTemplates(role);

  const own = slotOf(gift, role);
  if (own) return { title: titleOf(gift), body: own, source: 'index_role_slot', degraded: false };

  const scoped = roleTemplates.filter(e => e.scenario === scenario && slotOf(e, role));
  if (scoped.length > 0) {
    const e = pickMailBodyEntry(role, scenario, scoped);
    return { title: titleOf(e) || titleOf(gift), body: slotOf(e, role), source: 'role_corpus_scoped', degraded: false };
  }

  const sameItem = getMailGiftList().filter(g => g.item_id === gift.item_id && slotOf(g, role));
  if (sameItem.length > 0) {
    const e = sameItem[0];
    return { title: titleOf(gift) || titleOf(e), body: slotOf(e, role), source: 'index_same_item_role_slot', degraded: true };
  }

  const anyScen = roleTemplates.filter(e => slotOf(e, role));
  if (anyScen.length > 0) {
    const e = pickMailBodyEntry(role, `any:${scenario}`, anyScen);
    return { title: titleOf(gift) || titleOf(e), body: slotOf(e, role), source: 'role_corpus_any_scenario', degraded: true };
  }

  const peach = slotOf(gift, 'peach');
  if (peach) return { title: titleOf(gift), body: peach, source: 'index_peach_fallback', degraded: true };

  return { title: titleOf(gift), body: '', source: 'empty', degraded: true };
}

// 邮件正文的**分池**洗牌袋：key = `${role}:${scenario}`。
// 为什么不复用 `shuffleBags[role]`（t41 自测咬出的坑）：那是"每个角色一个袋"，
// 而本函数面对的是**按情境切分的子池**（reunion 5 条 / anniversary 5 条 / …）。
// 共用一个袋会让"anniversary 请求"弹出**上一轮 reunion 子池的剩货**——表现为
// `source=role_corpus_scoped` 但正文不属于该情境（实测踩到过）。
// 分池后每个 (角色, 情境) 独立轮换，既防复读又不跨情境污染。
const _mailBodyBags = new Map();
function pickMailBodyEntry(role, scenarioKey, entries) {
  const key = `${role}:${scenarioKey}`;
  let bag = _mailBodyBags.get(key);
  if (!bag || bag.length === 0) {
    bag = [...entries].sort(() => Math.random() - 0.5);
  }
  const e = bag.pop();
  _mailBodyBags.set(key, bag);
  return e || entries[0];
}

const ROLE_MAIL_KEYS = ['peach', 'tuanzi', 'heika'];
const roleMailCache = new Map();   // role -> { mtime, data }

/**
 * 读取某个角色语料文件里的 `mail_templates`（按 mtime 缓存，天然支持热更）。
 * 缺文件/坏文件一律返回空数组并**不抛**——邮件链路已有自己的本地保底信兜底，
 * 这里不该成为新的故障点（但空数组会让 `resolveMailDialogue` 走到降级级并在响应留痕）。
 */
function loadRoleMailTemplates(role) {
  if (!ROLE_MAIL_KEYS.includes(role)) return [];
  const filePath = path.join(CORPUS_DIR, `${role}_corpus.json`);
  try {
    if (!fs.existsSync(filePath)) return [];
    const stat = fs.statSync(filePath);
    const cached = roleMailCache.get(role);
    if (cached && cached.mtime === stat.mtimeMs) return cached.data;
    const arr = JSON.parse(fs.readFileSync(filePath, 'utf-8'))?.mail_templates;
    const data = Array.isArray(arr) ? arr : [];
    roleMailCache.set(role, { mtime: stat.mtimeMs, data });
    // 与 loadCorpusHot 同规则：语料重载即作废洗牌袋（否则新正文要等旧袋抽完才出现）
    if (Array.isArray(shuffleBags[role])) shuffleBags[role] = [];
    return data;
  } catch (err) {
    log('warn', `[Game] 角色邮件语料加载失败 role=${role}: ${err?.message || err}`);
    return [];
  }
}

/**
 * 显式 `attach_item_id` 命中（含 11/12 → 武士刀 27600 的既有兼容转换）。
 * 抽出来只为让 `selectMailGift` 的主干更短；**语义与 v1 完全一致**，不改行为。
 */
function _findExplicitGift(allGifts, targetItemId, targetUpgradeLevel, h) {
  let normalizedItemId = Number(targetItemId || 0);
  let normalizedUpgradeLevel = targetUpgradeLevel !== null && targetUpgradeLevel !== undefined
    ? Number(targetUpgradeLevel) : null;
  if (normalizedItemId === 11) {
    normalizedItemId = 27600;
    if (normalizedUpgradeLevel === null) normalizedUpgradeLevel = 11;
  } else if (normalizedItemId === 12) {
    normalizedItemId = 27600;
    if (normalizedUpgradeLevel === null) normalizedUpgradeLevel = 12;
  }
  if (!(normalizedItemId > 0)) return null;

  const matched = allGifts.filter(g => g.item_id === normalizedItemId);
  if (matched.length === 0) return null;
  if (normalizedUpgradeLevel !== null) {
    const exact = matched.find(g => (g.upgrade_level || 0) === normalizedUpgradeLevel);
    if (exact) return exact;
  }
  if (/12|十二/.test(h)) {
    const plus12 = matched.find(g => (g.upgrade_level || 0) === 12);
    if (plus12) return plus12;
  }
  return matched[0];
}

// ── 2.2 方案B：拟人化打字机动量与短句切分器（Sentence Burst Chunker） ────────
const EMOJI_MAP = [
  [/[\u{1F600}-\u{1F606}\u{1F60A}\u{1F60D}\u{1F618}\u{1F970}]/gu, '^ ^'],
  [/[\u{1F62D}\u{1F622}\u{1F97A}\u{1F625}]/gu, 'QAQ'],
  [/[\u{1F620}\u{1F621}\u{1F624}\u{1F92C}]/gu, '哼！'],
  // `\u{2764}` 常带变体选择符 `\u{FE0F}`（❤️）。变体选择符是**组合字符**，一旦与其它 emoji
  // 挤进同一个字符类，eslint 会判 no-misleading-character-class。这里全部改成 alternation
  // （不再有含组合字符的字符类），逐字符匹配语义不变：裸❤、❤️、孤立变体选择符都仍然清掉。
  [/(?:\u{2764}\u{FE0F}|\u{2764}|\u{FE0F}|\u{1F496}|\u{1F495}|\u{1F49E}|\u{1F49F}|\u{1F49B}|\u{1F49C}|\u{1F49D})/gu, '[心]'],
  [/[\u{1F44D}]/gu, '[赞]'],
  [/[\u{1F44E}]/gu, '[踩]'],
  [/[\u{1F389}\u{1F388}\u{2728}\u{1F31F}]/gu, 'OvO'],
  [/[\u{1F4A5}\u{1F525}]/gu, '!!']
];

export function sanitizeEmojiToGBK(text) {
  let res = String(text || '');
  for (const [regex, replacement] of EMOJI_MAP) {
    res = res.replace(regex, replacement);
  }
  // 过滤掉所有未映射的多字节非GBK Unicode字符，防止触发服务端一票否决
  res = res.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '');
  return res;
}

export function chunkToBursts(rawText) {
  const sanitized = sanitizeEmojiToGBK(rawText).trim();
  if (!sanitized) return { replies: ['在呢在呢~'], delays_ms: [1000], overflow_mail: null };

  // 按换行、句号、感叹号、问号切分为候选句子
  const parts = sanitized.split(/(?<=[。！？!\?\n~])/).map(s => s.trim()).filter(Boolean);
  const sentences = [];

  for (const part of parts) {
    if (part.length <= 25) {
      sentences.push(part);
    } else {
      // 超过25字按逗号进一步切分
      const subParts = part.split(/(?<=[，,、])/).map(s => s.trim()).filter(Boolean);
      for (const sp of subParts) {
        if (sp.length <= 25) {
          sentences.push(sp);
        } else {
          // 仍然过长则硬切22字
          for (let i = 0; i < sp.length; i += 22) {
            sentences.push(sp.slice(i, i + 22));
          }
        }
      }
    }
  }

  // 短句暴击限制：最多 3 句，超过 3 句的内容收拢成塞拉邮局长信
  let replies = sentences.slice(0, 3);
  if (!replies.length) replies = [sanitized.slice(0, 22)];

  // 计算每句的拟真打字延迟毫秒数 (800ms ~ 3500ms)
  const delays_ms = replies.map(line => {
    const jitter = Math.floor(Math.random() * 250) - 100;
    const delay = 800 + line.length * 130 + jitter;
    return Math.max(800, Math.min(3500, delay));
  });

  let overflow_mail = null;
  if (sentences.length > 3 || sanitized.length > 80) {
    overflow_mail = {
      title: '给你写了封长信~',
      body: sanitized.slice(0, 350)
    };
  }

  return { replies, delays_ms, overflow_mail };
}

// ── POST /game/chat：1:1 私聊（API 优先，1.5s 超时瞬间退本地） ───────────────
gameRouter.post('/game/chat', async (req, res) => {
  const npc = req.body?.npc;
  const text = String(req.body?.text ?? '').trim();
  const eventType = req.body?.event_type || null;

  if (!text && !eventType) return res.status(400).json({ ok: false, error: 'text 或 event_type 不能为空' });
  if (text.length > 2000) return res.status(400).json({ ok: false, error: 'text 过长（>2000）' });

  const c = findCompanion(npc);
  if (!c) return res.status(404).json({ ok: false, error: `恋人 NPC 不存在: ${npc}` });

  // 如果纯属主动问候事件（!text && eventType === 'greeting'），直接由洗牌袋出高质量非 AI 感语料
  if (!text && eventType === 'greeting') {
    const reply = getLocalGamerGirlReply(c, '', 'greeting');
    // T-10：问候短路的正文同样过称呼注入（问候池是最常带称呼的一批语料）
    const burst = buildChatBurst(reply, c, CALL_NAME_CHANNELS.CHAT);
    return res.json({
      ok: true,
      npc: c.name,
      reply: burst.replies[0] || reply,
      replies: burst.replies,
      delays_ms: burst.delays_ms,
      overflow_mail: burst.overflow_mail,
      sleeping: false,
      mood: c.current_mood,
      affection: c.affection_level,
      relationship_stage: c.relationship_stage,
      // 契约：等价 local（未走 LLM 的本地洗牌袋直出）。见顶部 SOURCE 常量表。
      source: SOURCE.PROACTIVE_SHUFFLE
    });
  }

  // 1. 尝试在线 LLM（带 1.5 秒硬超时）
  // P0-B：failureSink 是**本次请求独有**的对象。playgroundChat 内部若命中
  // generateReply 的失败兜底，会往它写 {failed:true, reason}，据此把 source 标成
  // api_fallback。用请求级对象而非按 companion 查表，是为避免同一 NPC 并发请求互相串味。
  // 注：不在声明处给 `null` 初值——try 与 catch 两条路径都会赋值，
  // 多写的初值会被 eslint 的 no-useless-assignment 判为死赋值。
  let onlineResult;
  const failureSink = {};

  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('API_TIMEOUT')), CHAT_TIMEOUT_MS)
    );
    const safeOnlineChat = playgroundChat(c, text, { failureSink }).catch(err => {
      log('warn', `[Game] 在线生成异常 npc=${c.name}: ${err.message}`);
      return null;
    });
    onlineResult = await Promise.race([safeOnlineChat, timeoutPromise]);
  } catch (err) {
    log('warn', `[Game] 在线生成降级 npc=${c.name} 原因: ${err.message}`);
    onlineResult = null;
  }

  // ★ 睡眠态**必须最先判**（t13 F-2 的修复）：
  // 睡眠门命中时 playgroundChat 返回的是 `{sleeping:true, reply:null}`（playground.mjs 的
  // 睡眠门早退），而旧实现把 `onlineResult.reply` 非空当成了进入本段的前置条件 →
  // `if (onlineResult.sleeping)` 永远轮不到执行（只有"有正文且 sleeping 为真"才可达，
  // 而那种组合 playgroundChat 从不产生）→ 流程错误地落到下面的本地语料分支，
  // 报成 `source='local'` + `source_reason='online_path_failed'`（**错报**：真实原因是睡眠门），
  // 且 Go 侧会把"她睡了"当正常回复转录。现在先单独识别睡眠态。
  if (onlineResult?.sleeping) {
    return res.json({
      ok: true,
      npc: c.name,
      reply: '',
      replies: [],
      delays_ms: [],
      overflow_mail: null,
      sleeping: true,
      mood: c.current_mood,
      affection: c.affection_level,
      relationship_stage: c.relationship_stage,
      source: normalizeSource(SOURCE.SLEEPING),
      source_reason: SOURCE_REASONS.SLEEP_GATE,
    });
  }

  if (onlineResult && onlineResult.reply) {
    // ★ P0-B 核心：LLM 失败兜底不再冒充成功。
    // ai.mjs 的 catch 仍然 return FALLBACK（不打断 10 个既有调用方），但会往本次请求的
    // failureSink 写 failed=true；这里据此把 source 从 api 分流为 api_fallback，
    // 让 Go 侧能按契约丢弃并改走本地池——修掉"失败被自愈掩盖、玩家被告知 source:'api'"。
    const apiFailed = !!failureSink.failed || !!onlineResult.apiFailed;
    // T-10：LLM 路径通常已在 prompt 里带了称呼（companion.mjs:402），但必须**同样过一遍守卫**——
    // 模型回显 `{player_nickname}` / 语料被拼进 prompt 后原样吐回，都靠这一层拦住。
    const burst = buildChatBurst(onlineResult.reply, c, CALL_NAME_CHANNELS.CHAT);
    return res.json({
      ok: true,
      npc: c.name,
      reply: burst.replies[0] || onlineResult.reply,
      replies: burst.replies,
      delays_ms: burst.delays_ms,
      overflow_mail: burst.overflow_mail,
      sleeping: false,
      // ★ P0-A：状态即时化。playgroundChat 已把 syncUpdateCompanionState 提到响应之前
      // 同步执行，所以 onlineResult.state 就是本次生成后的最新值。原实现用 c.* 兜底，
      // 而 c 是**本轮开始前**查的行对象 → 玩家看到的好感/阶段永远慢一轮（已修）。
      mood: onlineResult.state?.mood ?? c.current_mood,
      affection: onlineResult.state?.affection_level ?? c.affection_level,
      relationship_stage: onlineResult.state?.relationship_stage ?? c.relationship_stage,
      source: normalizeSource(apiFailed ? SOURCE.API_FALLBACK : SOURCE.API),
      // t13 F-3：这里只放**枚举**（`llm_failed`）。原始 provider 错误串（含 .env / API_KEY /
      // provider 名）不得进响应体——它已经在 `[ai] chat 错误` 与 `[Game]` 日志里了。
      ...(apiFailed ? { source_reason: SOURCE_REASONS.LLM_FAILED } : {}),
      // 诊断字段（非契约必需，Go 可忽略）：本轮冷落档
      ...(onlineResult.neglectStage && onlineResult.neglectStage !== 'none'
        ? { neglect_stage: onlineResult.neglectStage } : {}),
    });
  }

  // 3. 【无感退本地】：走本地短句语料（0ms 响应，绝不卡死）
  // 语义（定调 §17.1 冻结，勿改）：能走到这里 = 在线 LLM 这条**已经尝试过**且
  // `playgroundChat` 整体未产出可用结果（超时熔断 / 生成链路异常）。此时**返回的正文是本地语料**，
  // 所以 source 必须是 `local`——按契约 `api_fallback` 的含义是"正文是固定兜底句，Go 应丢弃"，
  // 若这里错标 api_fallback，Go 会把**好内容当垃圾扔掉**（反而更糟）。
  //
  // 可达性（t13 曾判"死代码"，实测证伪）：进入本段的唯一现实触发是**上面的 4s 超时熔断**
  // （`CHAT_API_TIMEOUT_MS` + `Promise.race`），即 provider 悬挂 / 回包慢于预算。
  // 这不是边角情形——恰好是最主要的真实故障形态。门禁 `dnf_brain_p0_smoke.mjs` 用
  // "黑洞端点 + 短超时"确定性复现它。若将来有人再把它判成死代码，请先跑那条用例。
  const fallbackReply = getLocalGamerGirlReply(c, text, eventType);
  // T-10：本地兜底是**最容易漏占位符**的一条（语料原文直出）——必须过注入
  const burst = buildChatBurst(fallbackReply, c, CALL_NAME_CHANNELS.CHAT);
  return res.json({
    ok: true,
    npc: c.name,
    reply: burst.replies[0] || fallbackReply,
    replies: burst.replies,
    delays_ms: burst.delays_ms,
    overflow_mail: burst.overflow_mail,
    sleeping: false,
    mood: c.current_mood,
    affection: c.affection_level,
    relationship_stage: c.relationship_stage,
    source: normalizeSource(SOURCE.LOCAL),
    // t13 F-3：不再透传 `failureSink.reason`（原始 provider 错误串，含 .env / API_KEY / provider 名）。
    // 响应体只放**枚举值**；原始原因留在服务端日志（`[Game] 在线生成降级 …`）。
    source_reason: SOURCE_REASONS.ONLINE_PATH_FAILED,
  });
});

// ── POST /game/mail：游戏邮件生成（含情境状态机附件与本地保底） ────────────────────
gameRouter.post('/game/mail', async (req, res) => {
  const npc = req.body?.npc;
  const hint = String(req.body?.hint ?? '').trim().slice(0, 500);
  const scenarioInput = req.body?.scenario || req.body?.event_type;
  const targetItemId = Number(req.body?.attach_item_id || req.body?.item_id || 0);
  const targetUpgradeLevel = req.body?.upgrade_level !== undefined ? Number(req.body.upgrade_level) : null;

  const c = findCompanion(npc);
  if (!c) return res.status(404).json({ ok: false, error: `恋人 NPC 不存在: ${npc}` });

  // 1. 解析情境与选取专属礼物（废除 Math.random 盲抽，绑定情境状态机）
  const scenarioInputRaw = String(scenarioInput ?? '').trim();
  const scenario = resolveMailScenario({
    scenario: scenarioInput,
    hint,
    targetItemId
  });
  // T-7：未知情境的**可见降级**标记（日志+计数在 resolveMailScenario 内已完成）。
  // 未给情境（正常默认）不标降级，避免把"没说"误报成"说错了"。
  const scenarioDegraded = scenario === MAIL_SCENARIO_UNKNOWN;
  const scenarioOut = scenarioDegraded ? MAIL_SCENARIOS.OFFLINE_CARE : scenario;

  const gift = selectMailGift({
    scenario,
    hint,
    targetItemId,
    targetUpgradeLevel
  });

  // ★ U5 修复：邮件兜底**三分支**（原实现是 `isTuanzi ? tuanzi : peach` → heika 会拿到 peach 文案，
  // 三人设串味）。角色判定与 `getLocalGamerGirlReply` 的 roleKey 口径保持一致
  //（`rg -n "let roleKey" src/game_dnf.mjs`），避免同一角色在两处被定成不同的人。
  const isTuanzi = c.name.includes('团子');
  const isHeika = c.name.includes('黑咖') || c.name.includes('助手');
  const mailRole = isTuanzi ? 'tuanzi' : (isHeika ? 'heika' : 'peach');
  // ★ U4 续：正文按**角色**解析（v3 三新情境在索引里是空正文占位，正文在角色语料里）。
  //   返回 { title, body, source, degraded }，degraded 会在响应里透出（可见降级）。
  const roleDialogue = resolveMailDialogue(gift, mailRole, scenarioOut);
  const localDefault = roleDialogue.body || gift.dialogue?.[mailRole] || gift.dialogue?.peach || '';
  const localTitle = roleDialogue.title || gift.dialogue?.title || '';

  // 2. 尝试在线 LLM 生成邮件正文
  let mailResult = null;
  let usedLocalFallback = false;
  let source = SOURCE.API;
  // P0-B：邮件路径同样用请求级 failureSink 拿到"这次到底成功没成功"
  const failureSink = {};

  try {
    const personaPrompt = buildSystemPrompt(c, { promptMode: 'reply' });
    const instruction = [
      // 禁用词清零（t13 F-4 延伸）：这里原写"给冒险家寄信"，而「冒险家」属 E 类严禁称呼。
      // 虽然是发给人设 LLM 的指令（不是直接出话），但模型有回显风险，且 prompt 里出现禁用词
      // 本身就违反 E 类口径 → 改成中性描述"给他寄信"。
      `现在你要在 DNF 塞拉邮局给他寄信，触发情境：【${scenario}】。随信附赠了：【${gift.name} × ${gift.count}】。`,
      `寄信由头：${gift.reason}。${hint ? '额外背景：' + hint : ''}`,
      '严格按以下格式输出，不要输出任何其他内容：',
      '第一行：`标题：<不超过14字的邮件标题>`',
      '第二行起：正文（40~90字，口语自然，真实女玩家口吻，自然提到附赠的物品）',
      '【严禁AI说教味】：像真实网恋女玩家一样说话，不要向对方科普游戏机制或道具定义，说话要有性格和生活感。',
      '严禁出现现代词汇或不可交易道具。',
    ].filter(Boolean).join('\n');

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('API_TIMEOUT')), 3000)
    );

    const safeGenerate = generateReply(personaPrompt, [], instruction, { max_tokens: 400 },
      { companionId: c.id, failureSink }).catch(err => {
      log('warn', `[Game] 邮件在线生成异常 npc=${c.name}: ${err.message}`);
      return null;
    });

    const mail = await Promise.race([
      safeGenerate,
      timeoutPromise
    ]);

    const raw = String(mail || '').trim();
    const m = raw.match(/标题[：:]\s*(.+)\s*\n?([\s\S]*)/);
    if (m && m[1] && m[2]) {
      mailResult = {
        title: m[1].trim().slice(0, 16),
        body: m[2].trim()
      };
    }
  } catch (e) {
    log('warn', `[Game] 邮件在线生成降级 npc=${c.name}: ${e.message}`);
    mailResult = null;
  }

  // 3. 降级回退到本地保底信件
  // 语义（与 /game/chat 第 3 段同理）：generateReply 失败时不抛、返回固定兜底句，上面
  // `raw.match(/标题[：:]/)` 匹配不到 → mailResult 为 null → 落到**本地保底信**
  // （gift.dialogue.*，是本地内容，不是固定兜底句）。
  // 因此 source 必须是 `local`（正文是本地语料，Go 应正常转录），
  // "LLM 不可用"由 source_reason 承载——错标 api_fallback 会让 Go 丢掉这封本来可用的信。
  if (!mailResult) {
    source = SOURCE.LOCAL;
    usedLocalFallback = true;
    mailResult = {
      title: localTitle || gift.dialogue?.title || '',
      body: localDefault
    };
    // 正文若走了降级级（③④⑤），必须**可见**：WARN + 计数 + 响应标记（§11.6 铁律）
    if (roleDialogue.degraded) {
      _mailTextStats.degraded += 1;
      const w = `[Game] 邮件正文降级取用（该角色无本情境 v3 正文）：npc=${c.name} role=${mailRole} ` +
        `scenario=${scenarioOut} 取自=${roleDialogue.source}`;
      _mailTextStats.lastWarning = w;
      log('warn', w);
    }
  }

  // 3.1（t30）称呼注入**必须早于**通道预算执行：注入会改变文本长度，
  // 先注入再截断，才能保证"截断后的文本里也没有占位符"，也才不会因为注入变长而越界。
  const mailTitleOut = injectCallNames(mailResult.title, c, { channel: CALL_NAME_CHANNELS.MAIL_TITLE });
  const mailBodyOut = injectCallNames(mailResult.body, c, { channel: CALL_NAME_CHANNELS.MAIL_BODY });

  // 3.2（t29）邮件通道三约束的**唯一执行点**：标题 ≤30B / 正文 ≤360B /
  // Subject+'\n'+Body < 512B。超界会**可见截断**（WARN + getMailScenarioStats().clamped），
  // 并把实测字节回给 Go 侧（不再像旧实现那样 `slice(0,16)` 静默超界且无度量）。
  const mailBytes = enforceMailChannelLimits({ title: mailTitleOut.text, body: mailBodyOut.text });
  mailResult = { title: mailBytes.title, body: mailBytes.body };

  return res.json({
    ok: true,
    npc: c.name,
    // 契约：scenario 始终是**可消费的规范值**（未知时已归一为 offline_care 兜底），
    // 便于 Go 侧直接用它做后续判定而不必理解哨兵。
    scenario: scenarioOut,
    // T-7 可见降级三件套：收到什么 / 是否降级 / 为什么——响应里必须能看出来
    scenario_input: scenarioInputRaw || null,
    scenario_degraded: scenarioDegraded,
    ...(scenarioDegraded ? { scenario_degraded_reason: 'unknown_scenario_not_registered' } : {}),
    title: mailResult.title,
    body: mailResult.body,
    // t29：通道字节实测（GBK），供 Go 侧与门禁断言直接消费
    mail_bytes: {
      title_bytes: mailBytes.title_bytes,
      body_bytes: mailBytes.body_bytes,
      total_bytes: mailBytes.total_bytes,
      clamped: mailBytes.clamped,
    },
    attachment: {
      item_id: gift.item_id,
      item_name: gift.name,
      count: gift.count,
      upgrade_level: gift.upgrade_level || 0,
      category: gift.category
    },
    // t41 U4/U5：正文**取值来源**与是否降级——消费方可据此判断"这封信用的是不是本角色本情境的正文"。
    // 仅当本轮真的用了本地保底信（LLM 不可用）时才有降级含义；LLM 成功时标 'llm'。
    mail_text_source: mailResult ? (usedLocalFallback ? roleDialogue.source : 'llm') : 'llm',
    mail_text_role: mailRole,
    mail_text_degraded: usedLocalFallback ? roleDialogue.degraded : false,
    source: normalizeSource(source),
    // t13 F-3：同样只放枚举；原始 provider 错误串留在服务端日志，不入响应体。
    ...(failureSink.failed ? { source_reason: SOURCE_REASONS.LLM_FAILED } : {}),
  });
});
