#!/usr/bin/env node
/**
 * build_clean_verbatim_bank.mjs —— v3（t55 修版）干净逐字题库出题器
 *
 * 相对 v1/v2 的修版（按两名非作者判读者的证据）：
 *   ① 白名单**硬排除非台词叶子**：`reason`（情境描述符）与 `name`（道具名）——这类字段不可能带角色风格；
 *   ② `title`（邮件标题）**单列一档**，不与台词混算；
 *   ③ 主卷**只用对白域**（chat + white）；邮件域（mail_body）另出**独立子卷**，便于分通道对照；
 *   ④ 额外产出**「遮掉自称」对照卷**（自称/专属物是角色标签，不是风格证据）；
 *   ⑤ 跨角色同串：给出**可复核的检测算法与实际组数**；组数为 0 则**不作为排除规则**（如实说明）。
 *
 * 用法：
 *   node scripts/build_clean_verbatim_bank.mjs            # 出题（写 %TEMP%：主卷/邮件子卷/遮自称卷/答案键/指纹）
 *   node scripts/build_clean_verbatim_bank.mjs --print    # 额外把主卷打到 stdout（交给判读者）
 *
 * 退出码：0 成功；2 语料缺失或解析失败。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_DIR = path.join(ROOT, 'data', 'dnf_corpus');
const SEED = 20261014;          // t55 修版新种子（与 20261013/20261012 区分）
const PER_ROLE = 40;            // 主卷每角色题量（地板 40）
const MAIL_PER_ROLE = 20;       // 邮件子卷每角色上限（不足如实报）

const FILES = { peach: 'peach_corpus.json', tuanzi: 'tuanzi_corpus.json', heika: 'heika_corpus.json' };
const SKIP_KEYS = new Set([
  'character', 'meta', 'gbk_bytes', 'byte_annotation', 'byte_index', 'fingerprint',
  'fingerprint_meta', 'self_describe', 'coverage', '_meta_exclusion_rule_note',
  'proactive_greetings_buckets', 'scene_media',
]);

// ① 非台词叶子（按**字段名**硬排除）：情境描述符 reason / 道具名 name
const NON_DIALOGUE_LEAF = /(^|\.)(reason|name)$/i;
// ② 邮件档只取**角色语料的真实台词叶子**：`{role}_corpus.json → mail_templates[].dialogue.<role>`
//    （扁平索引 `mail_templates.json` 的 reason/name/title 一律不得进邮件子卷——这是 t52 邮件档崩盘的结构原因）
const MAIL_DIALOGUE_PATH = /mail_templates\[[0-9]+\]\.dialogue\./i;

const cjk = (s) => (s.match(/[\u4e00-\u9fff]/g) || []).length;

function channelOf(p, leafKey) {
  const k = p.toLowerCase();
  if (k.includes('yellow')) return 'yellow';
  if (k.includes('presence') || k.includes('white')) return 'white';
  if (k.includes('letter') || k.includes('gallery')) return 'letter';
  if (k.includes('mail')) return /title/i.test(leafKey || '') ? 'mail_title' : 'mail_body';
  return 'chat';
}

function walk(node, p, out) {
  if (typeof node === 'string') { out.push({ text: node.trim(), path: p, leaf: p.split('.').pop() }); return out; }
  if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${p}[${i}]`, out)); return out; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (SKIP_KEYS.has(k)) continue;
      walk(v, p ? `${p}.${k}` : k, out);
    }
  }
  return out;
}

// ④ 自称 / 专属物（角色标签，非风格证据）
const SELF_PRONOUN = ['小桃子', '本小姐', '本姑娘', '本天才'];
const SELF_OBJECT = ['赫德尔'];
const SELF_ALL = [...SELF_PRONOUN, ...SELF_OBJECT];

const VARS = ['{player_nickname}', '{player_alias}', '{self_name}', '{self_thing}', '{token}', '{player_nicknames}'];
const ADDRESS = ['大英雄', '勇士大人', '冒险家', '亲爱的', '宝宝', '主人'];
const NAMES = ['软糖小桃子', '奶盖小团子', '黑咖小助手', '小团子', '黑咖'];

function maskBase(t) {
  let s = t;
  for (const v of VARS) s = s.split(v).join('〇');
  for (const w of ADDRESS) s = s.split(w).join('〇〇');
  for (const w of NAMES) s = s.split(w).join('〇〇');
  return s.trim();
}
function maskSelfToo(t) {
  let s = maskBase(t);
  for (const w of SELF_ALL) s = s.split(w).join('〇〇〇');
  return s.trim();
}
const hasSelf = (t) => SELF_ALL.some((w) => t.includes(w));

const eligibleText = (t, ch) => {
  if (typeof t !== 'string') return false;
  // 先把已知称呼变量归一为占位符，再判形态——否则带 {player_nickname} 的真台词会被误剔
  // （t55 实测：黑咖邮件正文大量使用变量，未归一前其 mail 池为 0）
  let s = t.trim();
  for (const v of VARS) s = s.split(v).join('〇');
  if (ch === 'mail_title') return cjk(s) >= 4 && !s.includes('_');
  if (cjk(s) < 6) return false;
  if (/[`\[\]{}]/.test(s)) return false;
  if (s.includes('→')) return false;
  if (/^[_a-z]+$/i.test(s)) return false;
  return true;
};

// ── 载入（并按字段名排除非台词叶子）─────────────────────────────────────────
const pools = {};           // role -> {dialogue:[], mail:[], title:[], excludedNonDialogue:n}
const rawByRole = {};
for (const [role, file] of Object.entries(FILES)) {
  const p = path.join(CORPUS_DIR, file);
  if (!fs.existsSync(p)) { console.error(`[FATAL] 语料缺失：${p}`); process.exit(2); }
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error(`[FATAL] 解析失败 ${p}: ${e.message}`); process.exit(2); }

  const leaves = walk(j, '', []).map((o) => ({ ...o, role, file, channel: channelOf(o.path, o.leaf) }));
  rawByRole[role] = leaves.map((o) => o.text);
  const nonDialogue = leaves.filter((o) => NON_DIALOGUE_LEAF.test(o.path));
  const ok = leaves.filter((o) => !NON_DIALOGUE_LEAF.test(o.path) && eligibleText(o.text, o.channel));

  const uniq = (arr) => { const m = new Map(); arr.forEach((o) => { if (!m.has(o.text)) m.set(o.text, o); }); return [...m.values()]; };
  pools[role] = {
    dialogue: uniq(ok.filter((o) => o.channel === 'chat' || o.channel === 'white')),
    mail: uniq(ok.filter((o) => o.channel === 'mail_body' && MAIL_DIALOGUE_PATH.test(o.path))),
    title: uniq(ok.filter((o) => o.channel === 'mail_title')),
    excludedNonDialogue: nonDialogue.length,
  };
}

// ⑤ 跨角色同串检测（两种算法，均可复核）
const norm = (s) => s.replace(/\s+/g, '');
function crossRoleGroups(kind) {
  const norm2 = kind === 'exact' ? (s) => s : norm;
  const byText = new Map();
  for (const role of Object.keys(FILES)) {
    for (const o of pools[role].dialogue) {
      const k = norm2(o.text);
      if (!byText.has(k)) byText.set(k, { text: o.text, roles: new Set(), paths: [] });
      const e = byText.get(k);
      e.roles.add(role);
      e.paths.push(`${role}:${o.path}`);
    }
  }
  return [...byText.values()].filter((e) => e.roles.size >= 2);
}
const crossExact = crossRoleGroups('exact');
const crossNorm = crossRoleGroups('norm');
const CROSS_ROLE_RULE_ACTIVE = crossExact.length > 0 || crossNorm.length > 0;

// ── 抽样（固定种子；主卷只用对白域）─────────────────────────────────────────
let s = SEED >>> 0;
const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
const shuffle = (a) => { const x = a.slice(); for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };

const dialoguePicked = [];
const mailPicked = [];
const perRoleAvailable = {};
for (const role of Object.keys(FILES)) {
  const d = shuffle(pools[role].dialogue);
  const m = shuffle(pools[role].mail);
  perRoleAvailable[role] = { dialogue: d.length, mail: m.length, title: pools[role].title.length, excludedNonDialogue: pools[role].excludedNonDialogue };
  dialoguePicked.push(...d.slice(0, PER_ROLE).map((o) => ({ ...o, role })));
  mailPicked.push(...m.slice(0, MAIL_PER_ROLE).map((o) => ({ ...o, role })));
}

const main = shuffle(dialoguePicked).map((o, i) => ({ q: i + 1, ...o, masked: maskBase(o.text), maskedNoSelf: maskSelfToo(o.text), hasSelf: hasSelf(o.text) }));
const mail = shuffle(mailPicked).map((o, i) => ({ q: i + 1, ...o, masked: maskBase(o.text), hasSelf: hasSelf(o.text) }));

// ── 产出（全部只写 %TEMP%）─────────────────────────────────────────────────
const T = os.tmpdir();
const paths = {
  mainBlind: path.join(T, 'bank_v3_blind_main.txt'),
  selfBlind: path.join(T, 'bank_v3_blind_noSelf.txt'),
  mailBlind: path.join(T, 'bank_v3_blind_mail.txt'),
  key: path.join(T, 'bank_v3_key.json'),
  fingerprint: path.join(T, 'bank_v3_corpus_fingerprint.json'),
  stats: path.join(T, 'bank_v3_stats.json'),
};
const head = (title, seed, n, per) => [
  `# ${title}`, `# 种子 ${seed}｜题量 ${n}｜每角色 ${per}`,
  '# 编号中性化 Qxxx；判读格式：按题号写 A=软糖小桃子 / B=奶盖小团子 / C=黑咖小助手，?=无法判定（计未命中）。',
  '# 顺序要求：先冻结判定（写文件并标时间）→ 再开答案键。', '',
];
fs.writeFileSync(paths.mainBlind, head('t55 干净逐字题库 v3 · 主卷（对白域 chat+white）', SEED, main.length, PER_ROLE).join('\n')
  + '\n' + main.map((o) => `Q${String(o.q).padStart(3, '0')} [${o.channel}] ${o.masked}`).join('\n') + '\n', 'utf8');
fs.writeFileSync(paths.selfBlind, head('t55 · 对照卷（**遮掉自称/专属物**）', SEED, main.length, PER_ROLE).join('\n')
  + '\n' + main.map((o) => `Q${String(o.q).padStart(3, '0')} [${o.channel}] ${o.maskedNoSelf}`).join('\n') + '\n', 'utf8');
fs.writeFileSync(paths.mailBlind, head(`t55 · 邮件子卷（mail_body，每角色 ≤${MAIL_PER_ROLE}）`, SEED, mail.length, MAIL_PER_ROLE).join('\n')
  + '\n' + mail.map((o) => `Q${String(o.q).padStart(3, '0')} [${o.channel}] ${o.masked}`).join('\n') + '\n', 'utf8');
fs.writeFileSync(paths.key, JSON.stringify({
  seed: SEED,
  main: main.map((o) => ({ q: o.q, role: o.role, file: o.file, path: o.path, channel: o.channel, hasSelf: o.hasSelf, text: o.text })),
  mail: mail.map((o) => ({ q: o.q, role: o.role, file: o.file, path: o.path, channel: o.channel, hasSelf: o.hasSelf, text: o.text })),
}, null, 1), 'utf8');

const fingerprints = {};
for (const [role, file] of Object.entries(FILES)) {
  const p = path.join(CORPUS_DIR, file);
  const buf = fs.readFileSync(p);
  fingerprints[role] = { file, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16), mtime: fs.statSync(p).mtime.toISOString() };
}
fs.writeFileSync(paths.fingerprint, JSON.stringify({ seed: SEED, generated_at: new Date().toISOString(), corpora: fingerprints }, null, 1), 'utf8');

// ── 标记—角色交叉表（供判读者避免过度泛化单一标点）──────────────────────
const MARKERS = { '~收尾': /~$/, '！收尾': /！$/, '。收尾': /。$/, '……收尾': /……$/, 'T_T收尾': /T_T$/ };
const markerTable = {};
for (const m of Object.keys(MARKERS)) markerTable[m] = { peach: 0, tuanzi: 0, heika: 0 };
for (const o of main) for (const [m, re] of Object.entries(MARKERS)) if (re.test(o.text)) markerTable[m][o.role]++;

// ── 统计输出 ────────────────────────────────────────────────────────────────
const byRoleMain = {}; const byRoleMail = {};
for (const o of main) byRoleMain[o.role] = (byRoleMain[o.role] || 0) + 1;
for (const o of mail) byRoleMail[o.role] = (byRoleMail[o.role] || 0) + 1;
const selfCount = main.filter((o) => o.hasSelf).length;
const selfStrict = main.filter((o) => SELF_PRONOUN.some((w) => o.text.includes(w))).length;
const stats = {
  seed: SEED, generated_at: new Date().toISOString(),
  per_role_available: perRoleAvailable,
  main: { total: main.length, by_role: byRoleMain, by_channel: main.reduce((a, o) => (a[o.channel] = (a[o.channel] || 0) + 1, a), {}) },
  mail: { total: mail.length, by_role: byRoleMail },
  self_designation: { extended_self_or_object: selfCount, strict_pronoun_only: selfStrict, rule: 'extended=自称(小桃子/本小姐/本姑娘/本天才)+专属物(赫德尔)', ratio: `${selfCount}/${main.length}` },
  cross_role_same_string: { exact_groups: crossExact.length, normalized_groups: crossNorm.length, rule_active: CROSS_ROLE_RULE_ACTIVE, examples_exact: crossExact.slice(0, 5).map((e) => [...e.roles].join('+') + ' :: ' + e.text) },
  marker_cross_table: markerTable,
  non_dialogue_excluded: Object.fromEntries(Object.entries(perRoleAvailable).map(([r, v]) => [r, v.excludedNonDialogue])),
};
fs.writeFileSync(paths.stats, JSON.stringify(stats, null, 1), 'utf8');

console.log(`种子=${SEED}`);
console.log(`主卷（对白域）题量=${main.length}｜各角色=${JSON.stringify(byRoleMain)}｜通道=${JSON.stringify(stats.main.by_channel)}`);
console.log(`邮件子卷题量=${mail.length}｜各角色=${JSON.stringify(byRoleMail)}`);
console.log(`每角色可用叶子（对白/邮件/标题/被排除的非台词）= ${JSON.stringify(perRoleAvailable)}`);
console.log(`跨角色同串：精确 ${crossExact.length} 组｜去空白归一 ${crossNorm.length} 组｜是否启用该排除规则：${CROSS_ROLE_RULE_ACTIVE}`);
console.log(`遮自称：extended ${selfCount}/${main.length}｜strict ${selfStrict}/${main.length}`);
console.log(`标记—角色交叉表：${JSON.stringify(markerTable)}`);
console.log(`产物：${Object.values(paths).join(' | ')}`);
if (process.argv.includes('--print')) { console.log('\n--- 主卷 ---'); main.forEach((o) => console.log(`Q${String(o.q).padStart(3, '0')} [${o.channel}] ${o.masked}`)); }
