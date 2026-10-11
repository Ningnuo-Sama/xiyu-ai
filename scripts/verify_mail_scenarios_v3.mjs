#!/usr/bin/env node
/**
 * verify_mail_scenarios_v3.mjs —— 邮件情境 v3 注册与"未知情境 fail-loud"门禁（t29 交付）
 *
 * 对应定调 §18 T-7：语料 v3 新增 `reunion / anniversary / after_quarrel` 三情境，
 * 大脑侧必须注册；且**未知情境不得再静默落默认礼物**，必须 WARN + 计数 + 响应降级标记。
 *
 * 覆盖七组断言：
 *   ① 三情境已注册：`resolveMailScenario` 对三个规范值逐一命中（不是回落）
 *   ② 与语料一一对应：代码里注册的情景名 ⊇ 语料 `mail_templates` 里出现的 scenario
 *   ③ 附件策略在白名单内：三情境选出的 item_id 必须∈语料白名单，且**不得是高强武器**
 *   ④ 未知情境 fail-loud：WARN 含收到原值 + 计数器递增 + 返回哨兵 + 消费侧安全兜底
 *   ⑤ 邮件通道三约束：标题 ≤30B、正文 ≤360B、`Subject + '\n' + Body < 512B`（实测字节）
 *   ⑥ 端到端：临时服务上打 `/game/mail`，三情境 `scenario` 与附件正确；未知情境响应带
 *      `scenario_degraded:true` + `scenario_degraded_reason`
 *   ⑦ 回归：无情境（"没说"）仍平静回落 offline_care，**不得**被误标为降级
 *
 * 隔离铁律：临时 SQLite（DB_PATH）+ 临时语料（CORPUS_DIR）+ 监听 127.0.0.1:0 随机端口。
 * **不写生产 data/bot.db、不改 data/dnf_corpus/、不占用 3366。**
 *
 * 用法：node scripts/verify_mail_scenarios_v3.mjs
 * 退出码：0 = 全绿；1 = 有断言失败；2 = 环境不可判定（语料缺失等）
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_CORPUS = path.join(ROOT, 'data', 'dnf_corpus');
// 语料 v3 源文件在**另一个仓库**（dnf-robot-act12），只读消费；缺失则跳过"与语料对齐"断言
const V3_CORPUS = path.resolve(ROOT, '..', 'dnf-robot-act12', 'doc', 'lovers', '语料v3-软糖小桃子-2026-10-12.json');

// ─── 邮件通道硬约束（越界 → 客户端开信箱报错误 17） ──────────────────────────
const LIMITS = { titleBytes: 30, bodyBytes: 360, subjectPlusBodyBytes: 512 };
// t41 修正：通道预算是 **GBK(CP936)** 口径（客户端是 GBK），不是 UTF-8。
// 原实现这里是 `Buffer.byteLength(s,'utf8')`——对短 v1 标题恰好也能过，但 v3 标题更长
// （如 anniversary 的 title），UTF-8 口径会比 GBK 多算 1B/汉字 → 出现"模块按 GBK 没截断、
// 断言按 UTF-8 说越界"的**假红**。这正是任务警示的"静默按 UTF-8 计"陷阱。
// 声明为 `let`：真正的实现要在**动态 import 之后**才能绑上（env 必须先就位），
// 届时改为模块导出的 `gbkByteLength`（其 CP936 一致性已对 4478 条语料字符串交叉验证）。
// 不在此处赋初值：真正的实现要在**动态 import 之后**才能绑上（env 必须先就位），
// 赋了也会被立刻覆盖（eslint no-useless-assignment）。绑定见下方 `b = gbkByteLength`。
let b;

let pass = 0, fail = 0, skip = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`); }
}
function skipped(name, why) { skip++; console.log(`  ⊘ ${name}（跳过：${why}）`); }

// ─── 隔离环境（必须在 import src 之前设好 env） ──────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dnf-mail-v3-'));
const TMP_CORPUS = path.join(TMP, 'corpus');
fs.mkdirSync(TMP_CORPUS, { recursive: true });
if (!fs.existsSync(REAL_CORPUS)) {
  console.error(`环境不可判定：找不到生产语料目录 ${REAL_CORPUS}`);
  process.exit(2);
}
for (const f of fs.readdirSync(REAL_CORPUS)) {
  fs.copyFileSync(path.join(REAL_CORPUS, f), path.join(TMP_CORPUS, f));
}
process.env.DB_PATH = path.join(TMP, 'bot.db');
process.env.CORPUS_DIR = TMP_CORPUS;
process.env.LOG_DIR = path.join(TMP, 'logs');
delete process.env.CHAT_PROVIDER;          // 确保走本地保底，邮件正文可预期
delete process.env.DEEPSEEK_API_KEY;

console.log('🔬 邮件情境 v3 注册 + 未知情境 fail-loud 门禁');
console.log(`   临时目录: ${TMP}`);
console.log(`   语料 v3 : ${fs.existsSync(V3_CORPUS) ? V3_CORPUS : '（缺失，将对齐断言跳过）'}\n`);

let server = null;
try {
  const express = (await import('express')).default;
  const { getDb, ensureSleepRow, upsertSleepSchedule } = await import('../src/db.mjs');
  const {
    MAIL_SCENARIOS, MAIL_SCENARIO_UNKNOWN,
    resolveMailScenario, selectMailGift, getMailGiftList,
    getMailScenarioStats, getRegisteredScenarioIds,
    resolveMailDialogue, gbkByteLength,
    gameRouter,
  } = await import('../src/game_dnf.mjs');

  const V3_SCENARIOS = ['reunion', 'anniversary', 'after_quarrel'];
  const V1_SCENARIOS = ['equip_broken', 'offline_care', 'abyss_blank'];
  // 通道预算断言改用 GBK(CP936) 口径（与模块的 enforceMailChannelLimits 同口径）
  b = (s) => gbkByteLength(s);

  // ═══ ① 三情境已注册（解析层） ═══════════════════════════════════════════
  console.log('[① 三情境注册（resolveMailScenario）]');
  for (const s of V3_SCENARIOS) {
    const r = resolveMailScenario({ scenario: s });
    ok(`scenario="${s}" 解析为 ${s}（非回落）`, r === s, `实际=${r}`);
    const viaEvent = resolveMailScenario({ eventType: s });
    ok(`eventType="${s}" 同样命中`, viaEvent === s, `实际=${viaEvent}`);
  }
  ok('MAIL_SCENARIOS 导出含三新情境',
    V3_SCENARIOS.every(s => Object.values(MAIL_SCENARIOS).includes(s)),
    JSON.stringify(MAIL_SCENARIOS));

  // ═══ ② 与语料 mail_templates 的 scenario 字段一一对应 ═══════════════════
  console.log('\n[② 代码情景名 ⊇ 语料 scenario 字段]');
  const reg = getRegisteredScenarioIds();
  const prodTemplates = JSON.parse(fs.readFileSync(path.join(REAL_CORPUS, 'mail_templates.json'), 'utf8'));
  const prodScenarios = [...new Set(prodTemplates.map(t => t.scenario).filter(Boolean))];
  const missingProd = prodScenarios.filter(s => !reg.known.includes(s));
  ok('生产语料的每个 scenario 都已在代码注册', missingProd.length === 0,
    missingProd.length ? `缺: ${missingProd.join(', ')}` : `语料 ${prodScenarios.length} 个全部命中`);

  if (fs.existsSync(V3_CORPUS)) {
    const v3 = JSON.parse(fs.readFileSync(V3_CORPUS, 'utf8'));
    const v3Scenarios = [...new Set((v3.mail_templates || []).map(t => t.scenario).filter(Boolean))];
    const missingV3 = v3Scenarios.filter(s => !reg.known.includes(s));
    ok('语料 v3 的每个 scenario 都已在代码注册', missingV3.length === 0,
      missingV3.length ? `缺: ${missingV3.join(', ')}` : `v3 ${v3Scenarios.length} 个全部命中（${v3Scenarios.join(', ')}）`);
    // 三新情境确实来自 v3（证明不是我们凭空造的枚举）
    const newInV3 = V3_SCENARIOS.filter(s => v3Scenarios.includes(s));
    ok('三新情境确实出现在语料 v3 的 mail_templates 里', newInV3.length === 3,
      `命中 ${newInV3.join(', ')}`);
  } else {
    skipped('语料 v3 对齐断言', '未找到 v3 语料文件（跨仓库路径）');
  }

  // ═══ ③ 附件策略：白名单内 + 非高强武器 ═════════════════════════════════
  console.log('\n[③ 三情境附件策略（白名单内 / 不落高强武器）]');
  const gifts = getMailGiftList();
  const whitelistIds = new Set(gifts.map(g => g.item_id));
  ok('生产白名单已加载（7 条）', gifts.length > 0, `count=${gifts.length}`);
  const giftByScenario = {};
  for (const s of V3_SCENARIOS) {
    const g = selectMailGift({ scenario: s });
    giftByScenario[s] = g;
    ok(`${s} 选出礼物且 item_id 在白名单内`, whitelistIds.has(g.item_id),
      `item_id=${g.item_id} (${g.name})`);
    ok(`${s} 不落高强武器`, g.category !== 'pad_weapon' && (g.upgrade_level || 0) === 0,
      `category=${g.category} upgrade=${g.upgrade_level || 0}`);
    ok(`${s} 礼物带完整附件字段`,
      Number.isInteger(g.item_id) && Number.isInteger(g.count) && typeof g.category === 'string',
      JSON.stringify({ item_id: g.item_id, count: g.count, category: g.category }));
  }
  // 三情境的取向应贴合语料（reunion→recovery、anniversary→cube、after_quarrel→special）
  ok('reunion 默认取向 recovery（与 v3 语料 5/5 条一致）', giftByScenario.reunion.category === 'recovery',
    `实际=${giftByScenario.reunion.category}`);
  ok('anniversary 默认取向 cube（与 v3 语料主项一致）', giftByScenario.anniversary.category === 'cube',
    `实际=${giftByScenario.anniversary.category}`);
  ok('after_quarrel 默认取向 special（与 v3 语料"台阶"一致）', giftByScenario.after_quarrel.category === 'special',
    `实际=${giftByScenario.after_quarrel.category}`);

  // 显式 attach_item_id 仍最优先（既有语义不许回归）
  const explicit = selectMailGift({ scenario: MAIL_SCENARIOS.REUNION, targetItemId: 1070 });
  ok('显式 targetItemId 仍最优先（不因新情境失效）', explicit.item_id === 1070,
    `实际=${explicit.item_id}`);

  // ═══ ④ 未知情境 fail-loud ══════════════════════════════════════════════
  console.log('\n[④ 未知情境 fail-loud]');
  const BOGUS = 'totally_bogus_scenario_xyz';
  const statsBefore = getMailScenarioStats();
  const resolvedUnknown = resolveMailScenario({ scenario: BOGUS });
  const statsAfter = getMailScenarioStats();
  ok('未知情境返回哨兵（不冒充任何正常情境）', resolvedUnknown === MAIL_SCENARIO_UNKNOWN,
    `实际=${resolvedUnknown}`);
  ok('未知情境计数器 +1', statsAfter.unknown === statsBefore.unknown + 1,
    `${statsBefore.unknown} → ${statsAfter.unknown}`);
  ok('未知情境原值被记账（可定位是谁传的）',
    statsAfter.unknownValues[BOGUS] === 1, JSON.stringify(statsAfter.unknownValues));
  ok('未知情境仍能选出安全礼物（不抛、不落武器）',
    (() => { const g = selectMailGift({ scenario: resolvedUnknown }); return whitelistIds.has(g.item_id) && g.category !== 'pad_weapon'; })());
  // 多次未知值各自独立计数
  resolveMailScenario({ scenario: 'another_bogus_one' });
  const stats3 = getMailScenarioStats();
  ok('不同未知值分别计数', !!stats3.unknownValues['another_bogus_one'] && stats3.unknownValues[BOGUS] === 1,
    JSON.stringify(stats3.unknownValues));

  // ═══ ⑤ 邮件通道三约束（实测字节） ═══════════════════════════════════════
  console.log('\n[⑤ 邮件通道长度约束（实测字节）]');
  const measured = [];
  for (const g of gifts) {
    const title = String(g.dialogue?.title ?? '');
    const body = String(g.dialogue?.peach ?? '');
    const sum = b(title) + b('\n') + b(body);
    measured.push({ item: g.name, titleB: b(title), bodyB: b(body), sumB: sum });
    ok(`[${g.scenario}] "${title}" 标题 ≤${LIMITS.titleBytes}B`, b(title) <= LIMITS.titleBytes, `实测 ${b(title)}B`);
    ok(`[${g.scenario}] 正文 ≤${LIMITS.bodyBytes}B`, b(body) <= LIMITS.bodyBytes, `实测 ${b(body)}B`);
    ok(`[${g.scenario}] Subject+\\n+Body < ${LIMITS.subjectPlusBodyBytes}B`, sum < LIMITS.subjectPlusBodyBytes, `实测 ${sum}B`);
  }
  const worst = measured.reduce((a, x) => (x.sumB > a.sumB ? x : a), measured[0]);
  console.log(`   [字节汇总] 最宽一条：${worst.item} 标题 ${worst.titleB}B / 正文 ${worst.bodyB}B / 合计 ${worst.sumB}B`);

  // ═══ ⑥ 端到端：临时服务上打 /game/mail ═════════════════════════════════
  console.log('\n[⑥ 端到端 /game/mail（隔离临时库 + 随机端口）]');
  const db = getDb();
  const NPC = '软糖小桃子';
  db.prepare(`INSERT INTO companions (id, user_id, bot_id, name, age, role_title, attachment_style,
      memory_enabled, affection_level, relationship_stage, current_mood, temperature, max_tokens, top_p)
      VALUES (1, NULL, 'dnf-mail-v3', ?, 20, '女元素', 'secure', 0, 30, '暧昧', '平静', 0.8, 320, 0.95)`)
    .run(NPC);
  // t41：U5 需要按角色验证"三分支"，故三人设都要播种（黑咖是原实现串味的那一位）
  db.prepare(`INSERT INTO companions (id, user_id, bot_id, name, age, role_title, attachment_style,
      memory_enabled, affection_level, relationship_stage, current_mood, temperature, max_tokens, top_p)
      VALUES (2, NULL, 'dnf-mail-v3', '奶盖小团子', 20, '女召唤', 'secure', 0, 30, '暧昧', '平静', 0.8, 320, 0.95)`)
    .run();
  db.prepare(`INSERT INTO companions (id, user_id, bot_id, name, age, role_title, attachment_style,
      memory_enabled, affection_level, relationship_stage, current_mood, temperature, max_tokens, top_p)
      VALUES (3, NULL, 'dnf-mail-v3', '黑咖小助手', 20, '女魔道', 'secure', 0, 30, '暧昧', '平静', 0.8, 320, 0.95)`)
    .run();
  for (const id of [1, 2, 3]) {
    ensureSleepRow(id);
    // 睡眠窗一律推到未来（含清 today_* 缓存），避免墙钟落窗时邮件被睡眠门拦截
    const shNow = new Date(Date.now() + 8 * 3600_000);
    const bedMin = (shNow.getUTCHours() * 60 + shNow.getUTCMinutes() + 60) % 1440;
    const wakeMin = (bedMin + 120) % 1440;
    const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    upsertSleepSchedule(id, {
      enabled: 1, bed_time: hhmm(bedMin), wake_time: hhmm(wakeMin), jitter_min: 0,
      today_date: null, today_bed_at: null, today_wake_at: null,
    });
  }
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/', gameRouter);
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  ok('自建实例监听随机端口（非 3366）', port !== 3366 && port > 0, `port=${port}`);
  const postMail = async (payload) => {
    const r = await fetch(`http://127.0.0.1:${port}/game/mail`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    return { status: r.status, body: await r.json() };
  };

  for (const s of V3_SCENARIOS) {
    const r = await postMail({ npc: NPC, scenario: s });
    ok(`[HTTP] scenario=${s} 响应 scenario 字段正确`, r.body.scenario === s, `实际=${r.body.scenario}`);
    ok(`[HTTP] scenario=${s} 未被标降级`, r.body.scenario_degraded === false, `实际=${r.body.scenario_degraded}`);
    ok(`[HTTP] scenario=${s} 附件 item_id 与本地策略一致`,
      r.body.attachment?.item_id === giftByScenario[s].item_id,
      `HTTP=${r.body.attachment?.item_id} 本地=${giftByScenario[s].item_id}`);
    ok(`[HTTP] scenario=${s} 标题/正文实测未越界`,
      b(r.body.title) <= LIMITS.titleBytes
      && b(r.body.body) <= LIMITS.bodyBytes
      && (b(r.body.title) + 1 + b(r.body.body)) < LIMITS.subjectPlusBodyBytes,
      `标题 ${b(r.body.title)}B / 正文 ${b(r.body.body)}B / 合计 ${b(r.body.title) + 1 + b(r.body.body)}B`);
  }

  // 未知情境：HTTP 层必须体现可见降级
  const rUnknown = await postMail({ npc: NPC, scenario: BOGUS });
  ok('[HTTP] 未知情境请求仍 200（不炸）', rUnknown.status === 200, `status=${rUnknown.status}`);
  ok('[HTTP] 未知情境 scenario 归一为 offline_care', rUnknown.body.scenario === 'offline_care',
    `实际=${rUnknown.body.scenario}`);
  ok('[HTTP] 未知情境带 scenario_degraded:true（可见降级）', rUnknown.body.scenario_degraded === true,
    `实际=${rUnknown.body.scenario_degraded}`);
  ok('[HTTP] 未知情境带降级原因', rUnknown.body.scenario_degraded_reason === 'unknown_scenario_not_registered',
    `实际=${rUnknown.body.scenario_degraded_reason}`);
  ok('[HTTP] 未知情境回显收到的原值（便于定位）', rUnknown.body.scenario_input === BOGUS,
    `实际=${rUnknown.body.scenario_input}`);
  ok('[HTTP] 未知情境附件仍安全（非高强武器）',
    rUnknown.body.attachment?.category !== 'pad_weapon' && (rUnknown.body.attachment?.upgrade_level || 0) === 0,
    JSON.stringify(rUnknown.body.attachment));

  // ═══ ⑦ 回归：无情境是"没说"，不得误标降级 ═══════════════════════════════
  console.log('\n[⑦ 回归：无情境 ≠ 未知情境]');
  const rNoScenario = await postMail({ npc: NPC });
  ok('[HTTP] 无情境仍回落 offline_care', rNoScenario.body.scenario === 'offline_care',
    `实际=${rNoScenario.body.scenario}`);
  ok('[HTTP] 无情境**不**标降级（没说 ≠ 说错）', rNoScenario.body.scenario_degraded === false,
    `实际=${rNoScenario.body.scenario_degraded}`);
  ok('[HTTP] 无情境不回显 input', rNoScenario.body.scenario_input === null,
    `实际=${rNoScenario.body.scenario_input}`);
  // 旧三情境不许回归
  for (const s of V1_SCENARIOS) {
    const r = await postMail({ npc: NPC, scenario: s });
    ok(`[回归] 旧情境 ${s} 仍正常且不标降级`,
      r.body.scenario === s && r.body.scenario_degraded === false, `实际=${r.body.scenario}`);
  }
  // hint 路径也要能命中三新情境
  const rHint = await postMail({ npc: NPC, hint: '好久不见，我终于回来了' });
  ok('[回归] hint 识别重逢情境', rHint.body.scenario === 'reunion', `实际=${rHint.body.scenario}`);

  // ═══ ⑧ t41 U4/U5：三新情境的 **v3 正文可达** + heika 不串味 ═════════════
  // 背景（实测）：`mail_templates.json` 里 v3 三情境是**空正文占位条目**（三槽长度 0），
  // v3 正文按角色落在 `{role}_corpus.json` 的 `mail_templates`（peach 42 / heika 46 / **tuanzi 0**）。
  // 故 U4 分两步：①按 scenario 优先过滤（否则被 v1 的 offline_care 抢先）；②正文按角色回填。
  console.log('\n[⑧ t41 U4/U5：v3 正文可达 + 角色不串味]');

  const roleCorpus = (role) => {
    const p = path.join(TMP_CORPUS, `${role}_corpus.json`);
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(j.mail_templates) ? j.mail_templates : [];
  };
  const flatIndex = JSON.parse(fs.readFileSync(path.join(TMP_CORPUS, 'mail_templates.json'), 'utf8'));

  for (const sc of V3_SCENARIOS) {
    // U4-① 场景优先过滤：选中的条目 scenario 字段必须自洽（旧实现会回显 offline_care）
    const gift = selectMailGift({ scenario: sc });
    ok(`[U4] ${sc} 选中的条目 scenario 自洽（不再被 v1 抢先）`,
      gift.scenario === sc, `实际=${gift.scenario}`);
    // 前置：索引里该情境确实是空正文占位（证明"只改过滤"是不够的，必须角色回填）
    const stub = flatIndex.find(e => e.scenario === sc);
    ok(`[U4] 前置：索引里 ${sc} 是空正文占位（故必须角色回填）`,
      !!stub && ['peach', 'tuanzi', 'heika'].every(r => String(stub.dialogue?.[r] || '') === ''),
      stub ? JSON.stringify(stub.dialogue) : '未找到条目');

    // U4-② peach / heika 必须有**本角色本情境**的 v3 正文（来自角色语料，非索引占位）
    for (const role of ['peach', 'heika']) {
      const d = resolveMailDialogue(gift, role, sc);
      const pool = roleCorpus(role).filter(e => e.scenario === sc).map(e => String(e.dialogue?.[role] || ''));
      ok(`[U4] ${sc}/${role} 正文来自角色语料（v3 可达）`,
        d.source === 'role_corpus_scoped' && d.degraded === false && d.body.length > 0,
        `source=${d.source} degraded=${d.degraded} len=${d.body.length}`);
      ok(`[U4] ${sc}/${role} 正文逐字命中该角色语料的 ${sc} 池`,
        pool.includes(d.body), `pool=${pool.length} 条`);
    }

    // U5：heika 与 peach 的正文**必须不同**（原实现 heika 取 peach → 串味）
    const dPeach = resolveMailDialogue(gift, 'peach', sc);
    const dHeika = resolveMailDialogue(gift, 'heika', sc);
    ok(`[U5] ${sc}：heika 正文 ≠ peach 正文（不串味）`,
      dHeika.body !== dPeach.body && dHeika.body.length > 0,
      `heika=${JSON.stringify(dHeika.body.slice(0, 24))} peach=${JSON.stringify(dPeach.body.slice(0, 24))}`);

    // tuanzi 的 v3 正文确实缺失 → 必须**角色正确 + 可见降级**，绝不发空正文
    const dTuanzi = resolveMailDialogue(gift, 'tuanzi', sc);
    ok(`[U4/${sc}] tuanzi 无 v3 正文时不发空正文（降级可见）`,
      dTuanzi.body.length > 0 && dTuanzi.degraded === true,
      `source=${dTuanzi.source} degraded=${dTuanzi.degraded} len=${dTuanzi.body.length}`);
    ok(`[U4/${sc}] tuanzi 降级时仍取**tuanzi 自己**的文案（角色不串味）`,
      /(泉水|圣经|无色|垫|笨|刷图|图)/.test(dTuanzi.body), JSON.stringify(dTuanzi.body.slice(0, 40)));
  }

  // 端到端：黑咖私聊 → /game/mail 正文必须与桃子的不同（U5 的行为级证据）
  for (const sc of V3_SCENARIOS) {
    const rPeach = await postMail({ npc: '软糖小桃子', scenario: sc });
    const rHeika = await postMail({ npc: '黑咖小助手', scenario: sc });
    ok(`[U5][HTTP] ${sc}：黑咖与桃子的邮件正文不同`,
      rHeika.body.body !== rPeach.body.body
      && (rHeika.body.body || '').length > 0 && (rPeach.body.body || '').length > 0,
      `heika=${JSON.stringify(String(rHeika.body.body).slice(0, 20))} peach=${JSON.stringify(String(rPeach.body.body).slice(0, 20))}`);
    ok(`[U5][HTTP] ${sc}：响应透出正文角色与来源`,
      rHeika.body.mail_text_role === 'heika' && typeof rHeika.body.mail_text_source === 'string',
      `role=${rHeika.body.mail_text_role} source=${rHeika.body.mail_text_source}`);
    ok(`[U5][HTTP] ${sc}：黑咖未走 peach 回退`,
      rHeika.body.mail_text_source !== 'index_peach_fallback',
      `source=${rHeika.body.mail_text_source}`);
    // tuanzi：v3 正文缺失 → 必须**角色正确 + 降级可见**（消费方能识别，不是静默）
    const rTuanzi = await postMail({ npc: '奶盖小团子', scenario: sc });
    ok(`[U4][HTTP] ${sc}：团子降级可见（mail_text_degraded=true）且角色自洽`,
      rTuanzi.body.mail_text_degraded === true
      && rTuanzi.body.mail_text_role === 'tuanzi'
      && (rTuanzi.body.body || '').length > 0,
      `degraded=${rTuanzi.body.mail_text_degraded} role=${rTuanzi.body.mail_text_role} src=${rTuanzi.body.mail_text_source}`);
    ok(`[U4][HTTP] ${sc}：团子正文 ≠ 桃子正文（降级也不串味）`,
      rTuanzi.body.body !== rPeach.body.body,
      `tuanzi=${JSON.stringify(String(rTuanzi.body.body).slice(0, 18))}`);
  }

  // GBK 计数器口径自证：Node 的 Buffer.byteLength(s,'gbk') 会静默按 UTF-8 计（中文 3B/字），
  // 本项目的手写计数器按 CP936 口径（中文 2B/字）。这里锁住"没被改成 UTF-8 口径"。
  {
    ok('[GBK] 计数器按 CP936 口径（中文 2B/字，不是 UTF-8 的 3B）',
      gbkByteLength('天空之城泉水') === 12 && gbkByteLength('中文a1') === 6,
      `天空之城泉水=${gbkByteLength('天空之城泉水')} 中文a1=${gbkByteLength('中文a1')}`);
    ok('[GBK] 计数器与 Buffer.byteLength(...,"utf8") 的口径确实不同（防静默退化）',
      gbkByteLength('中文') === 4 && Buffer.byteLength('中文', 'utf8') === 6,
      `gbk口径=${gbkByteLength('中文')} utf8=${Buffer.byteLength('中文', 'utf8')}`);
  }
} catch (err) {
  fail++;
  failures.push({ name: '脚本异常', detail: String(err?.stack || err) });
  console.error('\n✗ 脚本异常:', err);
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { const { getDb } = await import('../src/db.mjs'); getDb().close(); } catch { /* ignore */ }
  try { const lg = await import('../src/logger.mjs'); await lg.closeLog?.(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 150));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 句柄占用则跳过 */ }
  if (fs.existsSync(TMP)) console.log(`  [warn] 残留临时目录（可手动删）：${TMP}`);
}

console.log('\n────────────────────────────────────────────────────────');
console.log(`  结果：通过 ${pass} / 失败 ${fail} / 跳过 ${skip}`);
if (fail > 0) {
  console.log('\n  失败明细：');
  for (const f of failures) console.log(`   ✗ ${f.name}${f.detail ? '  → ' + f.detail : ''}`);
  console.log('\n  MAIL SCENARIOS V3 VERIFY FAILED');
  process.exit(1);
}
console.log('  MAIL SCENARIOS V3 VERIFY PASSED ✅');
process.exit(0);
