/**
 * 称呼落库门禁 G-N1（t119 · C-3）
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 为什么这个模块必须存在（blocker 级前置）
 *
 * 既有耦合 `companionUserAlias`（db.mjs）会把**落库的称呼**当作"用户"的改写别名：
 *   companion_shaping(kind='nickname').content → replaceUserWording(..., alias)
 * 于是**全库记忆文本**里的"用户"都会被替换成这个称呼。若称呼未经校验就落库，
 * **一次称呼采集即可污染全库记忆文本**（设计 §2.6 第一行）。
 *
 * ⇒ 因此落库前必须过本门禁，且**校验必须先于 upsertShaping**（G-N1 的顺序要求）。
 *    本模块是**纯函数**（不碰 db、不读环境），可独立单测。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 两个窗口，不是同一个门禁（设计 §2.3 S8 / 纪律 1）
 *
 *   采集窗口 = 1~8 汉字   —— 用来"听懂玩家说的"（对话层）
 *   落库上限 = 6 汉字 / 12 GBK 字节 —— 用来"守住列与 alias 污染风险"（落库层）
 *
 * 7~8 字 ⇒ 走"太长 + 给候选"话术（`over_window`，**不落库、但也不是硬拒**）；
 * ≥9 字或含非法字符 ⇒ 硬拒。
 * **本轮按用户已确认的 ≤6 落地，不动列定义。**
 */

/** 落库上限：≤6 汉字。 */
export const NICKNAME_MAX_CHARS = 6;
/** 落库上限：≤12 GBK 字节（对称列约束；与 Go 侧 SanitizeLoverReply 同口径）。 */
export const NICKNAME_MAX_GBK_BYTES = 12;
/** 采集窗口上界（用于区分"太长"与"硬拒"）。 */
export const NICKNAME_COLLECT_MAX_CHARS = 8;

/**
 * 来源凭证标记：**只有本模块的 `extractNicknameCandidate` 会写出它**。
 * `validateNicknameCandidate` 用它来机械判定"这个候选到底是不是规则抽取的 accepted 结果"——
 * 这是 G-N1「只能来自规则抽取」那条断言的落地方式（而不是靠约定/注释）。
 */
export const NICKNAME_EXTRACT_VIA = 'nickname_rule_extract_v1';

/** 归一化（与既有 `norm()` 同口径：全角→半角、压空白、只取首行）。 */
export function normNicknameInput(raw) {
  let s = String(raw ?? '');
  // 全角 → 半角（含全角空格 U+3000）
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  s = s.replace(/\u3000/g, ' ');
  s = s.split(/\r?\n/)[0];            // 只取第一行
  return s.trim();
}

/** GBK 字节长度：ASCII 1B，其余 2B（与 Go 侧同口径）。 */
export function gbkByteLength(text) {
  let n = 0;
  for (const ch of String(text ?? '')) n += ch.codePointAt(0) <= 0x7f ? 1 : 2;
  return n;
}

const REFUSE_FAMILY = ['随便你', '你随便', '不用了', '不想说', '别问了', '无所谓'];

/** 意图锚定三族正则（按优先级 R1 → R2）。 */
const ANCHOR_R1 = /以后(?:叫我|喊我|叫我做)(.{1,12})$/;
const ANCHOR_R2 = /(?:叫我|喊我|叫做|叫)(.{1,12})$/;
/** 疑问/否定标记（R3 纯答句要求"不含"它们）。 */
const R3_BLOCKERS = /[?？!！]|不|没|别|吗|呢|多少|什么|怎么|哪个|谁/;
/**
 * 候选**核心**的疑问标记（用于锚定结果复核）。
 *
 * ⚠️ 这里**刻意不包含**语气助词（呢/吧/啊/吗/啦），因为后缀清洗会把它们剥掉；
 * 若把 `喂` 这类也写进来，`叫我喂` 这种合法称呼会被误杀。只留"明确的疑问词"。
 * 为什么必须有这条：`你觉得我该叫什么好呢` 会被 R2 锚成 `什么好`（3 字、过窗、无禁用词），
 * 只有再对候选核心查一次疑问词，才能把它判成 unparsed（S7「不猜」）。
 */
const CANDIDATE_QUESTION_CORE = /什么|怎么|哪个|哪些|多少|谁|哪一|是不是|可以吗|好不好/;

const WRAPPER_PAIRS = [
  ['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’'],
  ['（', '）'], ['(', ')'], ['【', '】'], ['[', ']'], ['《', '》'],
];

const PREFIXES = ['叫个', '以后', '那个', '就', '请', '你', '我', '叫', '喊', '是'];
const SUFFIXES = ['吧', '啊', '呀', '哦', '嘛', '啦', '了', '的', '哈', '哟', '喂', '呗', '呢'];

/**
 * 禁用清单（设计 §2.3 S6 + §2.7 继承项）。
 *
 * ⚠️ 这里只落"**可直接机械判定**"的那部分（系统词 / `%s` / URL / 邮箱 / 客服腔 /
 * 纯数字 / 标点空白残留）。§2.7 的**完整禁用表**以设计稿为准（含定调 §3.5 继承项），
 * 本模块不复制它的全文，避免两处漂移——只保留与"落库安全"直接相关的最小集。
 */
const FORBIDDEN_PATTERNS = [
  { code: 'system_word', re: /(?:输入|密码|客服|官方|GM)/i },
  { code: 'percent_s', re: /%s/ },
  { code: 'url_email', re: /(?:https?:\/\/|www\.|@\w+\.\w+)/i },
  { code: 'service_tone', re: /^(?:亲|您好|阁下)/ },
  { code: 'pure_digits', re: /^\d+$/ },
  { code: 'punctuation_or_space', re: /[\s\p{P}\p{S}]/u },
];

/** 剥成对包裹（可叠层，循环至长度不变）。 */
function stripWrappers(s) {
  let out = String(s ?? '');
  let changed = true;
  while (changed) {
    changed = false;
    for (const [open, close] of WRAPPER_PAIRS) {
      if (out.length >= 2 && out.startsWith(open) && out.endsWith(close)) {
        out = out.slice(open.length, out.length - close.length).trim();
        changed = true;
      }
    }
  }
  return out;
}

/** 去语气与敬语（前缀按最长匹配循环剥除至长度不变；后缀同理）。 */
function stripToneAndHonorific(s) {
  let out = String(s ?? '').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of [...PREFIXES].sort((a, b) => b.length - a.length)) {
      if (out.startsWith(p) && out.length > p.length) {
        out = out.slice(p.length).trim();
        changed = true;
      }
    }
    for (const suf of SUFFIXES) {
      if (out.endsWith(suf) && out.length > suf.length) {
        out = out.slice(0, out.length - suf.length).trim();
        changed = true;
      }
    }
  }
  return out;
}

/** 对单个候选做禁用清单检查，返回命中的 code（未命中返回 null）。 */
export function forbiddenReasonOf(candidate) {
  const s = String(candidate ?? '');
  if (s === '') return 'empty';
  for (const { code, re } of FORBIDDEN_PATTERNS) {
    if (re.test(s)) return code;
  }
  return null;
}

/**
 * 把一段"候选文本"洗干净：成对包裹与语气/敬语**必须放在同一个收敛循环里**。
 *
 * ⚠️ 为什么不能"先剥包裹、再去语气"分两步（t119 实测踩到）：`「阿飞」吧` 的收尾是
 * 语气词 `吧`，此时首尾不是一对包裹（`「` 对 `吧`）⇒ 包裹剥不掉；而先剥语气又要求
 * 首尾形态已知。两者交替依赖，故必须循环到长度不变（与设计 §2.3 S4 的
 * "循环剥除至长度不变"同口径）。
 */
function cleanCandidate(s) {
  let out = String(s ?? '').trim();
  for (let i = 0; i < 12; i++) {
    const before = out;
    out = stripWrappers(out);
    out = stripToneAndHonorific(out);
    if (out === before) break;
  }
  return out;
}

/** 是否仍残留结构性标记（用于 R3 纯答句判定：答句里不该再出现这些）。 */
const STRUCTURAL_RESIDUE = /(?:叫|喊|以后|请|那个|你|我|是|吧|啊|呀|哦|嘛|啦|了|的|哈|哟|喂|呗|呢)/;

/**
 * 规则抽取链（设计 §2.3 S0~S8 的**纯本地**实现；**LLM 不参与**）。
 *
 * 返回三态之一（形状固定，供下游机械判断）：
 *   · `{kind:'rejected_named', candidates:[]}`  —— 玩家明确拒答（S1）
 *   · `{kind:'unparsed', candidates:[]}`       —— 抽不出 / 有歧义（S7，**不猜**）
 *   · `{kind:'accepted', candidates:[...]}`    —— 抽到候选（**仍需过 validate 才能落库**）
 *
 * 每个候选都带 `via: NICKNAME_EXTRACT_VIA`（来源凭证）与 `source: 'rule_extract'`。
 *
 * ⚠️ 两处易写错的地方（t119 实测各踩一次，已修）：
 *   1. **语气/包裹清洗只能作用在"抽出的候选"上，不能作用在整句上**：先对整句去前缀会把
 *      `以后叫我「阿飞」吧` 削成 `阿飞」吧`（前缀被剥掉但包裹与后缀还在），随后包裹永远
 *      剥不掉 ⇒ 合法称呼被判 unparsed。正确顺序：**锚定（整句）→ 清洗（候选）→ 长度窗（清洗后）**。
 *   2. **锚定到长内容后不许再落进 R3**：`你觉得我该叫什么好呢` 会锚出 `什么好`（3 字、
 *      过窗口、无禁用词）⇒ 若此时还去试 R3，就会把疑问句里的片段当称呼抽走。
 *      故 **一旦锚定成功（无论过没过窗）即不再走 R3**。
 */
export function extractNicknameCandidate(rawText) {
  const s0 = normNicknameInput(rawText);
  if (s0 === '') return { kind: 'unparsed', candidates: [], reason: 'empty_input' };

  // S1 拒答识别（短路）
  if (REFUSE_FAMILY.some((w) => s0.includes(w))) {
    return { kind: 'rejected_named', candidates: [], reason: 'refuse_family' };
  }

  // S2 意图锚定（R1 → R2）——在**整句**上做，包裹与语气交给候选级清洗
  const r1 = ANCHOR_R1.exec(s0);
  const r2 = r1 ? null : ANCHOR_R2.exec(s0);
  const anchored = r1 ? r1[1] : (r2 ? r2[1] : null);

  if (anchored !== null) {
    // S3 去包裹 → S4 去语气与敬语（**均只作用于候选**）→ S5 长度窗（清洗后）
    const cleaned = cleanCandidate(anchored);
    const chars = [...cleaned].length;
    if (chars >= 1 && chars <= NICKNAME_COLLECT_MAX_CHARS) {
      // S7 反向对照：锚出来的如果是**疑问词碎片**（`你觉得我该叫什么好呢` → `什么好`）
      // ⇒ 判 unparsed（不猜），绝不能把疑问句里的片段当称呼抽走。
      if (CANDIDATE_QUESTION_CORE.test(cleaned)) {
        return { kind: 'unparsed', candidates: [], reason: 'question_fragment' };
      }
      const bad = forbiddenReasonOf(cleaned);
      if (bad) return { kind: 'unparsed', candidates: [], reason: 'forbidden_' + bad };
      return {
        kind: 'accepted',
        candidates: [{ text: cleaned, via: NICKNAME_EXTRACT_VIA, source: 'rule_extract' }],
      };
    }
    // 锚定成功但清洗后超窗 ⇒ **就此 unparsed**（不再落 R3，见上方第 2 条）
    return { kind: 'unparsed', candidates: [], reason: 'outside_collect_window' };
  }

  // S2-R3 纯答句：整句洗净后 ≤ 采集窗、无疑问/否定、且**无结构残留** ⇒ 视为直接给名
  const asAnswer = cleanCandidate(s0);
  const answerChars = [...asAnswer].length;
  if (answerChars >= 1 && answerChars <= NICKNAME_COLLECT_MAX_CHARS
      && !R3_BLOCKERS.test(asAnswer) && !STRUCTURAL_RESIDUE.test(asAnswer)) {
    const bad = forbiddenReasonOf(asAnswer);
    if (bad) return { kind: 'unparsed', candidates: [], reason: 'forbidden_' + bad };
    return {
      kind: 'accepted',
      candidates: [{ text: asAnswer, via: NICKNAME_EXTRACT_VIA, source: 'rule_extract' }],
    };
  }

  return { kind: 'unparsed', candidates: [], reason: 'no_anchor' };
}

/**
 * **G-N1 门禁**：判断一个候选能否落库。纯函数、无副作用。
 *
 * 返回 `{ ok:true, text }` 或 `{ ok:false, code, detail }`。
 *
 * 拒绝码（稳定，供门禁与日志机械断言）：
 *   · `missing_content`    —— 空/缺内容
 *   · `not_rule_extracted` —— **不是规则抽取的 accepted 结果**（G-N1 第 1 条）
 *   · `forbidden_<reason>` —— 命中禁用清单
 *   · `chars_exceeded`     —— > 6 汉字（落库上限）
 *   · `bytes_exceeded`     —— > 12 GBK 字节（落库上限）
 *   · `over_window`        —— 7~8 字（采集窗口内、落库上限外）⇒ 走"太长 + 给候选"，不是硬拒
 */
export function validateNicknameCandidate(candidate) {
  if (candidate === null || candidate === undefined) {
    return { ok: false, code: 'missing_content', detail: 'candidate is null/undefined' };
  }
  // 来源凭证：**必须**是规则抽取产出的对象形态，而不是裸字符串。
  if (typeof candidate !== 'object' || candidate.via !== NICKNAME_EXTRACT_VIA) {
    return {
      ok: false,
      code: 'not_rule_extracted',
      detail: 'only a candidate produced by extractNicknameCandidate may be persisted',
    };
  }
  const text = String(candidate.text ?? '').trim();
  if (text === '') return { ok: false, code: 'missing_content', detail: 'empty text' };

  const bad = forbiddenReasonOf(text);
  if (bad) return { ok: false, code: 'forbidden_' + bad, detail: `forbidden content: ${bad}` };

  const chars = [...text].length;
  const bytes = gbkByteLength(text);
  if (chars > NICKNAME_MAX_CHARS) {
    const code = chars <= NICKNAME_COLLECT_MAX_CHARS ? 'over_window' : 'chars_exceeded';
    return { ok: false, code, detail: `${chars} 汉字 > 落库上限 ${NICKNAME_MAX_CHARS}` };
  }
  if (bytes > NICKNAME_MAX_GBK_BYTES) {
    return { ok: false, code: 'bytes_exceeded', detail: `${bytes}B > 落库上限 ${NICKNAME_MAX_GBK_BYTES}B` };
  }
  return { ok: true, text, chars, bytes };
}

/** 一步到位：从原始文本抽出候选并过门禁（供交互层调用，避免两步写错顺序）。 */
export function extractAndValidateNickname(rawText) {
  const extracted = extractNicknameCandidate(rawText);
  if (extracted.kind !== 'accepted' || extracted.candidates.length === 0) {
    return { ok: false, code: extracted.kind === 'rejected_named' ? 'rejected_named' : 'unparsed', detail: extracted.reason };
  }
  return validateNicknameCandidate(extracted.candidates[0]);
}
