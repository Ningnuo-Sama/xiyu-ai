#!/usr/bin/env node
/**
 * dnf_brain_p0_smoke.mjs —— DNF 大脑 P0 专用门禁（t12 交付）
 *
 * 覆盖四件事（对应设计文档 §4.1 L0 与评审 B-1 / B-4）：
 *   ① 失败可见性：不配 chat provider 时，/game/chat 的 source 必须是明确的失败态
 *      （api_fallback），**不得**再是 'api'；契约取值域 7 个值都要能被 normalizeSource 收敛；
 *   ② 状态写回接缝：一次真实玩家发言后，companions.last_user_reply_at 被写入；
 *   ③ 状态即时化：响应的 affection / relationship_stage 用本次生成后的最新值（不慢一轮）；
 *   ④ 语料可见化：语料 JSON 写坏时不再静默回落旧缓存，必须打出可捕获的 WARN。
 *   附加：热更新（mtime 变化）仍然生效（回归保护，不得因 ④ 的改动而破坏）。
 *
 * 隔离铁律（本脚本的设计前提）：
 *   - 绝不写生产库 `data/bot.db`：全程使用 `DNF_P0_SMOKE_TMP` 下的临时 SQLite；
 *   - 绝不写生产语料 `data/dnf_corpus/`：通过 `CORPUS_DIR` 指向临时语料目录；
 *   - 绝不占用 3366：自建 express 实例监听 `127.0.0.1:0`（内核分配随机端口）。
 *   因此能在 CI/本地随时跑，不会污染任何运行态数据。
 *
 * 用法：node scripts/dnf_brain_p0_smoke.mjs
 * 退出码：0 = 全绿；1 = 有任一断言失败（可直接作为门禁）。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_CORPUS = path.join(ROOT, 'data', 'dnf_corpus');

// ─── 结果收集 ────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`); }
}

// ─── 1. 搭隔离环境（必须在 import 任何 src 模块之前设好 env） ──────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dnf-p0-smoke-'));
const TMP_CORPUS = path.join(TMP, 'corpus');
const TMP_DB = path.join(TMP, 'bot.db');
const TMP_LOGS = path.join(TMP, 'logs');
fs.mkdirSync(TMP_CORPUS, { recursive: true });

/**
 * 原子替换语料文件（写临时文件 → 设 mtime → rename）。
 * 评审 B-4 的 C2 硬要求：**禁用就地编辑**——`loadCorpusHot` 的 catch 会静默回落旧缓存，
 * 就地写坏会变成"改了不生效又没报错"。这里同时显式设置 mtime，
 * 避免"同一时间粒度内连续写导致 mtime 未变、加载器判为缓存命中"的假阴性。
 */
function writeCorpusAtomic(filePath, obj) {
  const tmp = `${filePath}.tmp_p0smoke`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  const future = new Date(Date.now() + 90_000);
  fs.utimesSync(tmp, future, future);
  fs.renameSync(tmp, filePath);
}

// 临时语料 = 生产语料的副本（只读拷贝，不改生产）
for (const f of fs.readdirSync(REAL_CORPUS)) {
  fs.copyFileSync(path.join(REAL_CORPUS, f), path.join(TMP_CORPUS, f));
}

process.env.DB_PATH = TMP_DB;
process.env.CORPUS_DIR = TMP_CORPUS;
process.env.LOG_DIR = TMP_LOGS;
// §17 路径②（`local`）的触发机制是 `CHAT_API_TIMEOUT_MS` 的 `Promise.race` 超时，
// 而该常量在 game_dnf.mjs **模块加载时**读取，所以必须在这里（import 之前）设短超时，
// 让 [⑧-C] 能用"黑洞端点 + 短超时"确定性复现该路径（否则要真等 4s）。
process.env.CHAT_API_TIMEOUT_MS = '400';
// 关键：确保没有 chat provider，从而必然走"失败兜底"这条要验的路
delete process.env.CHAT_PROVIDER;
delete process.env.CHAT_MODEL;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.OPENAI_COMPATIBLE_API_KEY;
delete process.env.OPENAI_COMPATIBLE_BASE_URL;

console.log('🔬 DNF 大脑 P0 门禁（失败可见性 + 状态写回 + 状态即时化 + 语料可见化 + §17 三态语义）');
console.log(`   临时目录: ${TMP}`);
console.log(`   临时库  : ${TMP_DB}`);
console.log(`   临时语料: ${TMP_CORPUS}\n`);

let server = null;
try {
  // ─── 2. 动态 import（env 已就位） ──────────────────────────────────────────
  const express = (await import('express')).default;
  const { getDb, patchCompanion, ensureSleepRow, upsertSleepSchedule } = await import('../src/db.mjs');
  const { gameRouter, SOURCE, SOURCE_REASONS, normalizeSource, getCorpusLoadFailures, peekCorpusCache } = await import('../src/game_dnf.mjs');
  const { consumeReplyFailure, peekReplyFailure } = await import('../src/ai.mjs');
  const { getNeglectStage, buildReunionHint } = await import('../src/emotion_state.mjs');

  const db = getDb();
  const NPC = '软糖小桃子';
  const logFile = path.join(TMP_LOGS, 'bot.log');

  // 播种一个最小可用 companion（临时库，可随意写）
  // affection 刻意取 20（低于 AFFECTION_LOVER=55 的"增幅减半"门槛），
  // 否则好感日上限/衰减会让"好感推进"断言退化成恒等、验不出即时化。
  db.prepare(`INSERT INTO companions (id, user_id, bot_id, name, age, role_title, attachment_style,
      memory_enabled, affection_level, affection_today, affection_day, relationship_stage,
      current_mood, temperature, max_tokens, top_p)
      VALUES (1, NULL, 'dnf-p0-smoke', ?, 20, '女元素', 'secure', 0, 20, 0, NULL, '朋友', '平静', 0.8, 320, 0.95)`)
    .run(NPC);
  ok('临时库播种 companion 成功', !!db.prepare('SELECT id FROM companions WHERE name = ?').get(NPC));

  // 睡眠门必须放开：默认作息 00:30–07:30 入睡（sleep.mjs:16-17），CI/本地随时可能落在
  // 窗口内——此时 playgroundChat 会在睡眠门**早退**（reply:null），既不写状态也不走情绪，
  // 测试就会验成"状态没推进"的假红（本次实现过程中就被这个坑咬过一次）。
  //
  // 这里不猜时段，而是**把入睡窗口推到最远的未来**：把 bed_time 设成"当前上海时刻 +1 小时"，
  // wake_time 设成"bed + 2 小时"，且 jitter_min=0（否则随机抖动最多 45min 会吃掉安全余量）。
  // 由 sleep.mjs 的跨天对齐逻辑，窗口会落在 bed 与其后 2 小时内；当前时刻距 bed 至少 1 小时
  // 的安全余量，因此**任何时刻跑都必处于清醒态**，无需人肉挑时段。
  ensureSleepRow(1);
  {
    const shNow = new Date(Date.now() + 8 * 3600_000);           // 上海墙钟
    const bedMin = (shNow.getUTCHours() * 60 + shNow.getUTCMinutes() + 60) % 1440;
    const wakeMin = (bedMin + 120) % 1440;
    const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    upsertSleepSchedule(1, { enabled: 1, bed_time: hhmm(bedMin), wake_time: hhmm(wakeMin), jitter_min: 0 });
    const asleep = db.prepare('SELECT is_sleeping FROM companion_sleep_schedule WHERE companion_id = 1').get();
    ok('测试环境已被置于清醒态（睡眠窗口推到 ≥1h 之后，任意时刻可跑）',
      !asleep?.is_sleeping, `bed=${hhmm(bedMin)} wake=${hhmm(wakeMin)}`);
  }
  // 用真实链路自证"当前不在睡眠态"——这比上面的算术更可信（覆盖跨天对齐的全部边界）
  {
    const { maybeSleepBlock } = await import('../src/sleep.mjs');
    const gate = maybeSleepBlock({ companionId: 1, msgType: 'text', content: '探针' });
    ok('真实睡眠门放行（maybeSleepBlock 未拦截）', gate.blocked === false, `reason=${gate.reason}`);
  }

  // logger 走 createWriteStream（异步刷盘），断言日志必须等它落盘，不能靠 sleep 猜。
  async function waitForLog(file, re, { timeoutMs = 3000, intervalMs = 50 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      try { last = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; } catch { last = ''; }
      if (re.test(last)) return last;
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return last;
  }

  // ─── 3. 起一个自建 express 实例（随机端口，不碰 3366） ──────────────────────
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/', gameRouter);
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const BASE = `http://127.0.0.1:${port}`;
  ok('自建实例监听随机端口（非 3366）', port !== 3366 && port > 0, `port=${port}`);

  async function postChat(body) {
    const r = await fetch(`${BASE}/game/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  }
  async function postMail(body) {
    const r = await fetch(`${BASE}/game/mail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  }

  // ═══ 门禁 ① 失败可见性 ═════════════════════════════════════════════════════
  // 契约（定调 §17 冻结）把 /game/chat 的"非成功"分成两条**语义不同**的路径，
  // 本门禁两条都验，且分别断言正文与 source 的对应关系（这是最容易搞反的地方）：
  //   路径 1：在线返回了内容，但正文是固定兜底句 → source=api_fallback（Go 应丢弃换本地池）
  //   路径 2：在线路径整体失败（超时/异常）→ 正文是本地语料 → source=local（Go 正常转录）
  console.log('\n[① 失败可见性 / source 契约]');
  const r1 = await postChat({ npc: NPC, text: '在吗' });
  ok('请求 200', r1.status === 200, `status=${r1.status}`);
  ok('source 不再是 "api"（无 provider 时）', r1.body.source !== SOURCE.API, `source=${r1.body.source}`);
  ok('路径 1：正文是固定兜底句 → source=api_fallback',
    r1.body.source === SOURCE.API_FALLBACK && /走神/.test(r1.body.reply),
    `source=${r1.body.source} reply="${String(r1.body.reply).slice(0, 30)}"`);
  ok('路径 1：失败原因随响应透出（source_reason 非空）', !!r1.body.source_reason, `source_reason=${r1.body.source_reason}`);

  // 契约取值域：7 个值都能被原样接受
  const CONTRACT = ['api', 'api_fallback', 'local', 'proactive_shuffle', 'sleeping', 'error', 'go_fallback'];
  const allAccepted = CONTRACT.every(v => normalizeSource(v) === v);
  ok('契约 7 值全部被 normalizeSource 原样接受', allAccepted);

  // 未知值降级语义：一律降级为 api_fallback（不许当成功）
  const unknownIn = ['', 'llm', 'api_success', 'FALLBACK', 'null', null, undefined];
  const unknownOut = unknownIn.map(v => normalizeSource(v));
  ok('未知 source 一律降级为 api_fallback', unknownOut.every(v => v === SOURCE.API_FALLBACK),
    `样本→${JSON.stringify(unknownOut)}`);

  // ── 路径 2 的覆盖：短路分支（未走 LLM → 正文是本地语料）
  const rGreetSrc = await postChat({ npc: NPC, event_type: 'greeting' });
  ok('主动问候短路：正文是本地语料、source=proactive_shuffle（等价 local，正常转录）',
    rGreetSrc.body.source === SOURCE.PROACTIVE_SHUFFLE, `source=${rGreetSrc.body.source}`);

  // ── 邮件路径：正文是本地保底信 → source=local（不是 api_fallback，否则 Go 会丢掉这封信）
  const rMail = await postMail({ npc: NPC, hint: '强化碎了' });
  ok('邮件：正文为本地保底信时 source=local（不得标 api_fallback）',
    rMail.body.source === SOURCE.LOCAL, `source=${rMail.body.source}`);
  ok('邮件：LLM 不可用的信息由 source_reason 承载',
    !!rMail.body.source_reason, `source_reason=${rMail.body.source_reason}`);
  ok('邮件 source 在契约取值域内', CONTRACT.includes(rMail.body.source), `source=${rMail.body.source}`);
  ok('邮件正文非空（本地保底信确实产出了内容）',
    typeof rMail.body.body === 'string' && rMail.body.body.length > 0);

  // ── 路径②（`local`）的**源码级**钉死：return 语句里的 source 必须是 LOCAL、reason 必须是
  //    枚举常量 `SOURCE_REASONS.ONLINE_PATH_FAILED`（t13 F-3 之后 reason 已冻结为枚举，
  //    不再透传原始 provider 错误串，故断言同步匹配枚举写法）。
  //    **行为级**可达性证明见下面的 [⑧-C]（黑洞端点 + 短超时），源码断言只是第二道锁。
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'game_dnf.mjs'), 'utf8');
    // 允许 `source:` 与 `source_reason:` 之间存在解释性注释（t13 F-3 的说明就在中间）
    ok('源码级：在线路径整体失败后的本地兜底标为 local + 枚举 reason',
      /source:\s*normalizeSource\(SOURCE\.LOCAL\)[\s\S]{0,400}?source_reason:\s*SOURCE_REASONS\.ONLINE_PATH_FAILED/.test(src));
    ok('源码级：本地兜底分支不会标成 api_fallback',
      !/无感退本地[\s\S]{0,1500}source:\s*normalizeSource\(SOURCE\.API_FALLBACK\)/.test(src));
    // t13 F-3：任何 source_reason 都不得透传原始错误串（`failureSink.reason` / `apiFailureReason`）
    ok('源码级：source_reason 不再透传原始错误文本（t13 F-3）',
      !/source_reason:\s*(failureSink\.reason|onlineResult\.apiFailureReason)/.test(src));
    // t13 F-4：硬编码兜底池不得含禁用称呼。**只扫池子里的字符串字面量**——
    // 直接扫整段会把"解释为什么禁用"的注释本身（其中必然出现这些词）误判为违规。
    const poolStart = src.indexOf('const GAMER_GIRL_CHAT_FALLBACK');
    const poolEnd = src.indexOf('// ── 2.1');
    const poolBlock = (poolStart >= 0 && poolEnd > poolStart) ? src.slice(poolStart, poolEnd) : '';
    const poolLiterals = (poolBlock.match(/"[^"\n]*"|'[^'\n]*'/g) || []).join('\n');
    const bannedHit = /大英雄|勇士大人|冒险家|哥哥|搬砖/.exec(poolLiterals);
    ok('源码级：硬编码兜底池的**字符串字面量**无禁用称呼/年代雷词（t13 F-4）',
      poolLiterals.length > 0 && !bannedHit,
      bannedHit ? `命中「${bannedHit[0]}」` : (poolLiterals.length ? '' : '未能提取池子里的字符串字面量'));
  }

  // ─── 门禁 ② 状态写回接缝 ───────────────────────────────────────────────────
  console.log('\n[② 状态写回接缝 last_user_reply_at]');
  // 注意：本脚本在此之前的几发请求已经触发过写回（那是设计使然——写回刻意放在生成之前、
  // 不受失败影响）。所以这里验的是"能写、写的是刚才、且每轮都刷新"，不是"从空到有"。
  const beforeRow = db.prepare('SELECT last_user_reply_at FROM companions WHERE id = 1').get();
  ok('经过前几轮请求后该列已有值（写回在失败路径也生效）', !!beforeRow.last_user_reply_at,
    `实际=${beforeRow.last_user_reply_at}`);

  const t0 = Date.now();
  await postChat({ npc: NPC, text: '今天深渊光头了，好难受' });
  const afterRow = db.prepare('SELECT last_user_reply_at FROM companions WHERE id = 1').get();

  ok('一次真实玩家发言后 last_user_reply_at 被写入且刷新', !!afterRow.last_user_reply_at,
    `实际=${afterRow.last_user_reply_at}`);
  {
    const ts = Date.parse(String(afterRow.last_user_reply_at).replace(' ', 'T'));
    const fresh = Number.isFinite(ts) && Math.abs(ts - t0) < 60_000;
    ok('写入的时间戳是"刚才"（±60s，说明本轮被刷新）', fresh, `值=${afterRow.last_user_reply_at}`);
  }
  // 断言源码里确实存在写入点（防"只靠测试塞值"的假绿）
  const pgSrc = fs.readFileSync(path.join(ROOT, 'src', 'playground.mjs'), 'utf8');
  ok('playground.mjs 内存在 last_user_reply_at 的写入调用',
    /patchCompanion\([^)]*last_user_reply_at/.test(pgSrc));

  // ─── 门禁 ③ 状态即时化 ────────────────────────────────────────────────────
  console.log('\n[③ 状态即时化（不慢一轮）]');
  const stateRow = db.prepare('SELECT affection_level, relationship_stage, current_mood FROM companions WHERE id = 1').get();
  const r2 = await postChat({ npc: NPC, text: '谢谢你陪我，你真好最可爱了' });
  const stateRow2 = db.prepare('SELECT affection_level FROM companions WHERE id = 1').get();
  ok('响应里的 affection 等于本次写库后的值',
    r2.body.affection === stateRow2.affection_level,
    `响应=${r2.body.affection} 库=${stateRow2.affection_level}`);
  ok('好感确实在本轮发生了推进（防止断言退化为恒等）',
    stateRow2.affection_level > stateRow.affection_level,
    `${stateRow.affection_level} → ${stateRow2.affection_level}`);
  ok('响应里的 relationship_stage 与库一致',
    r2.body.relationship_stage === db.prepare('SELECT relationship_stage FROM companions WHERE id = 1').get().relationship_stage);
  ok('响应里的 mood 与库一致',
    r2.body.mood === db.prepare('SELECT current_mood FROM companions WHERE id = 1').get().current_mood,
    `响应=${r2.body.mood}`);
  {
    const pg2 = fs.readFileSync(path.join(ROOT, 'src', 'playground.mjs'), 'utf8');
    // 反退化断言：syncUpdateCompanionState 必须出现在异步 IIFE **之前**，否则又是慢一轮
    const syncIdx = pg2.indexOf('syncUpdateCompanionState(companion, text, reply)');
    const iifeIdx = pg2.indexOf('(async () => {');
    ok('syncUpdateCompanionState 已被提到异步后处理之前（源码位置校验）',
      syncIdx > 0 && iifeIdx > 0 && syncIdx < iifeIdx, `sync@${syncIdx} iife@${iifeIdx}`);
    ok('异步后处理块内不再重复调用 syncUpdateCompanionState',
      !pg2.slice(iifeIdx).includes('syncUpdateCompanionState(companion, text, reply)'));
  }

  // ─── 门禁 ④ 语料可见化（评审 B-4） ────────────────────────────────────────
  // 走**问候短路分支**（`!text && event_type='greeting'`）来驱动语料加载器：
  // 这条分支不碰 LLM、确定性调用 getLocalGamerGirlReply → loadCorpusHot，
  // 是唯一能在门禁里稳定复现"语料被读/被写坏/被热更"的入口。
  // （普通文本路径在无 provider 时走的是"固定兜底句"分支，**根本不会读语料**——
  //   一开始我把语料断言挂在那条路径上，才出现"损坏却没有失败记录"的假红。）
  console.log('\n[④ 语料加载失败不再静默]');
  const peachPath = path.join(TMP_CORPUS, 'peach_corpus.json');

  // 前置：先让语料进缓存，并记下"好语料"的内容
  await postChat({ npc: NPC, event_type: 'greeting' });
  const cacheLoaded = peekCorpusCache('peach');
  ok('好语料已被载入缓存（前置条件）', !!cacheLoaded?.data);
  ok('缓存记录了 mtime（热更判据可用）', Number(cacheLoaded?.mtime) > 0,
    `mtime=${cacheLoaded?.mtime}`);

  // 前置：证明"生效内容确实来自该文件"——往问候池写一条唯一标记，触发一次请求让加载器读它，
  // 然后直接断言**生效缓存**里有这条标记。这里刻意不做"回复抽样命中"：
  // 问候池走洗牌袋（~40 条/轮），抽样命中是概率事件，会写出偶发假红的门禁。
  const marker = `【P0烟测_语料读取证明_${Date.now()}】`;
  const goodObj0 = JSON.parse(fs.readFileSync(peachPath, 'utf8'));
  goodObj0.proactive_greetings = [marker, ...(goodObj0.proactive_greetings || [])];
  writeCorpusAtomic(peachPath, goodObj0);
  await postChat({ npc: NPC, event_type: 'greeting' });
  const cacheWithMarker = peekCorpusCache('peach');
  ok('生效语料确实来自该文件（写入的标记出现在生效缓存里）',
    !!cacheWithMarker?.data?.proactive_greetings?.includes(marker));
  // 并且回复确实出自这份生效语料（**确定性**写法：把生效缓存里所有字符串拍平成一个集合，
  // 断言回复属于它）。旧写法只查 `proactive_greetings` 一个池，隐含假设"问候一定从该池出"——
  // 但生产 `peach_corpus.json` **没有** `proactive_greetings` 键，问候会继续往下走到
  // social 池（如"你还在吗？"），于是断言偶发假红（captain 2026-10-12 实测到过）。
  // 拍平全量字符串既保留了"回复必须来自语料"的强度，又不再依赖具体池名。
  const corpusStrings = new Set();
  (function flatten(node) {
    if (typeof node === 'string') { corpusStrings.add(node); return; }
    if (Array.isArray(node)) { node.forEach(flatten); return; }
    if (node && typeof node === 'object') { Object.values(node).forEach(flatten); }
  })(cacheWithMarker?.data);
  const rFromCorpus = await postChat({ npc: NPC, event_type: 'greeting' });
  ok('问候回复确实取自生效语料（拍平全量字符串后做成员判定，确定性）',
    corpusStrings.has(rFromCorpus.body.reply),
    `reply="${String(rFromCorpus.body.reply).slice(0, 30)}" 语料字符串数=${corpusStrings.size}`);
  ok('前置：拍平结果非空（否则上面的成员判定会退化成恒假）', corpusStrings.size > 0,
    `size=${corpusStrings.size}`);
  // 回归：洗牌袋在热更时必须被作废，否则新条目要等旧袋抽完才生效（t38 修）
  {
    const srcShuffle = fs.readFileSync(path.join(ROOT, 'src', 'game_dnf.mjs'), 'utf8');
    ok('源码级：语料重载时作废洗牌袋（热更即刻生效，消除时序竞争）',
      /if \(Array\.isArray\(shuffleBags\[name\]\)\) shuffleBags\[name\] = \[\]/.test(srcShuffle));
  }

  // 写坏 → 必须被登记为显式失败，且回落到旧缓存
  const failuresBefore = getCorpusLoadFailures().length;
  fs.writeFileSync(peachPath, '{ 这不是合法 JSON ', 'utf8');
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(peachPath, future, future);

  const rBroken = await postChat({ npc: NPC, event_type: 'greeting' });
  ok('语料损坏时不崩溃、仍能给出回复',
    rBroken.status === 200 && typeof rBroken.body.reply === 'string' && rBroken.body.reply.length > 0);

  const newFailures = getCorpusLoadFailures().slice(failuresBefore);
  ok('语料损坏被登记为显式失败（不再静默回落）', newFailures.length >= 1,
    `新增失败记录=${newFailures.length}`);
  ok('失败记录里带文件路径与原因，便于定位',
    newFailures.length > 0 && newFailures[0].message.includes('peach_corpus.json') && /加载失败/.test(newFailures[0].message),
    newFailures.length ? `message=${newFailures[0].message.slice(0, 160)}` : '无记录');

  // 辅证：日志确实也打了（logger 是异步刷盘，给它宽裕时间；失败不影响主断言）
  const fullLog = await waitForLog(logFile, /语料 peach 加载失败/, { timeoutMs: 5000 });
  ok('同一失败也进了日志（WARN，含文件路径）',
    /语料 peach 加载失败/.test(fullLog) && fullLog.includes('peach_corpus.json'),
    fullLog ? `命中行=${JSON.stringify((fullLog.match(/.*语料 peach 加载失败.*/) || [''])[0].slice(0, 140))}` : '（日志文件暂无内容；主断言已由进程内计数覆盖）');

  // 重复同一份坏内容不应刷屏（告警去重）
  const dupBefore = getCorpusLoadFailures().length;
  await postChat({ npc: NPC, event_type: 'greeting' });
  await postChat({ npc: NPC, event_type: 'greeting' });
  ok('同一份坏内容重复请求不重复登记（去重生效）',
    getCorpusLoadFailures().length === dupBefore,
    `之前=${dupBefore} 之后=${getCorpusLoadFailures().length}`);

  // t13 F-5：去重键必须是**文件内容**的 sha1，不能是"错误文本"的 sha1。
  // 构造场景：两份**内容不同**的坏 JSON，但 JSON.parse 的错误文本逐字相同
  //（同一偏移位置的同类语法错），实测两者错误串一致：
  //   A: `{ 这不是合法 JSON `  B: `{ 这也不是合法呀 `  → 都报 "Expected property name or '}' in JSON at position 2 …"
  // 旧实现（错误文本作键）会把 B 当成 A 的重复而**少报一次**——运维因此不知道另一处内容也坏了，
  // 属"静默失聪"家族（不是刷屏，而是**漏报**）。内容作键则两份各报一次。
  {
    const before = getCorpusLoadFailures().length;
    // 两份**全新**的坏内容（与上一节写过的那份也不同，否则会被内容 sha1 正确去重）
    const badA = '{ 甲甲甲不是合法 ';
    const badB = '{ 乙乙乙也不是合法 ';
    fs.writeFileSync(peachPath, badA, 'utf8');
    let t = new Date(Date.now() + 30_000); fs.utimesSync(peachPath, t, t);
    await postChat({ npc: NPC, event_type: 'greeting' });
    const afterA = getCorpusLoadFailures().length;
    fs.writeFileSync(peachPath, badB, 'utf8');
    t = new Date(Date.now() + 60_000); fs.utimesSync(peachPath, t, t);
    await postChat({ npc: NPC, event_type: 'greeting' });
    const afterB = getCorpusLoadFailures().length;
    ok('[F-5] 内容不同的两份坏语料各告警一次（内容 sha1 作键，不误并）',
      afterA === before + 1 && afterB === afterA + 1,
      `计数 ${before} → ${afterA} → ${afterB}`);
    // 证明测试前提成立：两份内容不同，但错误文本逐字相同（否则这条用例证明不了 F-5）
    const recs = getCorpusLoadFailures();
    const mA = recs[afterA - 1]?.message || '';
    const mB = recs[afterB - 1]?.message || '';
    const errOf = (m) => (m.split('—').pop() || '').trim();
    ok('[F-5] 前提成立：两份坏内容的错误文本逐字相同（差异只在内容）',
      errOf(mA) !== '' && errOf(mA) === errOf(mB),
      `A=${JSON.stringify(errOf(mA).slice(0, 60))} B=${JSON.stringify(errOf(mB).slice(0, 60))}`);
  }

  // ── 回归：热更新（mtime 变化）仍生效 ──────────────────────────────────────
  console.log('\n[⑤ 回归：热更新仍生效]');
  const mtimeBefore = peekCorpusCache('peach')?.mtime ?? 0;
  const hotTag = `【P0烟测热更_${Date.now()}】哥哥教我的新魔法！`;
  const restored = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'dnf_corpus', 'peach_corpus.json'), 'utf8'));
  restored.proactive_greetings = [hotTag, ...(restored.proactive_greetings || [])];
  writeCorpusAtomic(peachPath, restored);
  await postChat({ npc: NPC, event_type: 'greeting' });
  const cacheNow = peekCorpusCache('peach');
  ok('修复后的加载器仍支持 mtime 热更新（缓存已换成新内容）',
    !!cacheNow && cacheNow.mtime > mtimeBefore, `mtime ${mtimeBefore} → ${cacheNow?.mtime}`);
  ok('热更新后新写入的条目已生效（生效缓存里出现了它）',
    !!cacheNow?.data?.proactive_greetings?.includes(hotTag));

  // ─── 附加：冷落链有输入（G0-2 纯函数断言） ────────────────────────────────
  console.log('\n[⑥ 附加：冷落链可被驱动（G0-2）]');
  const eightDaysAgo = new Date(Date.now() - 8 * 86400_000).toISOString();
  ok('getNeglectStage(8天前) 不再返回 none',
    getNeglectStage(eightDaysAgo, 'secure') !== 'none',
    `档位=${getNeglectStage(eightDaysAgo, 'secure')}`);
  ok('buildReunionHint 对久别返回修复文案',
    buildReunionHint(getNeglectStage(eightDaysAgo, 'secure'), 'secure', eightDaysAgo).includes('重逢'));

  // 端到端：把 last_user_reply_at 拨到 8 天前，请求后应带上 neglect_stage 诊断字段
  patchCompanion(1, { last_user_reply_at: eightDaysAgo });
  const rNeg = await postChat({ npc: NPC, text: '我回来了' });
  ok('久别后来消息，响应带上非 none 的 neglect_stage 诊断',
    !!rNeg.body.neglect_stage && rNeg.body.neglect_stage !== 'none',
    `neglect_stage=${rNeg.body.neglect_stage}`);
  // 且本轮结束后 last_user_reply_at 被刷新为现在（写回接缝持续生效）
  const refreshed = db.prepare('SELECT last_user_reply_at FROM companions WHERE id = 1').get().last_user_reply_at;
  ok('重逢轮次结束后 last_user_reply_at 被刷新为现在',
    Math.abs(Date.parse(String(refreshed).replace(' ', 'T')) - Date.now()) < 60_000,
    `值=${refreshed}`);

  // ─── 附加：失败标记不串场（并发/残留两条） ────────────────────────────────
  console.log('\n[⑦ 附加：失败标记无跨请求串味]');
  const peekBefore = peekReplyFailure(1);
  ok('请求级 sink 模式下，兜底标记 map 未被写入（说明走的是无竞态的 sink）',
    peekBefore.failed === false);

  const consumed = consumeReplyFailure(1);
  ok('consumeReplyFailure 在没有兜底标记时返回 failed=false（不误报）',
    consumed.failed === false);

  // ── 回归保护（t13 已通过的项不得退化，此处补上缺断言的几条） ────────────────
  {
    const aiSrc = fs.readFileSync(path.join(ROOT, 'src', 'ai.mjs'), 'utf8');
    ok('[回归] 兜底标记 map 有上限 200（防长跑累积）',
      /_REPLY_FAILURE_MAX\s*=\s*200/.test(aiSrc));
    ok('[回归] _replyCallSeq 防陈旧：递增 + 取用时比对序号',
      /_replyCallSeq\s*\+=\s*1/.test(aiSrc) && /hit\.callSeq\s*!==\s*_replyCallSeq/.test(aiSrc));
    const logSrc = fs.readFileSync(path.join(ROOT, 'src', 'logger.mjs'), 'utf8');
    ok('[回归] logger.mjs 仅有纯追加的 closeLog（log 本体未被改写）',
      /export function closeLog\s*\(/.test(logSrc) && /export function log\(level, message\)/.test(logSrc));
    const pgSrc = fs.readFileSync(path.join(ROOT, 'src', 'playground.mjs'), 'utf8');
    ok('[回归] last_user_reply_at 写回点仍在（P0-A 接缝）',
      /patchCompanion\(companion\.id,\s*\{\s*last_user_reply_at/.test(pgSrc));
  }

  // ═══ ⑧ §17 三态语义：sleeping / api_fallback / local 三者都必须**可达**且语义正确 ═══
  // 修复背景（t13 F-1/F-2）：
  //   · 旧实现先要求 `onlineResult.reply` 非空才判 `sleeping`，而睡眠门返回的正是 `reply:null`
  //     → sleep 分支结构性不可达，且会把"她睡了"错报成 local + reason=online_path_failed；
  //   · t13 曾判路径②（local）为死代码。本节的 [C] 用"黑洞端点 + 短超时"确定性证明它可达。
  console.log('\n[⑧ §17 三态语义（t38 修复：sleeping / api_fallback / local 均需可达且语义正确）]');

  const hmOf = (m) => { const v = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`; };
  const shNowMin = () => { const d = new Date(Date.now() + 8 * 3600_000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  // 睡眠窗设到"包含此刻"（必须清 today_* 缓存，否则 getOrRefreshTodaySchedule 会沿用旧窗）
  const setSleepWindow = (bedMin, wakeMin) => upsertSleepSchedule(1, {
    enabled: 1, bed_time: hmOf(bedMin), wake_time: hmOf(wakeMin), jitter_min: 0,
    today_date: null, today_bed_at: null, today_wake_at: null,
  });

  // --- A) 睡眠门命中 → source=sleeping + reason=sleep_gate（t13 F-2 修复验证）---
  {
    const { isSleepingNow } = await import('../src/sleep.mjs');
    const n = shNowMin();
    setSleepWindow(n - 60, n + 60);
    // 前置自证：窗口真的生效了（否则 [A] 会以"source 不是 sleeping"的形式报错，
    // 让人误以为是代码没修好，而实际是测试库没进睡眠态）。跨零点等边界都靠这条兜住。
    ok('[A] 前置：测试库确已进入睡眠态（isSleepingNow=true）',
      isSleepingNow(1) === true,
      `nowMin=${n} bed=${hmOf(n - 60)} wake=${hmOf(n + 60)}`);
    const rSleep = await postChat({ npc: NPC, text: '在吗' });
    ok('[A] 睡眠门命中 → source=sleeping（旧实现这里会给 local）',
      rSleep.body.source === SOURCE.SLEEPING, `source=${rSleep.body.source}`);
    ok('[A] sleeping=true 且 reply 为空（零投递语义）',
      rSleep.body.sleeping === true && rSleep.body.reply === '',
      JSON.stringify({ sleeping: rSleep.body.sleeping, reply: rSleep.body.reply }));
    ok('[A] source_reason=sleep_gate（**不得**再错报 online_path_failed）',
      rSleep.body.source_reason === SOURCE_REASONS.SLEEP_GATE, `reason=${rSleep.body.source_reason}`);
    ok('[A] 睡眠态不得带本地语料正文（否则 Go 会把"她睡了"当正常回复转录）',
      rSleep.body.reply === '' && (rSleep.body.replies || []).length === 0,
      JSON.stringify(rSleep.body.replies));
    // 恢复清醒窗，供后续场景使用
    setSleepWindow(n + 60, n + 180);
  }

  // --- B) provider 快速失败 → api_fallback（正文=固定兜底句）+ 枚举 reason + 无内部串泄漏（F-3）---
  {
    process.env.CHAT_PROVIDER = 'deepseek';
    delete process.env.DEEPSEEK_API_KEY;
    const rFast = await postChat({ npc: NPC, text: '在吗' });
    ok('[B] provider 快速失败 → source=api_fallback（正文=固定兜底句）',
      rFast.body.source === SOURCE.API_FALLBACK, `source=${rFast.body.source}`);
    ok('[B] source_reason=llm_failed（枚举值，非原始错误串）',
      rFast.body.source_reason === SOURCE_REASONS.LLM_FAILED, `reason=${rFast.body.source_reason}`);
    const bodyStr = JSON.stringify(rFast.body);
    ok('[B] 响应体不含内部串（API_KEY / .env / provider 名）— t13 F-3',
      !/API_KEY|\.env|DeepSeek|OPENAI_COMPATIBLE/i.test(bodyStr),
      bodyStr.slice(0, 180));
  }

  // --- C) provider 悬挂 → 超时熔断 → source=local（路径②可达性证明）---
  {
    const blackhole = net.createServer(() => { /* 接受连接但永不回包：模拟 provider 悬挂 */ });
    await new Promise(r => blackhole.listen(0, '127.0.0.1', r));
    try {
      process.env.CHAT_PROVIDER = 'openai-compatible';
      process.env.OPENAI_COMPATIBLE_API_KEY = 'dummy';
      process.env.OPENAI_COMPATIBLE_BASE_URL = `http://127.0.0.1:${blackhole.address().port}/v1`;
      process.env.CHAT_MODEL = 'gpt-4o-mini';
      const t0 = Date.now();
      const rHang = await postChat({ npc: NPC, text: '今天深渊光头了' });
      const elapsed = Date.now() - t0;
      // 下界证明"熔断真的触发了"；上界只是防呆（并行 agent 抢 CPU 时放宽，避免假红）
      ok('[C] 悬挂态在超时预算内回落（证明 CHAT_API_TIMEOUT_MS 熔断真会触发）',
        elapsed >= 300 && elapsed < 20000, `elapsed=${elapsed}ms`);
      ok('[C] 路径②**可达** → source=local（t13 曾判死代码，此断言证伪）',
        rHang.body.source === SOURCE.LOCAL, `source=${rHang.body.source}`);
      ok('[C] source_reason=online_path_failed（枚举值）',
        rHang.body.source_reason === SOURCE_REASONS.ONLINE_PATH_FAILED, `reason=${rHang.body.source_reason}`);
      ok('[C] 正文**取自语料**（不是"走神"那句固定兜底句）',
        !!rHang.body.reply && !/走神/.test(rHang.body.reply), JSON.stringify(rHang.body.reply));
      // 强断言：正文必须命中语料的 `abyss.bald_head` 池（"深渊光头"的既定路由）
      const peachJson = JSON.parse(fs.readFileSync(peachPath, 'utf8'));
      const baldHead = peachJson.abyss?.bald_head || [];
      ok('[C] 正文精确来自语料的光头池（abyss.bald_head，路由正确）',
        baldHead.includes(rHang.body.reply), `reply=${JSON.stringify(rHang.body.reply)}`);
      ok('[C] 响应体不含内部串 — t13 F-3',
        !/API_KEY|\.env|OPENAI_COMPATIBLE/i.test(JSON.stringify(rHang.body)));
      ok('[C] 回复通过了称呼注入守卫（无花括号残留）',
        !/\{/.test(String(rHang.body.reply)));
    } finally {
      blackhole.close();
      delete process.env.CHAT_PROVIDER;
      delete process.env.OPENAI_COMPATIBLE_API_KEY;
      delete process.env.OPENAI_COMPATIBLE_BASE_URL;
      delete process.env.CHAT_MODEL;
    }
  }
} catch (err) {
  fail++;
  failures.push({ name: '脚本异常', detail: String(err?.stack || err) });
  console.error('\n✗ 脚本异常:', err);
} finally {
  // ─── 清理：停服务 → 关句柄 → 删临时目录（Windows 上句柄不关会 EPERM 删不掉） ───
  if (server) {
    await new Promise(resolve => server.close(resolve));
  }
  // SQLite 与日志流都持有文件句柄，必须先关再删；关不掉只记日志，不让退出码变形。
  try {
    const { getDb } = await import('../src/db.mjs');
    getDb().close();
  } catch { /* 已关闭或不可用 */ }
  try {
    const lg = await import('../src/logger.mjs');
    lg.closeLog?.();
  } catch { /* 忽略 */ }
  await new Promise(r => setTimeout(r, 150));
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (e) {
    console.log(`  [warn] 临时目录未能删除（句柄占用）：${TMP} — ${e.message}`);
  }
  if (fs.existsSync(TMP)) console.log(`  [warn] 残留临时目录（可手动删）：${TMP}`);
}

console.log('\n────────────────────────────────────────────────────────');
console.log(`  P0 门禁结果：通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log('\n  失败明细：');
  for (const f of failures) console.log(`   ✗ ${f.name}${f.detail ? '  → ' + f.detail : ''}`);
  console.log('\n  DNF BRAIN P0 SMOKE FAILED');
  process.exit(1);
}
console.log('  DNF BRAIN P0 SMOKE PASSED ✅');
process.exit(0);
