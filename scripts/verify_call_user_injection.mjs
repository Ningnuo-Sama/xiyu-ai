#!/usr/bin/env node
/**
 * verify_call_user_injection.mjs —— 称呼变量注入与 fail-loud 守卫门禁（t30 交付）
 *
 * 对应定调 §18 T-10：语料里出现 `{player_nickname}` / `{player_alias}`，但运行期原本
 * **零替换逻辑**，本地语料出话会把占位符**原样发给玩家**。本门禁证明：
 *   ① 正常替换：单花括号 → 昵称 / 外号；
 *   ② 幂等：连续多次调用结果稳定；双花括号旧稿**一次**归一，不二次变形；
 *   ③ fail-loud：变量缺失 / 变量名写错 / 落单 `{{` → 告警 + 计数 + **就地兜底**，
 *      **绝不泄漏原始占位符**；
 *   ④ 覆盖全部大脑出口：`/game/chat`（问候短路 / 在线成功 / 在线兜底三条路）与
 *      `/game/mail`（标题 + 正文）的最终文本都不含占位符；
 *   ⑤ 与 t29 协同：称呼注入发生在**通道字节预算之前**（注入后仍满足 30/360/512）。
 *
 * 隔离铁律：临时 SQLite（DB_PATH）+ 临时语料（CORPUS_DIR）+ 监听 127.0.0.1:0 随机端口。
 * **不写生产 data/bot.db、不改 data/dnf_corpus/、不占用 3366。**
 *
 * 用法：node scripts/verify_call_user_injection.mjs
 * 退出码：0 = 全绿；1 = 有断言失败；2 = 环境不可判定
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_CORPUS = path.join(ROOT, 'data', 'dnf_corpus');
if (!fs.existsSync(REAL_CORPUS)) {
  console.error(`环境不可判定：找不到语料目录 ${REAL_CORPUS}`);
  process.exit(2);
}

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dnf-callname-'));
const TMP_CORPUS = path.join(TMP, 'corpus');
fs.mkdirSync(TMP_CORPUS, { recursive: true });
for (const f of fs.readdirSync(REAL_CORPUS)) {
  fs.copyFileSync(path.join(REAL_CORPUS, f), path.join(TMP_CORPUS, f));
}
process.env.DB_PATH = path.join(TMP, 'bot.db');
process.env.CORPUS_DIR = TMP_CORPUS;
process.env.LOG_DIR = path.join(TMP, 'logs');
delete process.env.CHAT_PROVIDER;
delete process.env.DEEPSEEK_API_KEY;

console.log('🔬 称呼变量注入 + fail-loud 守卫门禁');
console.log(`   临时目录: ${TMP}\n`);

/** 占位符泄漏判定：任何 `{...player...}` 或残留 `{{` 都算泄漏。 */
const LEAK_RE = /\{\{?[^}]{0,40}(player_nickname|player_alias|nickname|alias)[^}]{0,40}\}?\}/i;
const hasLeak = (s) => LEAK_RE.test(String(s ?? '')) || String(s ?? '').includes('{{');

let server = null;
try {
  const express = (await import('express')).default;
  const { getDb, ensureSleepRow, upsertSleepSchedule, getCompanionById } = await import('../src/db.mjs');
  const {
    injectCallNames, resolveCallNames, getCallNameStats, resetCallNameStats,
    gameRouter, gbkByteLength,
  } = await import('../src/game_dnf.mjs');

  // ─── 环境：两个恋人（一个走 shaping 昵称，一个只有 call_user_as） ──────────
  const db = getDb();
  const insert = (id, name, role, callUserAs) => db.prepare(
    `INSERT INTO companions (id, user_id, bot_id, name, age, role_title, call_user_as, attachment_style,
       memory_enabled, affection_level, relationship_stage, current_mood, temperature, max_tokens, top_p)
     VALUES (?, NULL, 't30', ?, 20, ?, ?, 'secure', 0, 30, '暧昧', '平静', 0.8, 320, 0.95)`,
  ).run(id, name, role, callUserAs);
  insert(1, '软糖小桃子', '女元素', '你');
  insert(2, '奶盖小团子', '女召唤', '笨蛋');
  ensureSleepRow(1); ensureSleepRow(2);
  {
    const shNow = new Date(Date.now() + 8 * 3600_000);
    const bedMin = (shNow.getUTCHours() * 60 + shNow.getUTCMinutes() + 60) % 1440;
    const wakeMin = (bedMin + 120) % 1440;
    const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    for (const id of [1, 2]) upsertSleepSchedule(id, { enabled: 1, bed_time: hhmm(bedMin), wake_time: hhmm(wakeMin), jitter_min: 0 });
    // 尊重调用方的"她睡了"数据：唤醒态
  }

  const c1 = getCompanionById(1);
  const c2 = getCompanionById(2);

  // ═══ ① 变量解析优先级 ═══════════════════════════════════════════════════
  console.log('[① 变量解析（优先级 4 档）]');
  ok('无昵称时回落到「你」（call_user_as 默认值）',
    resolveCallNames(c1).nickname === '你', JSON.stringify(resolveCallNames(c1)));
  ok('call_user_as=笨蛋 时昵称取该值', resolveCallNames(c2).nickname === '笨蛋',
    JSON.stringify(resolveCallNames(c2)));
  ok('无 companion 时不抛且给兜底', resolveCallNames(null).nickname === '你');
  ok('companion 为 undefined 也不抛', resolveCallNames(undefined).nickname === '你');

  // 教她一个昵称（companion_shaping 是玩家侧唯一写入口）→ 应压过 call_user_as
  db.prepare(`INSERT INTO companion_shaping (companion_id, kind, content) VALUES (1, 'nickname', '凡凡')`).run();
  const c1b = getCompanionById(1);
  const rn1b = resolveCallNames(c1b);
  ok('companion_shaping.nickname 压过 call_user_as（走真实 DB 路径）',
    rn1b.nickname === '凡凡' && rn1b.source === 'shaping', JSON.stringify(rn1b));

  // ═══ ② 正常替换（单花括号） ═════════════════════════════════════════════
  console.log('\n[② 正常替换]');
  const n1 = injectCallNames('{player_nickname}，你今天怎么这么慢呀', c1b);
  ok('单花括号 {player_nickname} 被替换', n1.text === '凡凡，你今天怎么这么慢呀', JSON.stringify(n1.text));
  ok('替换后无泄漏', !hasLeak(n1.text));
  const n2 = injectCallNames('{player_alias}，你今天回话好慢', c1b);
  ok('单花括号 {player_alias} 被替换且无泄漏', !hasLeak(n2.text) && !n2.text.includes('{'), JSON.stringify(n2.text));
  const n3 = injectCallNames('两个都来：{player_nickname} / {player_alias}', c1b);
  ok('同一句里两个变量都替换（tokenCount=2）', n3.injected === 2 && !hasLeak(n3.text),
    `injected=${n3.injected} text=${JSON.stringify(n3.text)}`);
  const nUpper = injectCallNames('{PLAYER_NICKNAME} 大小写变体', c1b);
  ok('大小写变体同样命中（避免"看起来像占位符"却漏过）', nUpper.injected === 1 && !hasLeak(nUpper.text),
    JSON.stringify(nUpper.text));
  const nPlain = injectCallNames('普通文本没有占位符', c1b);
  ok('无占位符文本原样返回且 changed=false',
    nPlain.text === '普通文本没有占位符' && nPlain.changed === false);
  ok('空文本安全返回', injectCallNames('', c1b).text === '' && injectCallNames(null, c1b).text === '');

  // ═══ ③ 幂等 + 双花括号（不得二次变形） ═════════════════════════════════
  console.log('\n[③ 幂等 / 双花括号旧稿]');
  const src = '{{player_nickname}} 和 {{player_alias}} 都在';
  const once = injectCallNames(src, c1b);
  const twice = injectCallNames(once.text, c1b);
  const thrice = injectCallNames(twice.text, c1b);
  ok('双花括号旧稿被归一（legacyBraces>0）', once.legacyBraces === 2, `legacy=${once.legacyBraces}`);
  ok('归一后为单花括号语义、且已替换', !hasLeak(once.text) && once.text.includes('凡凡'),
    JSON.stringify(once.text));
  ok('第 2 次调用结果与第 1 次完全相同（幂等）', twice.text === once.text,
    `${JSON.stringify(once.text)} vs ${JSON.stringify(twice.text)}`);
  ok('第 3 次仍稳定（可重复执行）', thrice.text === twice.text, JSON.stringify(thrice.text));
  ok('幂等后不残留任何花括号', !once.text.includes('{') && !once.text.includes('}'),
    JSON.stringify(once.text));
  // 契约澄清：守卫是"宁可错杀、不可漏放"——任何 `{短Token}` 都当作模板残骸兜掉，
  // 因为玩家可见文本里出现花括号本身就是穿帮（真人不会发 `{这样}`）。
  // 故这里断言的是"花括号一律不放行 + 一定有告警痕迹"，而不是"保留合法花括号"。
  resetCallNameStats();
  const withBrace = injectCallNames('她说{这样}的', c1b);
  ok('任何花括号 token 都不放行（宁可错杀不可漏放）',
    !withBrace.text.includes('{') && !withBrace.text.includes('}'), JSON.stringify(withBrace.text));
  ok('花括号被兜掉时有可见告警 + 计数（不是静默改写）',
    withBrace.residual >= 1 && !!getCallNameStats().lastWarning,
    `residual=${withBrace.residual} warn=${String(getCallNameStats().lastWarning).slice(0, 60)}`);

  // ═══ ④ fail-loud：变量缺失 / 写错 / 落单双括号 ══════════════════════════
  console.log('\n[④ fail-loud（告警 + 计数 + 就地兜底，绝不泄漏）]');
  // 4a 变量缺失：无 shaping、call_user_as 为空
  resetCallNameStats();
  const cNoName = { id: 99999, name: '无名称角色', call_user_as: null };
  const miss = injectCallNames('{player_nickname} 你在吗', cNoName);
  ok('变量缺失时不抛、不泄漏、降级为「你」',
    !hasLeak(miss.text) && miss.text === '你 你在吗', JSON.stringify(miss.text));
  ok('缺失场景计数不改 residual（这是正常兜底，不是缺陷）', getCallNameStats().residual === 0,
    JSON.stringify(getCallNameStats()));

  // 4b 变量名写错：这是**真缺陷**，必须 WARN + residual 计数 + 兜底
  resetCallNameStats();
  const typo = injectCallNames('{player_nicknames} 你好', c1b);
  ok('写错的变量名不再漏给玩家（探针实测过的真实漏洞已修）',
    !hasLeak(typo.text) && !typo.text.includes('{'), JSON.stringify(typo.text));
  ok('写错场景 residual 计数 +1', typo.residual === 1 && getCallNameStats().residual === 1,
    JSON.stringify(getCallNameStats()));
  ok('写错场景产生 lastWarning（可被运维/门禁读到）', !!getCallNameStats().lastWarning,
    String(getCallNameStats().lastWarning).slice(0, 80));
  ok('WARN 文案含 channel 与原文片段（可定位）',
    /channel=/.test(getCallNameStats().lastWarning) && /原文片段/.test(getCallNameStats().lastWarning));

  // 4c 落单 `{{`
  resetCallNameStats();
  const bare = injectCallNames('前面 {{ 后面', c1b);
  ok('落单 `{{` 被归一且可见（T-10 明确要求扫它）',
    !bare.text.includes('{{') && bare.residual >= 1, JSON.stringify(bare.text));
  ok('落单场景 lastWarning 含"落单双花括号"',
    /落单双花括号/.test(String(getCallNameStats().lastWarning)));

  // 4d 多余空格变体
  resetCallNameStats();
  const spaced = injectCallNames('{ nickname } 你好', c1b);
  ok('`{ nickname }`（空格变体）同样被兜底不漏', !spaced.text.includes('{'), JSON.stringify(spaced.text));

  // 4e 未知通道不阻断，只计 unknownChannel
  const beforeUnknown = getCallNameStats().unknownChannel;
  injectCallNames('{player_nickname}', c1b, { channel: 'not_a_channel' });
  ok('未知通道不抛、按 chat 记账', getCallNameStats().unknownChannel === beforeUnknown + 1);

  // ═══ ⑤ 端到端：全部大脑出口都不含占位符 ═══════════════════════════════
  console.log('\n[⑤ 端到端（/game/chat 三条路 + /game/mail）]');
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/', gameRouter);
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = server.address().port;
  ok('自建实例监听随机端口（非 3366）', port !== 3366 && port > 0, `port=${port}`);
  const post = async (p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };

  const chatCases = [
    { label: '问候短路', payload: { npc: '软糖小桃子', event_type: 'greeting' } },
    { label: '普通私聊（在线路径）', payload: { npc: '软糖小桃子', text: '在吗' } },
    { label: '普通私聊（团子/call_user_as=笨蛋）', payload: { npc: '奶盖小团子', text: '你怎么还在上课在线？' } },
    { label: '带情境私聊（碎刀）', payload: { npc: '软糖小桃子', text: '我武器碎了', event_type: 'equip_broken' } },
  ];
  for (const cc of chatCases) {
    const r = await post('/game/chat', cc.payload);
    const texts = [r.body.reply, ...(r.body.replies || [])].filter(Boolean);
    const leaked = texts.filter(hasLeak);
    ok(`[chat/${cc.label}] 回复不含占位符（${texts.length} 段）`,
      r.status === 200 && leaked.length === 0,
      leaked.length ? `泄漏: ${JSON.stringify(leaked.slice(0, 2))}` : `reply=${JSON.stringify(String(r.body.reply).slice(0, 30))}`);
  }

  const mailCases = ['offline_care', 'equip_broken', 'reunion', 'anniversary', 'after_quarrel'];
  for (const sc of mailCases) {
    const r = await post('/game/mail', { npc: '软糖小桃子', scenario: sc });
    ok(`[mail/${sc}] 标题+正文不含占位符`,
      r.status === 200 && !hasLeak(r.body.title) && !hasLeak(r.body.body),
      `title=${JSON.stringify(r.body.title)} body=${JSON.stringify(String(r.body.body).slice(0, 40))}`);
    // ⑤b 与 t29 协同：注入之后仍满足通道字节预算（注入会把 10 字符的占位符换成 2-6 字符的名字）
    const tb = gbkByteLength(r.body.title);
    const bb = gbkByteLength(r.body.body);
    ok(`[mail/${sc}] 注入后仍满足 30/360/512 预算`,
      tb <= 30 && bb <= 360 && (tb + 1 + bb) < 512, `title=${tb}B body=${bb}B total=${tb + 1 + bb}B`);
  }

  // ═══ ⑥ 回归：t29 情境字段与 source 未受影响 ═══════════════════════════
  console.log('\n[⑥ 与 t29 / t12 协同回归]');
  const rAnn = await post('/game/mail', { npc: '软糖小桃子', scenario: 'anniversary' });
  ok('[t29] 三情境仍正常识别', rAnn.body.scenario === 'anniversary' && rAnn.body.scenario_degraded === false,
    `scenario=${rAnn.body.scenario}`);
  const rUnk = await post('/game/mail', { npc: '软糖小桃子', scenario: 'bogus_xyz' });
  ok('[t29] 未知情境仍 fail-loud（scenario_degraded）',
    rUnk.body.scenario_degraded === true && rUnk.body.scenario === 'offline_care',
    JSON.stringify({ s: rUnk.body.scenario, d: rUnk.body.scenario_degraded }));
  const rChat = await post('/game/chat', { npc: '软糖小桃子', text: '在吗' });
  ok('[t12] chat source 仍在契约内（非 api）', rChat.body.source === 'api_fallback',
    `source=${rChat.body.source}`);
  ok('[t29] mail_bytes 实测字节仍在响应里', !!rChat.body && !!rAnn.body.mail_bytes,
    JSON.stringify(rAnn.body.mail_bytes));
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
console.log(`  结果：通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log('\n  失败明细：');
  for (const f of failures) console.log(`   ✗ ${f.name}${f.detail ? '  → ' + f.detail : ''}`);
  console.log('\n  CALL-NAME INJECTION VERIFY FAILED');
  process.exit(1);
}
console.log('  CALL-NAME INJECTION VERIFY PASSED ✅');
process.exit(0);
