/**
 * 称呼建议派生（t133）—— 「名字太长时她会怎么叫你」的离线启发式 + 模型增强的纯函数层
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 为什么重写（用户 2026-10-13 实测反馈）
 *
 * 旧规则只会**从头砍一刀**：对「超级无敌大魔王」给 `超级 / 超超 / 超` ——
 * 三条都丢了语义核心，**没有一条是真人会给朋友起的短名**。
 * 新规则先回答"一个真人会怎么叫"，再落成机器可判定的步骤：
 *
 *   ① **剥程度/修饰前缀**（超级、无敌、最强、宇宙第一…），**反复剥到不能再剥**。
 *      ⚠️ 绝不剥 `大 / 小 / 老 / 阿`——"大魔王"的"大"是名字本身，剥掉就毁了。
 *   ② **取尾部语义核**：剥完前缀后优先取尾部 2~4 字（"大魔王"= 3 字）。
 *      若尾窗里冒出 `小/阿/老/大` 这种"名字常从这儿开始"的字，就**从它重新锚定**
 *      （"声烦大魔王" → "大魔王"；"烦小可爱" → "小可爱"）。
 *   ③ **质量过滤**（比门禁更早的一道"像不像人话"）：不含虚词/描述词、非纯数字、
 *      非纯修饰字、2~4 字（单字只作最后手段）、候选之间不互相包含。
 *   ④ 旧的"前缀 2 字 / 首字叠用 / 单字"**保留为补充来源**、排在尾部语义核之后；
 *      但一条若整串只由修饰字组成（`超级`/`超超`/`超`）⇒ 过滤掉——**那正是用户抱怨的候选**。
 *
 * 本模块**只产出候选文本，不做落库判定**：能不能落库一律由门禁本体
 * （nickname_gate.mjs 的 `extractNicknameCandidate → validateNicknameCandidate`）说了算，
 * 这里**不写第二套判定**。模型增强同样只产出文本，由接入方逐条回灌门禁。
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { normNicknameInput } from './nickname_gate.mjs';

/**
 * 程度/修饰前缀词表（**只剥程度，绝不剥 大/小/老/阿**）。
 *
 * 用法：按**长度从长到短**匹配，命中即剥、循环到本轮无变化（故 `超级超级大魔王` 也能剥干净）。
 * 词表刻意保守：宁可漏剥一个夸张前缀（尾核规则仍能救回来），也不要误剥名字本体。
 */
export const NICKNAME_MODIFIER_PREFIXES = Object.freeze([
  '宇宙第一', '天下第一', '世界第一', '史上最强', '最强无敌', '无敌最强', '究极无敌', '超级无敌',
  '史上最', '传说级', '神话级', '史诗级', '究极体',
  '超级', '无敌', '最强', '究极', '终极', '传说', '神话', '史诗', '神级', '顶级', '至尊', '至高',
  '绝世', '无双', '天生', '第一', '巅峰',
]);

/** 词表用到的**字**集合（用于"整串只由修饰字组成 ⇒ 不是名字"的过滤，如 `超级`/`超超`/`超`）。 */
const MODIFIER_CHARS = new Set([...NICKNAME_MODIFIER_PREFIXES.join('')]);

/** 长词优先匹配（模块级预排一次，避免每次调用重排）。 */
const PREFIXES_BY_LEN = [...NICKNAME_MODIFIER_PREFIXES].sort((a, b) => b.length - a.length);

/** "名字常从这儿开始"的字：尾窗里出现在非首位时，从它重新锚定（**不是**可剥前缀）。 */
const NAME_HEAD_CHARS = ['小', '阿', '老', '大'];

/** 昵称常见的收尾字（打分用：`团子`/`桃子`/`宝儿` 这类更像昵称）。 */
const NAME_TAIL_CHARS = ['子', '儿', '宝', '酱', '娃', '仔', '君', '妹', '弟', '哥', '姐'];

/** 虚词/描述词**整词**（候选不得包含；如 `特别`/`非常` 得整体判，不能只看单字）。 */
const FUNCTION_TOKENS = ['特别', '非常', '什么', '怎么', '这个', '那个', '一个'];

/** 虚词/描述词**单字**（候选不得含这些字）。 */
const FUNCTION_CHARS = new Set([
  ...'的了个是名字叫我你他她它们很太真好就都也和与或在有这那把被给让向对从为于而但却',
  ...'吧啊呀哦嘛啦呢吗哈哟呗喂',
]);

/** 纯汉字数字（`一一`/`三三` 这种算"数量词"，不是昵称）。 */
const NUMERAL_CHARS = new Set([...'零一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾']);

/** 量词（只用于"数词+量词开头 ⇒ 不是名字"这一条：`一只`/`一个` 不能当昵称）。 */
const MEASURE_CHARS = new Set([...'只个位条头群双支张间块根匹朵棵台件份串束副把名次岁天年']);

/** 是否"数词 + 量词"开头（`一只` ⇒ true；`大头` ⇒ false，因为 `大` 不是数词）。 */
function startsWithNumeralMeasure(text) {
  const chars = [...String(text ?? '')];
  return chars.length >= 2 && NUMERAL_CHARS.has(chars[0]) && MEASURE_CHARS.has(chars[1]);
}

/**
 * 反复剥"程度/修饰前缀"（含剥离后残留在开头的一个 `的`），**剥到不能再剥**。
 *
 * 守卫：剥完必须还剩 ≥2 字，否则**不剥**——避免 `超级` 被剥成空串、
 * 或者把 `大魔王` 这类本就短的名字剥没了。
 */
export function stripNicknameModifiers(rawText) {
  let out = normNicknameInput(rawText);
  for (let i = 0; i < 12; i++) {
    const before = out;
    const len = [...out].length;
    for (const p of PREFIXES_BY_LEN) {
      if (out.startsWith(p) && len - [...p].length >= 2) {
        out = out.slice(p.length);
        break;
      }
    }
    if (out.startsWith('的') && [...out].length - 1 >= 2) out = out.slice(1);
    if (out === before) break;
  }
  return out;
}

/** 整串是否只由修饰字组成（`超级`/`超超`/`无敌`/`超` ⇒ true）。 */
function isModifierOnly(text) {
  const chars = [...String(text ?? '')];
  return chars.length > 0 && chars.every((ch) => MODIFIER_CHARS.has(ch));
}

/** 整串是否只由数字字组成（`一一`/`三三` ⇒ true）。 */
function isNumeralOnly(text) {
  const chars = [...String(text ?? '')];
  return chars.length > 0 && chars.every((ch) => NUMERAL_CHARS.has(ch));
}

/**
 * 「这条候选像不像人话」——**比门禁更早的一道质量过滤**（门禁仍是最终权威）。
 *
 * 判据（全部为真才算通过）：
 *   · 只含汉字（不混字母/数字/标点/空白/符号）；
 *   · 长度 2~4 字；单字仅在 `allowSingle`（"最后手段"那条来源）时放行；
 *   · 非纯数字、非纯数字字、**非"数词+量词"开头**（`一只`/`一个`）、非纯修饰字；
 *   · 不含虚词/描述词（`的/了/是/个/名/字/叫/我/你/特别/非常`…）。
 *
 * ⚠️ 为什么必须有它：`超级` 这种串**能过 G-N1**（门禁只管落库安全，不管像不像名字），
 * 所以"不丑"这件事只能在这一层挡。
 */
export function isLikelyNickname(text, { allowSingle = false } = {}) {
  const s = String(text ?? '').trim();
  if (s === '') return false;
  if (!/^\p{Script=Han}+$/u.test(s)) return false;   // 只收汉字：混字母/数字/标点一律不要
  const chars = [...s];
  if (chars.length > 4) return false;
  if (chars.length === 1 && !allowSingle) return false;
  if (isNumeralOnly(s)) return false;
  if (startsWithNumeralMeasure(s)) return false;
  if (isModifierOnly(s)) return false;
  if (FUNCTION_TOKENS.some((t) => s.includes(t))) return false;
  if (chars.some((ch) => FUNCTION_CHARS.has(ch))) return false;
  return true;
}

/** 尾窗的"语义起点再锚定"：窗里出现 `小/阿/老/大` 且不在首位 ⇒ 从它截起。 */
function reanchorToNameHead(text) {
  const chars = [...String(text ?? '')];
  for (let i = 1; i < chars.length; i++) {
    if (NAME_HEAD_CHARS.includes(chars[i])) return chars.slice(i).join('');
  }
  return String(text ?? '');
}

/** 昵称"形状分"：以 `小/阿/老/大` 开头 > 收尾字像昵称 > 叠字 > 3 字甜点区（同分保持生成顺序）。 */
function nicknameShapeScore(text) {
  const chars = [...String(text ?? '')];
  let score = 0;
  const headStart = NAME_HEAD_CHARS.includes(chars[0]);
  if (headStart) score += 2;
  const tailLike = NAME_TAIL_CHARS.includes(chars[chars.length - 1]);
  if (tailLike) score += 1;
  if (chars.length >= 2 && chars[0] === chars[1]) score += 1;
  // 3 字是中文昵称的甜点区，**但只给"像名字的"三字窗加分**（以语义起点开头 / 收尾像昵称）。
  // 否则会把 `最强王者` 切成 `强王者` 这种半截词（真机口径：宁可长一点，也别给半截词）。
  if (chars.length === 3 && (headStart || tailLike)) score += 0.5;
  else if (chars.length === 4) score += 0.25;
  return score;
}

/**
 * 尾部语义核：剥完前缀后的核 ≤4 字就整取；更长则取窗口，按"像不像昵称"打分排序。
 *
 * 窗口来源两类（都先过质量过滤，再做"互相包含 ⇒ 留高分那条"的去冗）：
 *   ① **尾窗** 3 → 2 → 4 字（3 字是甜点区；4 字放最后，因为它最容易切在词中间）
 *   ② **语义起点窗** 从核里出现的每个 `小/阿/老/大`（非首位）起，取 3 → 2 → 4 字
 *      —— "一只大魔王在此" → "大魔王"；"夜雨声烦大魔王" 也是靠它兜住
 */
function tailCoreTexts(core) {
  const chars = [...String(core ?? '')];
  if (chars.length === 0) return [];
  if (chars.length <= 4) {
    // ⚠️ 短核也要过质量过滤（t133 实测踩到）：`无敌超级大长名字` 剥完前缀得到 `大长名字`
    // （含虚词字 名/字）⇒ 若在这里直接放行，就会把"丑候选"重新放回来。
    const whole = chars.join('');
    return isLikelyNickname(whole) ? [whole] : [];
  }
  const raw = [];
  for (const n of [3, 2, 4]) {
    if (chars.length < n + 1) continue;                    // 至少留 1 字在前，避免"整串就是它自己"
    raw.push({ text: chars.slice(chars.length - n).join(''), prev: chars[chars.length - n - 1] });
  }
  for (let i = 1; i < chars.length; i++) {                 // 首位不用生成：尾窗已覆盖
    if (!NAME_HEAD_CHARS.includes(chars[i])) continue;
    for (const n of [3, 2, 4]) {
      if (i + n <= chars.length) raw.push({ text: chars.slice(i, i + n).join(''), prev: chars[i - 1] });
    }
  }
  const scored = [];
  for (const w of raw) {
    const t = reanchorToNameHead(w.text);                  // 尾窗里还夹着语义起点 ⇒ 从它截起
    if (!isLikelyNickname(t)) continue;
    if (scored.some((x) => x.text === t)) continue;
    // "前一个字也是语义起点"（如 `大` + `暴龙战士`）说明这里大概率是词的边界 ⇒ 小幅加分。
    const bonus = NAME_HEAD_CHARS.includes(w.prev) ? 1 : 0;
    scored.push({ text: t, score: nicknameShapeScore(t) + bonus });
  }
  scored.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const c of scored) {                                // 互相包含 ⇒ 只留分数高的那条
    if (kept.some((k) => k.text.includes(c.text) || c.text.includes(k.text))) continue;
    kept.push(c);
  }
  return kept.map((k) => k.text);
}

/**
 * 核心入口：给一个"过长候选"，按优先级产出**像人话的**派生候选文本。
 *
 * 顺序（**尾部语义核最前**）：
 *   ① `tail_core`    尾部语义核（真人的首选答案）
 *   ② `prefix2`      前缀 2 字（旧规则，保留为补充）
 *   ③ `repeat_head`  首字叠用（旧规则，保留为补充）
 *   ④ `single`       单字（旧规则，**最后手段**）
 *
 * 额外约束：候选之间**不互相包含**（`可爱` 与 `小可爱` 同时出现只是浪费名额），
 * 并整体去重；过不了 `isLikelyNickname` 的一律不出现在结果里。
 *
 * @returns {Array<{text:string, rule:'tail_core'|'prefix2'|'repeat_head'|'single'}>}
 */
export function deriveNicknameTexts(rawText, { maxTotal = 6, maxTail = 2 } = {}) {
  const norm = normNicknameInput(rawText);
  const core = stripNicknameModifiers(norm);
  const chars = [...norm];
  const out = [];
  const add = (text, rule) => {
    if (!text) return;
    if (out.some((x) => x.text === text || x.text.includes(text) || text.includes(x.text))) return;
    out.push({ text, rule });
  };

  // ① 尾部语义核（已在 tailCoreTexts 内过质量过滤与去冗）
  const tails = tailCoreTexts(core);
  for (const t of tails.slice(0, maxTail)) add(t, 'tail_core');

  // ② 前缀 2 字（旧规则补充）
  if (chars.length >= 3) {
    const t = chars.slice(0, 2).join('');
    if (isLikelyNickname(t)) add(t, 'prefix2');
  }
  // ③ 首字叠用（旧规则补充）
  if (chars.length >= 2) {
    const t = chars[0] + chars[0];
    if (isLikelyNickname(t)) add(t, 'repeat_head');
  }
  // ④ 单字（旧规则，最后手段）
  if (chars.length >= 1) {
    const t = chars[0];
    if (isLikelyNickname(t, { allowSingle: true })) add(t, 'single');
  }

  return out.slice(0, maxTotal);
}

// ─────────────────────────────────────────────────────────────────────────────
// 可选模型增强（第 3 层）
//
// 口径：**模型只负责"挑"，不负责"编"**；产出仍逐条回灌门禁（由接入方做）。
// 无 Key / 模型不可用 / 超时 ⇒ **一律不抛**，返回 `{called:true, ok:false, reason}`，
// 接入方据此静默回落离线派生（**降级路径必须有测试**）。
// 走的是仓库既有模型调用方式：providers/chat.mjs 的 `chatComplete()`
// （与 ai.mjs 的 `extractStructuredInfo` 同一条路，不另起一套 HTTP 客户端）。
// ─────────────────────────────────────────────────────────────────────────────

/** 让模型"从原句里挑昵称"的 system 提示（要求它保留语义核心，而不是砍头两字）。 */
export const NICKNAME_LLM_SYSTEM_PROMPT = [
  '你在给一个虚拟恋人角色当取名参谋。玩家报的称呼太长了（超过 6 个汉字，存不进库），',
  '请从**玩家自己报的这个称呼里**挑出 2~3 个最短、最像真人平时叫朋友的昵称。',
  '硬要求：',
  '1) 每条 2~4 个汉字；不含标点、数字、空格、表情；',
  '2) **必须保住名字里的语义核心**：例如「超级无敌大魔王」的核心是「大魔王」，',
  '   不要交「超级」「超超」这种只剩修饰词的答案；',
  '3) 不拼接新词、不音译、不解释；',
  '4) 只输出一个 JSON 字符串数组，例如 ["大魔王","魔王"]。',
].join('\n');

/** 组模型消息（纯函数，便于单测断言提示词形状）。 */
export function buildNicknameLlmMessages(rawText) {
  const s = String(rawText ?? '').trim();
  return {
    system: NICKNAME_LLM_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `玩家报的称呼：「${s}」（${[...s].length} 个汉字，太长了，给几个短名候选）` }],
  };
}

/** 把模型回复解析成候选文本数组（宽容解析：JSON 数组 / 换行 / 顿号逗号；失败⇒空数组）。 */
export function parseNicknameLlmReply(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return [];
  let items = null;
  const m = s.match(/\[[\s\S]*\]/);                 // 容忍 ```json 围栏与前后废话
  if (m) {
    try {
      const parsed = JSON.parse(m[0]);
      if (Array.isArray(parsed)) items = parsed;
    } catch { /* 不是 JSON ⇒ 退到文本切分 */ }
  }
  if (!items) items = s.split(/[\n,，、;；]+/);
  const out = [];
  const seen = new Set();
  for (const it of items) {
    if (it === null || it === undefined) continue;
    if (typeof it === 'object') continue;
    const t = String(it)
      .replace(/^[\s\-*·•\d.、"'「『【[(]+/u, '')
      .replace(/[\s"'」』】\])]+$/u, '')
      .trim();
    if (t === '' || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** 给模型调用套一个显式超时（真实超时路径可测：桩件挂起也会被这里兜住）。 */
function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('nickname_llm_timeout')), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/**
 * 采集模型候选。**永不抛**：任何失败都退化成 `texts: []` + 结构化 reason。
 *
 * @param {string} rawText 过长候选（门禁抽出来的那条）
 * @param {object} opts
 *   · `enabled`   是否启用模型增强（默认 false ⇒ `called:false, reason:'disabled'`）
 *   · `chat`      既有模型调用函数（`chatComplete`）；本机无模型时可用 `stub` 注入桩件
 *   · `stub`      `string`（当作模型回复）或 `function`（桩件，可抛/可挂起以测错误与超时路径）
 *   · `timeoutMs` 超时上限
 *   · `maxTexts`  最多采几条（默认 3；接入方留 1 个名额给离线语义核时传 2）
 * @returns {Promise<{called:boolean, ok:boolean, reason:string, texts:string[]}>}
 */
export async function collectLlmNicknameTexts(rawText, {
  enabled = false,
  chat = null,
  stub = null,
  timeoutMs = 3000,
  maxTexts = 3,
} = {}) {
  if (!enabled) return { called: false, ok: false, reason: 'disabled', texts: [] };
  const runOnce = async () => {
    if (typeof stub === 'function') return await stub({ rawText });
    if (typeof stub === 'string') return stub;
    if (typeof chat !== 'function') throw new Error('no_chat_fn');
    const { system, messages } = buildNicknameLlmMessages(rawText);
    const resp = await chat({ system, messages, temperature: 0.3, max_tokens: 120, timeout_ms: timeoutMs });
    return resp && typeof resp === 'object' && 'text' in resp ? resp.text : resp;
  };
  try {
    const raw = await withTimeout(runOnce(), timeoutMs);
    const texts = parseNicknameLlmReply(raw)
      .filter((t) => isLikelyNickname(t))
      .slice(0, Math.max(0, maxTexts));
    return { called: true, ok: true, reason: texts.length ? 'ok' : 'empty', texts };
  } catch (err) {
    const msg = String(err?.message ?? err);
    return { called: true, ok: false, reason: msg.includes('timeout') ? 'timeout' : 'error', texts: [] };
  }
}
