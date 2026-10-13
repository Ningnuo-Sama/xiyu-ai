/**
 * scripts/lover_nickname_demo.mjs —— 「离线称呼对话剧本」演示（手动跑，不进 CI，不碰生产）
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 它做什么
 *
 * 用**真实 HTTP + 隔离临时库 + 临时语料副本**跑一遍称呼采集的完整对话剧本，
 * 把「三人（桃子/团子/黑咖）在同一情境下各自会说什么」逐字打印出来，
 * 让**不进游戏**也能验收**内容与逻辑**。
 *
 * 剧本六段（按时间顺序）：
 *   ① 新角色首次见面 → 她问称呼
 *   ② 玩家答正常名字（小明）→ 抽取 accepted → 确认台词（注入 {player_nickname}）
 *      → /set 落库 → /state 读回（证明真的记住了）
 *   ③ 玩家答非所问（随便你叫吧）→ rejected_named → 换说法再问 → 到顶后的收尾
 *   ④ 名字太长 → over_window / offer_candidates → 打印候选（source: derived|pool）+ 太长台词
 *   ⑤ 改称呼 → 再 /set 改成另一个名字 → 打完 昵称变更 台词
 *   ⑥ 第二个角色首次上线 → 小号话术（**仅为台词预览**，触发与投递属 Go 侧）
 *   第①~⑤段三人各打一遍；第⑥段同样三人各一遍。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 硬约束（本脚本自己守的线，改动前先读）
 *
 *   · **绝不触碰生产库** `data/bot.db`：`DB_PATH` 在 `import '../src/db.mjs'` **之前**
 *     指向临时目录里的新库（db.mjs 在 import 期算 `DB_PATH` 常量，晚设无效）。
 *   · **不启动常驻服务、不启动游戏**：进程内 express + `listen(0)` 随机端口，
 *     收尾 `server.close()`；临时目录整个删掉。
 *   · **不改生产语料**：`CORPUS_DIR` 指向临时目录，只把要用的 3 个语料文件**复制**过去再读。
 *   · **台词逐字取自语料**：不手写、不改写、不润色；每句都标来源键名。
 *   · **合规判定只走门禁本体两步**（`extractNicknameCandidate` → `validateNicknameCandidate`），
 *     绝不把裸字符串直接丢给 `validateNicknameCandidate`（那只会得到 `not_rule_extracted`，
 *     是"调用方式错"而不是"内容不合规"）。
 *
 * 用法（在 `D:\GitHub\xiyu-ai` 下）：
 *   node scripts/lover_nickname_demo.mjs
 */

import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// ── 0. 隔离环境：一切路径在 import src/* 之前就位 ────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const PROD_DB = path.resolve(REPO_ROOT, 'data', 'bot.db');
const PROD_CORPUS_DIR = path.resolve(REPO_ROOT, 'data', 'dnf_corpus');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xiyu_nickname_demo_'));
const TMP_DB = path.join(TMP_ROOT, 'nickname_demo.db');
const TMP_CORPUS = path.join(TMP_ROOT, 'dnf_corpus');
fs.mkdirSync(TMP_CORPUS, { recursive: true });

// 只复制本演示真正要读的语料文件（**复制**，绝不共享、绝不写回）
const CORPUS_FILES = ['peach_corpus.json', 'tuanzi_corpus.json', 'heika_corpus.json'];
for (const f of CORPUS_FILES) fs.copyFileSync(path.join(PROD_CORPUS_DIR, f), path.join(TMP_CORPUS, f));

process.env.DB_PATH = TMP_DB;              // ⚠️ 必须在 import db.mjs 之前
process.env.CORPUS_DIR = TMP_CORPUS;       // ⚠️ 必须在 import game_dnf.mjs 之前

// 免责：生产库路径只用于"打印证据"，永不 open
if (TMP_DB === PROD_DB) {
  console.error('拒绝运行：临时库路径与生产库相同。');
  process.exit(1);
}

const { gameRouter } = await import('../src/game_dnf.mjs');
const { getDb } = await import('../src/db.mjs');
const {
  extractNicknameCandidate,
  validateNicknameCandidate,
  NICKNAME_MAX_CHARS,
  NICKNAME_MAX_GBK_BYTES,
  NICKNAME_COLLECT_MAX_CHARS,
} = await import('../src/nickname_gate.mjs');

// ── 1. 输出小工具 ───────────────────────────────────────────────────────────
function hr(ch = '─', n = 78) { return ch.repeat(n); }
function title(text) { console.log('\n' + hr('═') + '\n' + text + '\n' + hr('═')); }
function sub(text) { console.log('\n' + hr('─') + '\n' + text); }
function kv(label, value) { console.log(`  ${label}：${value}`); }

// ── 2. 如实边界（首尾各打印一次） ───────────────────────────────────────────
const BOUNDARY = [
  '【如实边界 · 请在读剧本前先读这段】',
  '本演示只覆盖：**称呼采集的规则逻辑** 与 **台词文案**（逐字取自语料，未改写）。',
  '本演示不覆盖：',
  '  · 实机观感（游戏内聊天框排版/字号/换行/频道串场后的读感）；',
  '  · 真实游戏链路（ACT12 服务端 ↔ Go 守护进程 ↔ 本大脑的真实往返）；',
  '  · 真实延迟与限流（单机 HTTP 到本机 loopback，无网络/无排队）；',
  '  · Go 侧的投递、仲裁与账本写入（令牌桶、冷却计时、失败计数、账号事件账本）；',
  '  · LLM 参与（本链路口径就是纯规则，全程 model_called=false）。',
  '**最终验收仍以客户端亲测为准。**',
];
function printBoundary(where) {
  console.log('\n' + hr('·') + `\n[边界 ${where}]\n` + BOUNDARY.join('\n') + '\n' + hr('·'));
}

// ── 3. 语料读取（逐字直取，绝不拼写） ──────────────────────────────────────
const corpusCache = new Map();
function loadCorpus(fileName) {
  if (!corpusCache.has(fileName)) {
    corpusCache.set(fileName, JSON.parse(fs.readFileSync(path.join(TMP_CORPUS, fileName), 'utf-8')));
  }
  return corpusCache.get(fileName);
}
function getAt(node, dotted) {
  let cur = node;
  for (const seg of String(dotted).split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

// 角色 → 语料文件 / 台词键（⚠️ 三人键名**刻意不同**，这是语料现状，不是笔误：
//   团子用 nickname_ask / nickname_accept，桃子和黑咖用 ask_name / nickname_confirm）
const ROLES = [
  {
    id: 'peach', name: '软糖小桃子', short: '桃子', file: 'peach_corpus.json',
    keys: {
      greeting: 'naming.first_meet_elvenguard',
      ask: 'naming.ask_name',
      confirm: 'naming.nickname_confirm',
      tooLong: 'naming.nickname_too_long',
      change: 'naming.nickname_change',
      altFirstLogin: 'naming.alt_first_login',
      pool: 'naming.nickname_candidate_pool',
    },
  },
  {
    id: 'tuanzi', name: '奶盖小团子', short: '团子', file: 'tuanzi_corpus.json',
    keys: {
      greeting: 'naming.first_meet_elvenguard',
      ask: 'naming.nickname_ask',
      confirm: 'naming.nickname_accept',
      tooLong: 'naming.nickname_too_long',
      change: 'naming.nickname_change',
      altFirstLogin: 'naming.alt_first_login',
      pool: 'naming.nickname_candidate_pool',
    },
  },
  {
    id: 'heika', name: '黑咖小助手', short: '黑咖', file: 'heika_corpus.json',
    keys: {
      greeting: 'naming.first_meet_elvenguard',
      ask: 'naming.ask_name',
      confirm: 'naming.nickname_confirm',
      tooLong: 'naming.nickname_too_long',
      change: 'naming.nickname_change',
      altFirstLogin: 'naming.alt_first_login',
      pool: 'naming.nickname_candidate_pool',
    },
  },
];

/** 取一条台词（逐字），并回报来源键名与条目总数。取不到 ⇒ 如实报错，不兜底编造。 */
function line(role, keyName) {
  const dotted = role.keys[keyName];
  const arr = getAt(loadCorpus(role.file), dotted);
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error(`语料缺失：${role.file} 的 ${dotted}（角色 ${role.short} / 槽位 ${keyName}）`);
  }
  return { text: arr[0], count: arr.length, source: `${dotted}[0]` };
}

/** 占位符注入：与 src/game_dnf.mjs 的 injectCallNames 同口径（单/双花括号都吃）。 */
function fill(text, { nickname = null, alias = null } = {}) {
  return String(text).replace(/\{\{?\s*(player_nickname|player_alias)\s*\}?\}/gi, (_m, key) => {
    if (key.toLowerCase() === 'player_nickname') return nickname == null ? '你' : String(nickname);
    return alias == null ? (nickname == null ? '你' : String(nickname)) : String(alias);
  });
}

function pickNth(arr, n) { return { text: arr[n % arr.length], index: n % arr.length, count: arr.length }; }

// ── 4. 剧本运行的机械上下文 ─────────────────────────────────────────────────
const stats = {
  rotations: 0,
  gatePass: 0,          // 门禁通过（validate ok:true）
  gateReject: 0,        // 门禁拒绝（validate ok:false，带 code）
  extractReject: 0,     // 抽取阶段即未 accepted（根本没到门禁）
  gateRejectCodes: new Map(),
  extractRejectKinds: new Map(),
  suggestDerived: 0,
  suggestPool: 0,
};
function bump(map, key) { map.set(key, (map.get(key) || 0) + 1); }

/** 门禁两步入口的唯一调用点：extract（不接受裸串直调 validate）。 */
function gateTwoStep(raw) {
  const extracted = extractNicknameCandidate(raw);
  const cand = extracted.kind === 'accepted' ? extracted.candidates[0] : null;
  const gate = cand ? validateNicknameCandidate(cand) : null;
  if (!cand) {
    stats.extractReject += 1;
    bump(stats.extractRejectKinds, extracted.kind);
  } else if (gate.ok) {
    stats.gatePass += 1;
  } else {
    stats.gateReject += 1;
    bump(stats.gateRejectCodes, gate.code);
  }
  return { extracted, cand, gate };
}

// ── 5. 数据库播种（临时库） ─────────────────────────────────────────────────
const db = getDb();
const DEFAULT_CALL_USER_AS = { '软糖小桃子': '哎——', '奶盖小团子': '喂', '黑咖小助手': '同学' };

function seed() {
  db.prepare(`INSERT OR IGNORE INTO users (id, wechat_user_id, display_name, plan)
              VALUES (1, 'dnf-player-demo', '演示玩家', 'pro')`).run();

  db.prepare(`INSERT OR IGNORE INTO users (id, wechat_user_id, display_name, plan)
              VALUES (7, 'dnf-player-demo-alt', '演示玩家（小号账号）', 'pro')`).run();

  for (const role of ROLES) {
    const row = db.prepare('SELECT id FROM companions WHERE name = ?').get(role.name);
    if (row) { role.dbId = row.id; continue; }
    const info = db.prepare(
      `INSERT INTO companions (user_id, bot_id, name, age, relationship_stage, affection_level,
                               call_user_as, nickname_level, temperature, max_tokens)
       VALUES (1, ?, ?, 20, '恋人', 55, ?, 0, 0.7, 80)`
    ).run(`dnf-demo-${role.id}`, role.name, DEFAULT_CALL_USER_AS[role.name] ?? '你');
    role.dbId = Number(info.lastInsertRowid);
  }
  console.log(`[隔离库] ${TMP_DB}`);
  console.log(`[隔离语料] ${TMP_CORPUS}`);
  console.log(`[生产库（本次只读路径常量、从不 open）] ${PROD_DB}`);
  for (const r of ROLES) console.log(`[角色播种] ${r.short} / ${r.name} → companions.id=${r.dbId}`);
}

// ── 6. 进程内临时服务（listen(0) 随机端口，收尾必关） ───────────────────────
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use('/', gameRouter);
app.use((_req, res) => res.status(404).json({ ok: false, error: 'not found' }));

const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;
// 只读诊断：确认三个称呼端点在本进程内可路由（不依赖常驻服务/端口配置）
console.log(`[进程内 HTTP] ${BASE}（express + gameRouter，无 x-game-token 中间件；挂载方式与 index.mjs 第 40 行一致）`);

async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json; charset=utf-8' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json;
  try { json = JSON.parse(await res.text()); } catch { json = null; }
  return { status: res.status, json };
}

// ── 7. 剧本 ─────────────────────────────────────────────────────────────────
const rolesState = new Map();
function st(role) {
  if (!rolesState.has(role.id)) rolesState.set(role.id, { reprompt: 0 });
  return rolesState.get(role.id);
}
function resetRotationState() { for (const s of rolesState.values()) s.reprompt = 0; }

function printScript(role, who, text, note) {
  console.log(`    ${role.short}（${role.name}）：${text}`);
  if (note) console.log(`      ↳ ${note}`);
}

function printMechanics(label, obj) {
  console.log(`    [机械] ${label}：` + JSON.stringify(obj));
}

const MAIN_KEYS = ['小明', '阿飞', '星野'];
const OVER_LONG_NAME = '超级无敌大魔王';                 // 7 字：采集窗内(≤8)、落库上限外(>6)
const OVER_LONG_VIA_ANCHOR = `你可以叫我${OVER_LONG_NAME}`;
const TOO_LONG_UNCLEAN = '一个特别特别长的名字';        // 10 字（任务书原文示例）
const REFUSE_TEXT = '随便你叫吧';
const USER_ID = 7;

async function runRotation(role, idx) {
  stats.rotations += 1;
  const newName = MAIN_KEYS[idx % MAIN_KEYS.length];
  const prevName = MAIN_KEYS[(idx + MAIN_KEYS.length - 1) % MAIN_KEYS.length];

  sub(`第 ${idx + 1}/3 遍 · ${role.short}（${role.name}）`);

  // ── ① 新角色首次见面 → 她问称呼 ──────────────────────────────────────────
  console.log('  ① 新角色首次见面 → 她问称呼');
  {
    const g = line(role, 'greeting');
    const a = line(role, 'ask');
    printScript(role, '她', g.text, `来源 ${g.source}（该键共 ${g.count} 条，本演示固定取第 1 条）`);
    printScript(role, '她', a.text, `来源 ${a.source}（该键共 ${a.count} 条）`);
    console.log('      ※ 段①为台词预览：首见打招呼的触发/投递属 Go 侧，离线未跑真实链路。');
  }

  // ── ② 玩家答正常名字 → 抽取 → 确认 → /set → /state 读回 ──────────────────
  console.log(`  ② 玩家答正常名字：「${newName}」`);
  {
    const r = await call('POST', '/game/nickname/extract', { text: newName, npc: role.name });
    const body = r.json;
    const c0 = body?.candidate || null;
    const gate = gateTwoStep(newName);      // 同一输入的脚本体两步判定（计数用）
    printMechanics('POST /game/nickname/extract', {
      http: r.status, kind: body.kind, reason: body.reason, action: body.action,
      will_persist: body.will_persist, gate: c0?.gate ?? null, model_called: body.model_called,
    });
    console.log(`      ↳ 脚本体同输入两步判定：extract.kind=${gate.extracted.kind}`
      + `，validate.ok=${gate.gate ? gate.gate.ok : 'n/a（未 accepted，未送门禁）'}`);

    const conf = line(role, 'confirm');
    const filled = fill(conf.text, { nickname: newName });
    printScript(role, '她', filled,
      `来源 ${conf.source}（共 ${conf.count} 条）；{player_nickname} → 「${newName}」已按线上注入器同口径替换`);

    if (body.will_persist && c0) {
      const setRes = await call('POST', '/game/nickname/set', {
        npc: role.name, candidate: { text: c0.text, via: c0.via }, raw_msg: newName, user_id: USER_ID,
      });
      printMechanics('POST /game/nickname/set', { http: setRes.status, ok: setRes.json?.ok, text: setRes.json?.text, code: setRes.json?.code ?? null });

      const stateRes = await call('GET', `/game/nickname/state?npc=${encodeURIComponent(role.name)}&user_id=${USER_ID}`);
      const ns = stateRes.json?.nickname_state;
      printMechanics('GET /game/nickname/state', {
        http: stateRes.status, nickname: ns?.nickname, source: ns?.source,
        updated_at: ns?.updated_at, asked: ns?.asked, mirrored: ns?.mirrored, model_called: stateRes.json?.model_called,
      });
      console.log(ns?.nickname === newName
        ? `      ✅ 读回一致：库里现在真的是「${ns.nickname}」（她记住了）`
        : `      ❌ 读回不一致：期望「${newName}」，实际「${ns?.nickname}」`);
    } else {
      console.log('      ⚠️ 抽取未产出可落库候选 ⇒ 跳过 /set 与 /state（不伪造"记住了"）。');
    }
  }

  // ── ③ 玩家答非所问 → 换说法再问 → 到顶后不再问 ───────────────────────────
  console.log(`  ③ 玩家答非所问：「${REFUSE_TEXT}」`);
  {
    const first = await call('POST', '/game/nickname/extract', { text: REFUSE_TEXT, npc: role.name });
    const g = gateTwoStep(REFUSE_TEXT);
    printMechanics('POST /game/nickname/extract', {
      http: first.status, kind: first.json?.kind, reason: first.json?.reason,
      action: first.json?.action, will_persist: first.json?.will_persist, model_called: first.json?.model_called,
    });
    console.log(`      ↳ 脚本体同输入两步判定：extract.kind=${g.extracted.kind}（reason=${g.extracted.reason}）`
      + `，未产出候选 ⇒ 未送 validate（不是"内容不合规"，是"抽取判她拒答"）`);

    const askArr = getAt(loadCorpus(role.file), role.keys.ask);
    if (!Array.isArray(askArr) || askArr.length === 0) throw new Error(`语料缺失：${role.file} 的 ${role.keys.ask}`);
    const s = st(role);
    for (let k = 0; k < 3; k++) {
      const pick = pickNth(askArr, s.reprompt);
      s.reprompt += 1;
      printScript(role, '她', fill(pick.text, { nickname: newName }),
        `来源 ${role.keys.ask}[${pick.index}]（共 ${pick.count} 条；本演示按轮换取，不改写文案；`
        + `句中 {player_nickname} 按线上注入器同口径替换为「${newName}」）`);
    }
    console.log('      ※ 标注：「连续 3 次"到顶后不再问"」的计数与收尾判定属 **Go 侧状态机**；');
    console.log('         /game/nickname/* 三端点**不负责**这个计数（只回答"这一句抽出了什么"）。');
    console.log('         此处仅演示文案轮换（同一键取不同条目），不代表真实失败计数已推进。');
  }

  // ── ④ 名字太长 → over_window / offer_candidates → 候选 + 太长台词 ─────────
  console.log(`  ④ 名字太长：「${OVER_LONG_NAME}」（7 字）+ 锚定整句「${OVER_LONG_VIA_ANCHOR}」`);
  {
    const r = await call('POST', '/game/nickname/extract', { text: OVER_LONG_NAME, npc: role.name });
    const b = r.json;
    const g = gateTwoStep(OVER_LONG_NAME);
    printMechanics('POST /game/nickname/extract（净化后超窗输入）', {
      http: r.status, kind: b.kind, reason: b.reason, action: b.action, will_persist: b.will_persist,
      candidate_text: b.candidate?.text, candidate_chars: b.candidate?.chars, candidate_bytes: b.candidate?.bytes,
      gate: b.candidate?.gate ?? null, has_via_receipt: !!b.candidate?.via,
      suggestion_pool_key: b.suggestion_pool_key,
    });
    console.log(`      ↳ 脚本体两步判定：extract.kind=${g.extracted.kind}，validate.code=${g.gate.code}`
      + `（7 字 > 落库上限 ${NICKNAME_MAX_CHARS} 字、但 ≤ 采集窗 ${NICKNAME_COLLECT_MAX_CHARS} 字 ⇒ over_window，不是硬拒）`);
    console.log(`      ↳ 未发 via 回执（has_via_receipt=${!!b.candidate?.via}）⇒ 这类候选天然写不进库。`);

    if (b.action === 'offer_candidates' && Array.isArray(b.suggestions)) {
      b.suggestions.forEach((s, i) => {
        console.log(`    候选[${i + 1}] 「${s.text}」 source=${s.source} chars=${s.chars} bytes=${s.bytes} gate.ok=${s.gate?.ok} via=${!!s.via}`);
        if (s.source === 'derived') stats.suggestDerived += 1;
        if (s.source === 'pool') stats.suggestPool += 1;
      });
      console.log(`    回显：suggestion_pool_key=${JSON.stringify(b.suggestion_pool_key)}（未命中为 null ⇒ 键名漂移会在测试里显形）`);
      if (b.suggestions.length === 0) console.log('    候选全被自身门禁剔除 ⇒ suggestions=[]（本演示如实显示空表，不编名字）');

      const first = b.suggestions[0]?.text ?? null;
      const too = line(role, 'tooLong');
      const filled = fill(too.text, { alias: first, nickname: OVER_LONG_NAME });
      printScript(role, '她', filled,
        `来源 ${too.source}（共 ${too.count} 条）；{player_alias} → 候选[1]「${first}」，{player_nickname} → 「${OVER_LONG_NAME}」`);
    } else {
      console.log('      ⚠️ 该输入未走 offer_candidates 分支 ⇒ 如实跳过"给候选"文案。');
    }

    // 反例对照：任务书原文示例（10 字，净化后**超出采集窗**）—— 如实显示它落在哪一支
    const r2 = await call('POST', '/game/nickname/extract', { text: TOO_LONG_UNCLEAN, npc: role.name });
    const g2 = gateTwoStep(TOO_LONG_UNCLEAN);
    printMechanics(`对照：任务书原文示例「${TOO_LONG_UNCLEAN}」`, {
      http: r2.status, kind: r2.json?.kind, reason: r2.json?.reason, action: r2.json?.action,
      will_persist: r2.json?.will_persist, suggestions: r2.json?.suggestions?.length ?? null,
      gate_reached: g2.gate ? true : false,
    });
    console.log('      ↳ 该串 10 字 > 采集窗上界 8 ⇒ 抽取层给 unparsed/no_anchor（R3 纯答句长度窗不通过），');
    console.log('        因此**走不到 over_window**。"太长 ⇒ 给候选"这条分支的真实入口是「锚定后 7~8 字」。');
    console.log('        按设计 §2.3，≥9 字属硬拒/换说法，归 Go 侧状态机处理，本演示不代它决定。');
  }

  // ── ⑤ 改称呼 → /set 改成另一个名字 → 昵称变更台词 ─────────────────────────
  console.log(`  ⑤ 改称呼：「${prevName}」→「${newName}」（当日第一次改，无冷却）`);
  {
    const r = await call('POST', '/game/nickname/extract', { text: newName, npc: role.name });
    const c0 = r.json?.candidate;
    const g = gateTwoStep(newName);
    printMechanics('POST /game/nickname/extract', { http: r.status, kind: r.json?.kind, action: r.json?.action, will_persist: r.json?.will_persist, gate: c0?.gate ?? null, via: !!c0?.via });
    console.log(`      ↳ 脚本体两步判定：extract.kind=${g.extracted.kind}，validate.ok=${g.gate ? g.gate.ok : 'n/a'}（改称呼走的是同一套门禁，没有第二套判定）`);

    const chg = line(role, 'change');
    const filled = fill(chg.text, { nickname: newName });
    printScript(role, '她', filled,
      `来源 ${chg.source}（共 ${chg.count} 条）；{player_nickname} → 「${newName}」`);

    if (r.json?.will_persist && c0) {
      const setRes = await call('POST', '/game/nickname/set', {
        npc: role.name, candidate: { text: c0.text, via: c0.via }, raw_msg: newName, user_id: USER_ID,
      });
      const stateRes = await call('GET', `/game/nickname/state?npc=${encodeURIComponent(role.name)}&user_id=${USER_ID}`);
      const ns = stateRes.json?.nickname_state;
      printMechanics('POST /game/nickname/set + GET /game/nickname/state', {
        set_http: setRes.status, set_ok: setRes.json?.ok, readback: ns?.nickname, source: ns?.source, updated_at: ns?.updated_at,
      });
      console.log(ns?.nickname === newName
        ? `      ✅ 改称呼已落库并读回一致：「${ns.nickname}」（单例 kind ⇒ 只保留最新一条）`
        : `      ❌ 读回不一致：期望「${newName}」，实际「${ns?.nickname}」`);
    } else {
      console.log('      ⚠️ 抽取未产出可落库候选 ⇒ 跳过 /set。');
    }
    console.log('      ※ 标注：「当日第二次改」的 24h 冷却判定属 **Go 侧**；本演示只演示文案，不做冷却拦截。');
  }

  // ── ⑥ 第二个角色首次上线 → 小号话术（三人各一遍） ────────────────────────
  console.log('  ⑥ 第二个角色首次上线 → 小号话术');
  {
    const alt = line(role, 'altFirstLogin');
    printScript(role, '她', alt.text, `来源 ${alt.source}（共 ${alt.count} 条）`);
    console.log('      🚩 醒目标注：小号首登的**触发判定与投递属 Go 侧**（账号第 2+ 角色首登、令牌桶仲裁、');
    console.log('         不得触碰账号好感/称呼档位/静默轴）。离线**未跑真实链路** ⇒ 此处**仅为台词预览**。');
    printMechanics('本段机械判定', { model_called: false, endpoints_called: 0, gate_two_step_called: 0, note: '本段无抓取/无门禁，纯语料预览' });
  }
}

// ── 8. main ─────────────────────────────────────────────────────────────────
let exitCode = 0;
try {
  title('溪语 AI · 离线称呼对话剧本演示（不进游戏验收内容与逻辑）');
  printBoundary('首');
  console.log(`\n门禁口径（来自 src/nickname_gate.mjs，未改）：
  采集窗口 1~${NICKNAME_COLLECT_MAX_CHARS} 字 / 落库上限 ${NICKNAME_MAX_CHARS} 字 · ${NICKNAME_MAX_GBK_BYTES} GBK 字节
  7~8 字 ⇒ over_window（太长 + 给候选，不落库、也不硬拒）；≥9 字或非法字符 ⇒ 硬拒（归 Go 侧）
  合规判定一律走两步：extractNicknameCandidate → validateNicknameCandidate（不接受裸串直调）`);
  console.log(`\n演示玩家：user_id=${USER_ID}；三人：「软糖小桃子 / 奶盖小团子 / 黑咖小助手」各跑一遍`);

  seed();

  title('剧本正文（第 ①~⑥ 段 · 三人各打一遍）');
  for (let i = 0; i < 3; i++) {
    resetRotationState();
    title(`★ 轮次 ${i + 1}/3 —— 三人横向对比`);
    for (const role of ROLES) await runRotation(role, i);
  }

  // 清理临时库（含 WAL/SHM），证明一切写入都发生在临时目录
  try { db.close(); } catch { /* 已关则忽略 */ }
  for (const suf of ['', '-wal', '-shm']) { try { fs.rmSync(TMP_DB + suf, { force: true }); } catch {} }

  title('判定计数（门禁通过 / 拒绝）');
  kv('剧本轮次（三人 × 遍数）', stats.rotations);
  kv('抽取 accepted → 过门禁后通过（validate ok:true）', stats.gatePass);
  kv('抽取 accepted → 门禁拒绝（validate ok:false）', stats.gateReject);
  kv('  其中按拒绝码', [...stats.gateRejectCodes].map(([k, v]) => `${k}×${v}`).join('、') || '（无）');
  kv('抽取层即未 accepted（未送门禁，非"内容不合规"）', stats.extractReject);
  kv('  其中按抽取态', [...stats.extractRejectKinds].map(([k, v]) => `${k}×${v}`).join('、') || '（无）');
  console.log('    ↳ 口径说明：上面 unparsed 的 9 条 = 每遍 3 条「任务书原文示例（10 字，超采集窗）」对照；');
  console.log('      而「随便你叫吧」走的是 rejected_named（抽取层判拒答），不计入 unparsed。');
  kv('候选来源 source 统计', `derived×${stats.suggestDerived}、pool×${stats.suggestPool}`);
  kv('/set 落库次数', `${stats.gatePass} 次尝试中由 will_persist 分支决定（详见各段[机械]行）`);

  title('本次演示用到的关键环境');
  kv('DB_PATH（临时库）', TMP_DB);
  kv('CORPUS_DIR（临时语料副本）', TMP_CORPUS);
  kv('生产库（未 open）', PROD_DB);
  kv('生产语料目录（未写）', PROD_CORPUS_DIR);
  kv('复跑', 'cd D:\\GitHub\\xiyu-ai && node scripts/lover_nickname_demo.mjs');
  kv('临时目录', `${TMP_ROOT}（脚本结束时整体删除；正常跑完该目录不应残留）`);

  printBoundary('尾');
} catch (err) {
  exitCode = 1;
  console.error('\n[演示失败] ' + (err?.stack || err));
} finally {
  try { await new Promise((resolve) => server.close(resolve)); } catch {}
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (e) {
    console.error(`[清理失败] ${TMP_ROOT}：${e?.message || e}（请手动删除）`);
  }
  if (fs.existsSync(TMP_ROOT)) console.log(`\n[清理核对] ❌ 临时目录仍存在：${TMP_ROOT}`);
  else console.log(`\n[清理核对] ✅ 临时目录已删除：${TMP_ROOT}`);
}

if (exitCode !== 0) process.exit(exitCode);
