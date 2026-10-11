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
const GAMER_GIRL_CHAT_FALLBACK = {
  peach: { // 软糖小桃子（女元素，软萌黏人，手残求带）
    equip_broken: [
      "摸摸头不哭……明天带你搬砖攒钱！",
      "呜呜碎了呀？旧的不去新的不来嘛抱抱~",
      "笨蛋别难过啦，我把私房金币都给你！"
    ],
    carry: [
      "好呀好呀！带我刷一把悬空城嘛好不好~",
      "等我下，我马上飞过来找你！",
      "呜呜我黑猫老放空，哥哥快来带我QAQ"
    ],
    greeting: [
      "在呢在呢！刚才在西海岸看海吹风呢~",
      "哥哥你终于上线啦OvO！",
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
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (corpusCache[name]?.data && corpusCache[name].mtime === stat.mtimeMs) {
      return corpusCache[name].data;
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    corpusCache[name] = { mtime: stat.mtimeMs, data: parsed };
    return parsed;
  } catch (err) {
    // B-4：不再静默。文件存在却解析/读取失败 = 语料写坏了，必须可见（见 warnCorpusFallback）
    if (fs.existsSync(filePath)) {
      const sha1 = crypto.createHash('sha1').update(String(err?.message || err)).digest('hex');
      warnCorpusFallback(`语料 ${name}`, filePath, err, sha1);
    }
    return corpusCache[name]?.data || null;
  }
}

function loadMailTemplatesHot() {
  const filePath = path.join(CORPUS_DIR, 'mail_templates.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (corpusCache.mail?.data && corpusCache.mail.mtime === stat.mtimeMs) {
      return corpusCache.mail.data;
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    corpusCache.mail = { mtime: stat.mtimeMs, data: parsed };
    return parsed;
  } catch (err) {
    // B-4：同 loadCorpusHot —— 邮件模板写坏必须可见，不能"改了没生效还一声不吭"
    if (fs.existsSync(filePath)) {
      const sha1 = crypto.createHash('sha1').update(String(err?.message || err)).digest('hex');
      warnCorpusFallback('邮件模板', filePath, err, sha1);
    }
    return corpusCache.mail?.data || null;
  }
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

/** 测试用：清零计数（含最近一条告警原文）。 */
export function resetMailScenarioStats() {
  _mailScenarioStats.resolved = 0;
  _mailScenarioStats.unknown = 0;
  _mailScenarioStats.hintFallback = 0;
  _mailScenarioStats.clamped = 0;
  _mailScenarioStats.lastWarning = null;
  _unknownScenarioSeen.clear();
}

// ── 3.2 邮件通道三约束的唯一执行点（t29） ─────────────────────────────────────
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
      peach: '哥哥！我包里存的20张深渊票寄给你啦，今天一定要带我爆出金色闪光史诗呀OvO！',
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

  const pick = (...preds) => {
    for (const p of preds) {
      const hit = allGifts.find(p);
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
        || safeNonWeapon(allGifts);
    }

    case MAIL_SCENARIOS.OFFLINE_CARE:
    default: {
      // 晚安送水/日常补给，杜绝高强武器；default 分支同样守住"不落武器"
      if (/圣经|回避|保命|无头/.test(h)) {
        return pick(byCategory('special'), byItem(1070), byCategory('recovery')) || safeNonWeapon(allGifts);
      }
      if (/无色|大招|晶块|报销/.test(h)) {
        return pick(byCategory('cube'), byItem(3174), byCategory('recovery')) || safeNonWeapon(allGifts);
      }
      // 默认送天空之城泉水
      return pick(byCategory('recovery'), byItem(1048)) || safeNonWeapon(allGifts);
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
    const burst = chunkToBursts(reply);
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

  // [t13] 临时探针（验证用，验证结束后删除）
  log('warn', '[t13probe] onlineResult=' + (onlineResult === null ? 'null' : (onlineResult === undefined ? 'undefined' : 'obj'))
      + ' reply=' + JSON.stringify(String((onlineResult && onlineResult.reply) || '').slice(0, 40))
      + ' sleeping=' + String(onlineResult && onlineResult.sleeping)
      + ' apiFailed=' + String(onlineResult && onlineResult.apiFailed)
      + ' sinkFailed=' + String(!!failureSink.failed) + ' sinkReason=' + JSON.stringify(failureSink.reason || ''));

  // 2. 在线分支返回（经方案B断句切分）
  if (onlineResult && onlineResult.reply) {
    // 睡眠态单独成值：她没生成内容，只是"睡了"，不是失败也不是本地语料
    if (onlineResult.sleeping) {
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
      });
    }
    // ★ P0-B 核心：LLM 失败兜底不再冒充成功。
    // ai.mjs 的 catch 仍然 return FALLBACK（不打断 10 个既有调用方），但会往本次请求的
    // failureSink 写 failed=true；这里据此把 source 从 api 分流为 api_fallback，
    // 让 Go 侧能按契约丢弃并改走本地池——修掉"失败被自愈掩盖、玩家被告知 source:'api'"。
    const apiFailed = !!failureSink.failed || !!onlineResult.apiFailed;
    const burst = chunkToBursts(onlineResult.reply);
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
      ...(apiFailed ? { source_reason: onlineResult.apiFailureReason || failureSink.reason || 'llm_failed' } : {}),
      // 诊断字段（非契约必需，Go 可忽略）：本轮冷落档
      ...(onlineResult.neglectStage && onlineResult.neglectStage !== 'none'
        ? { neglect_stage: onlineResult.neglectStage } : {}),
    });
  }

  // 3. 【无感退本地】：走本地短句语料（0ms 响应，绝不卡死）
  // 语义（定调 §17 冻结，勿改）：能走到这里 = 在线 LLM 这条**已经尝试过**且 `playgroundChat`
  // 整体 reject（超时熔断 / 生成链路异常）。此时**返回的正文是本地语料**，
  // 所以 source 必须是 `local`——按契约 `api_fallback` 的含义是"正文是固定兜底句，Go 应丢弃"，
  // 若这里错标 api_fallback，Go 会把**好内容当垃圾扔掉**（反而更糟）。
  // "LLM 此刻不可用"这个信息由 `source_reason:'online_path_failed'` 与计数承载，不靠错标正文语义。
  const fallbackReply = getLocalGamerGirlReply(c, text, eventType);
  const burst = chunkToBursts(fallbackReply);
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
    source_reason: failureSink.reason || 'online_path_failed',
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

  const isTuanzi = c.name.includes('团子');
  const localDefault = isTuanzi ? gift.dialogue.tuanzi : gift.dialogue.peach;

  // 2. 尝试在线 LLM 生成邮件正文
  let mailResult = null;
  let source = SOURCE.API;
  // P0-B：邮件路径同样用请求级 failureSink 拿到"这次到底成功没成功"
  const failureSink = {};

  try {
    const personaPrompt = buildSystemPrompt(c, { promptMode: 'reply' });
    const instruction = [
      `现在你要在 DNF 塞拉邮局给冒险家寄信，触发情境：【${scenario}】。随信附赠了：【${gift.name} × ${gift.count}】。`,
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
    mailResult = {
      title: gift.dialogue.title,
      body: localDefault
    };
  }

  // 3.1（t29）邮件通道三约束的**唯一执行点**：标题 ≤30B / 正文 ≤360B /
  // Subject+'\n'+Body < 512B。超界会**可见截断**（WARN + getMailScenarioStats().clamped），
  // 并把实测字节回给 Go 侧（不再像旧实现那样 `slice(0,16)` 静默超界且无度量）。
  const mailBytes = enforceMailChannelLimits({ title: mailResult.title, body: mailResult.body });
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
    source: normalizeSource(source),
    ...(failureSink.failed ? { source_reason: failureSink.reason || 'llm_failed' } : {}),
  });
});
