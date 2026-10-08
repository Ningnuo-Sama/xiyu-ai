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
import { getDb, parseCompanionRow } from './db.mjs';
import { playgroundChat } from './playground.mjs';
import { buildSystemPrompt } from './companion.mjs';
import { generateReply } from './ai.mjs';

export const gameRouter = Router();

// 超时门限：4.0秒内未完成则快速熔断切本地，既给在线大模型充足生成时间，又符合真人打字延迟（“对方正在输入中…”）
const CHAT_TIMEOUT_MS = Number(process.env.CHAT_API_TIMEOUT_MS || 4000);

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
const CORPUS_DIR = path.resolve('data/dnf_corpus');
const corpusCache = {
  peach: { mtime: 0, data: null },
  tuanzi: { mtime: 0, data: null },
  mail: { mtime: 0, data: null }
};

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
    return corpusCache.mail?.data || null;
  }
}

function getLocalGamerGirlReply(companion, text, eventType = null) {
  const isTuanzi = companion.name.includes('团子');
  const roleKey = isTuanzi ? 'tuanzi' : 'peach';
  const hotData = loadCorpusHot(roleKey);
  const t = String(text || '').toLowerCase();
  const hour = new Date().getHours();

  // 1. 优先从外置结构化热更语料库中精准命中
  if (hotData) {
    // A. 防 AI 试探反击（绝不出戏自爆）
    if (/机器人|大模型|ai|人工智能|脚本|外挂|假人|chatgpt/.test(t)) {
      const antiLines = hotData.social?.anti_bot;
      if (antiLines?.length) return antiLines[Math.floor(Math.random() * antiLines.length)];
    }

    // B. 时间与作息摸鱼借口（专治“为什么上课还在线/秒回”）
    if (/上课|为什么在线|怎么在线|还在玩|没睡|怎么还没睡|在干嘛|在干啥|查寝/.test(t)) {
      let routineLines = null;
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
  const fallbackPool = isTuanzi ? GAMER_GIRL_CHAT_FALLBACK.tuanzi : GAMER_GIRL_CHAT_FALLBACK.peach;
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

// ── 3. 塞拉邮局合规礼物清单（100% 60版本真实可交易道具） ─────────────────────
export const DNF_LEGIT_MAIL_GIFTS = [
  {
    item_id: 11,
    name: '+11 生锈的武士刀',
    count: 1,
    upgrade_level: 11,
    category: 'pad_weapon',
    reason: '给他寄把垫刀用的高强白装武器',
    dialogue: {
      title: '给你垫刀的神器！',
      peach: '笨蛋！听说你要强主武器？这把+11武士刀是我废了好大劲才垫出来的，拿去当垫子垫碎了再上主武器，千万别炸啦！',
      tuanzi: '喂，听说你今天又要去搏命？这把+11垫子拿去垫刀！要是你的主武器再碎，以后就拿木棒带我刷图吧！'
    }
  },
  {
    item_id: 11,
    name: '+12 生锈的武士刀',
    count: 1,
    upgrade_level: 12,
    category: 'pad_weapon',
    reason: '极品高阶垫刀神器',
    dialogue: {
      title: '终极垫刀神器！',
      peach: '哇哇！我昨晚居然垫出一把+12武士刀！赶紧寄给你，拿去垫你的万仞，一发上13冲冲冲！',
      tuanzi: '哼，本姑娘手气爆棚垫出了+12武士刀！便宜你这个笨蛋了，拿去当极品垫子，碎了别找我哭！'
    }
  },
  {
    item_id: 3015,
    name: '炉岩碳',
    count: 50,
    category: 'catalyst',
    reason: '给他寄点强化用的炉岩碳',
    dialogue: {
      title: '给你赞助点碳！',
      peach: '听说你又要去找凯丽啦？诺，包里攒的50个炉岩碳全寄给你啦，祝你一把上10！待会记得带我刷图噢嘻嘻~',
      tuanzi: '整天就见你缺碳强化，喏，这50个拿去用吧！要是全便宜了凯丽那个老女人，看我不咬你！'
    }
  },
  {
    item_id: 3037,
    name: '无色小晶块',
    count: 200,
    category: 'cube',
    reason: '组队45大招报销',
    dialogue: {
      title: '大招随便放！',
      peach: '今天带我刷图表现太棒啦！这200个无色小晶块给你报销，待会大招随便放，无色我管够！',
      tuanzi: '看你刷图放个45技能扣扣搜搜的……诺，200个无色拿去，别在副本里给我丢人！'
    }
  },
  {
    item_id: 1002,
    name: '天空之城泉水',
    count: 30,
    category: 'recovery',
    reason: '回血回蓝补给品',
    dialogue: {
      title: '宿舍要熄灯啦~',
      peach: '宿管阿姨马上要拉闸断电了，我得关电脑啦。今天给你留了30个天空泉水，别老舍不得喝药，明天记得找我！',
      tuanzi: '要熄灯断网了！这30个泉水寄给你，刷图残血记得喝，别老让我看到你躺尸！'
    }
  },
  {
    item_id: 1055,
    name: '蓝色圣经',
    count: 5,
    category: 'special',
    reason: '打领主加回避保命神器',
    dialogue: {
      title: '保命圣经快拿着！',
      peach: '听说你要去打无头骑士？做任务特意给你留了5本蓝色圣经，+20%回避率呢，保命别老被秒！',
      tuanzi: '听说某个笨蛋老被boss秒？这5本蓝色圣经吃了加回避，别再笨手笨脚被撞飞了！'
    }
  }
];

// ── POST /game/chat：1:1 私聊（API 优先，1.5s 超时瞬间退本地） ───────────────
gameRouter.post('/game/chat', async (req, res) => {
  const npc = req.body?.npc;
  const text = String(req.body?.text ?? '').trim();
  const eventType = req.body?.event_type || null;

  if (!text) return res.status(400).json({ ok: false, error: 'text 不能为空' });
  if (text.length > 2000) return res.status(400).json({ ok: false, error: 'text 过长（>2000）' });

  const c = findCompanion(npc);
  if (!c) return res.status(404).json({ ok: false, error: `恋人 NPC 不存在: ${npc}` });

  // 1. 尝试在线 LLM（带 1.5 秒硬超时）
  let onlineResult = null;
  let source = 'api';

  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('API_TIMEOUT')), CHAT_TIMEOUT_MS)
    );
    const safeOnlineChat = playgroundChat(c, text).catch(err => {
      log('warn', `[Game] 在线生成异常 npc=${c.name}: ${err.message}`);
      return null;
    });
    onlineResult = await Promise.race([safeOnlineChat, timeoutPromise]);
  } catch (err) {
    log('warn', `[Game] 在线生成降级 npc=${c.name} 原因: ${err.message}`);
    onlineResult = null;
  }

  // 2. 如果在线成功，返回在线内容
  if (onlineResult && onlineResult.reply) {
    return res.json({
      ok: true,
      npc: c.name,
      reply: onlineResult.reply,
      sleeping: !!onlineResult.sleeping,
      mood: onlineResult.state?.mood ?? c.current_mood,
      affection: onlineResult.state?.affection_level ?? c.affection_level,
      relationship_stage: onlineResult.state?.relationship_stage ?? c.relationship_stage,
      source: 'api'
    });
  }

  // 3. 【无感退本地】：命中本地短句语料（0ms 响应，绝不卡死）
  const fallbackReply = getLocalGamerGirlReply(c, text, eventType);
  return res.json({
    ok: true,
    npc: c.name,
    reply: fallbackReply,
    sleeping: false,
    mood: c.current_mood,
    affection: c.affection_level,
    relationship_stage: c.relationship_stage,
    source: 'local'
  });
});

// ── POST /game/mail：游戏邮件生成（含合规附件与本地保底） ────────────────────
gameRouter.post('/game/mail', async (req, res) => {
  const npc = req.body?.npc;
  const hint = String(req.body?.hint ?? '').trim().slice(0, 500);
  const targetItemId = Number(req.body?.attach_item_id || 0);

  const c = findCompanion(npc);
  if (!c) return res.status(404).json({ ok: false, error: `恋人 NPC 不存在: ${npc}` });

  // 1. 选取合规礼物（优先匹配指定 item_id，否则随机）
  const gift = DNF_LEGIT_MAIL_GIFTS.find(g => g.item_id === targetItemId)
            || DNF_LEGIT_MAIL_GIFTS[Math.floor(Math.random() * DNF_LEGIT_MAIL_GIFTS.length)];

  const isTuanzi = c.name.includes('团子');
  const localDefault = isTuanzi ? gift.dialogue.tuanzi : gift.dialogue.peach;

  // 2. 尝试在线 LLM 生成邮件正文
  let mailResult = null;
  let source = 'api';

  try {
    const personaPrompt = buildSystemPrompt(c, { promptMode: 'reply' });
    const instruction = [
      `现在你要在 DNF 塞拉邮局给冒险家寄信，随信附赠了：【${gift.name} × ${gift.count}】。`,
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

    const safeGenerate = generateReply(personaPrompt, [], instruction, { max_tokens: 400 }, { companionId: c.id }).catch(err => {
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
  if (!mailResult) {
    source = 'local';
    mailResult = {
      title: gift.dialogue.title,
      body: localDefault
    };
  }

  return res.json({
    ok: true,
    npc: c.name,
    title: mailResult.title,
    body: mailResult.body,
    attachment: {
      item_id: gift.item_id,
      item_name: gift.name,
      count: gift.count,
      upgrade_level: gift.upgrade_level || 0,
      category: gift.category
    },
    source
  });
});
