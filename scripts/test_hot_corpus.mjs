#!/usr/bin/env node
/**
 * test_hot_corpus.mjs —— DNF 恋人伴侣外置语料热更端到端自测
 *
 * 改造说明（2026-10-12，t12）：
 *   ① 原版 `import request from 'supertest'`，但 **supertest 不在 package.json 里**，
 *      未安装即直接 ERR_MODULE_NOT_FOUND → 该自测在干净环境下恒为 exit 1。
 *      现改为"自建 express 实例监听随机端口 + 原生 fetch"，零新增依赖、离线可跑。
 *   ② 原版会**就地改写生产语料** `data/dnf_corpus/peach_corpus.json` 做热更验证，
 *      违反"绝不写生产语料"的隔离要求，且在文件被并发读取时可能留下半写状态。
 *      现改为：通过 `CORPUS_DIR` 指向临时语料目录 + 只读拷贝生产语料，
 *      **全程不触碰 data/dnf_corpus/**。
 *
 * 用法：node scripts/test_hot_corpus.mjs
 * 退出码：0 = 全部通过；1 = 有失败（可直接作为门禁）。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_CORPUS = path.join(ROOT, 'data', 'dnf_corpus');

// ─── 隔离环境（必须在 import src 之前设好） ──────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dnf-hot-corpus-'));
const TMP_CORPUS = path.join(TMP, 'corpus');
fs.mkdirSync(TMP_CORPUS, { recursive: true });
for (const f of fs.readdirSync(REAL_CORPUS)) {
  fs.copyFileSync(path.join(REAL_CORPUS, f), path.join(TMP_CORPUS, f));
}
process.env.DB_PATH = path.join(TMP, 'bot.db');
process.env.CORPUS_DIR = TMP_CORPUS;
process.env.LOG_DIR = path.join(TMP, 'logs');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`); }
}

let server = null;
try {
  const express = (await import('express')).default;
  const { getDb, ensureSleepRow, upsertSleepSchedule } = await import('../src/db.mjs');
  const { gameRouter, peekCorpusCache } = await import('../src/game_dnf.mjs');

  const db = getDb();
  const NPC = '软糖小桃子';
  db.prepare(`INSERT INTO companions (id, user_id, bot_id, name, age, role_title, attachment_style,
      memory_enabled, affection_level, relationship_stage, current_mood, temperature, max_tokens, top_p)
      VALUES (1, NULL, 'dnf-hot-corpus', ?, 20, '女元素', 'secure', 0, 20, '朋友', '平静', 0.8, 320, 0.95)`)
    .run(NPC);
  // 睡眠窗口推到 ≥1h 之后（jitter=0），保证任何时刻跑都不会被睡眠门早退
  ensureSleepRow(1);
  {
    const shNow = new Date(Date.now() + 8 * 3600_000);
    const bedMin = (shNow.getUTCHours() * 60 + shNow.getUTCMinutes() + 60) % 1440;
    const wakeMin = (bedMin + 120) % 1440;
    const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    upsertSleepSchedule(1, { enabled: 1, bed_time: hhmm(bedMin), wake_time: hhmm(wakeMin), jitter_min: 0 });
  }

  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/', gameRouter);
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const chat = async (body) => {
    const r = await fetch(`${base}/game/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };

  console.log('🚀 DNF 恋人伴侣外置语料热更端到端自测（隔离临时语料，不触碰生产）\n');

  // ── 1. 语料各场景命中（走本地兜底分支：无 provider 时在线路径失败 → 本地语料）
  // 小团子也需要一行（同一临时库，仅为让 findCompanion 能命中）
  db.prepare(`INSERT INTO companions (id, user_id, bot_id, name, age, role_title, attachment_style,
      memory_enabled, affection_level, relationship_stage, current_mood, temperature, max_tokens, top_p)
      VALUES (2, NULL, 'dnf-hot-corpus', '奶盖小团子', 20, '女召唤', 'secure', 0, 20, '朋友', '平静', 0.8, 320, 0.95)`)
    .run();

  const scenes = [
    { name: '1. 防 AI 反侦察 [小桃子]', npc: NPC, text: '你是机器人吗？' },
    { name: '2. 作息摸鱼借口 [小团子]', npc: '奶盖小团子', text: '你上课怎么还在玩游戏？' },
    { name: '3. 深渊闪光 [小桃子]', npc: NPC, text: '深渊爆史诗金光啦！' },
    { name: '4. 缺蓝求药 [小团子]', npc: '奶盖小团子', text: '我没蓝了有药吗' },
  ];

  // 隔离自证基线：记下生产语料目录的指纹，收尾时比对"一个字节都没动"
  const prodBefore = fs.readdirSync(REAL_CORPUS).sort()
    .map(f => `${f}:${fs.statSync(path.join(REAL_CORPUS, f)).mtimeMs}:${fs.statSync(path.join(REAL_CORPUS, f)).size}`)
    .join('|');

  for (const s of scenes) {
    const r = await chat({ npc: s.npc, text: s.text });
    console.log(`${s.name}`);
    console.log(`   输入: "${s.text}"`);
    console.log(`   回复: ${r.body.reply}`);
    console.log(`   来源: ${r.body.source}`);
    ok(`${s.name} 返回非空回复`, r.status === 200 && typeof r.body.reply === 'string' && r.body.reply.length > 0);
    ok(`${s.name} source 在契约内`, ['api', 'api_fallback', 'local', 'proactive_shuffle'].includes(r.body.source),
      `source=${r.body.source}`);
  }

  // ── 2. 热更新（不重启进程）：临时语料加一条 → 生效缓存里应立刻出现
  console.log('\n5. 验证零重启热更新 (Hot Reload):');
  const peachPath = path.join(TMP_CORPUS, 'peach_corpus.json');

  // 先确保 peach 语料已进缓存：用**问候短路分支**（!text + event_type=greeting），
  // 它不碰 LLM、确定性地走到 loadCorpusHot。前面几个场景文本可能命中 anti_bot
  // 之类"提前 return"的分支，不能保证语料已被加载（缓存会是 mtime=0）。
  await chat({ npc: NPC, event_type: 'greeting' });
  const warmed = peekCorpusCache('peach');
  ok('前置：peach 语料已进缓存（mtime>0）', Number(warmed?.mtime) > 0, `mtime=${warmed?.mtime}`);

  const original = JSON.parse(fs.readFileSync(peachPath, 'utf-8'));
  const hotTag = `【热更现场验证_${Date.now()}】哥哥我学会新魔法啦！`;
  original.routine = original.routine || {};
  original.routine.in_class = [...(original.routine.in_class || []), hotTag];

  // 原子替换：写临时文件 → 设 mtime → rename（评审 B-4 的 C2 要求，禁就地编辑）
  const tmpWrite = `${peachPath}.tmp_hot`;
  fs.writeFileSync(tmpWrite, JSON.stringify(original, null, 2), 'utf-8');
  const future = new Date(Date.now() + 90_000);
  fs.utimesSync(tmpWrite, future, future);
  const mtimeBefore = peekCorpusCache('peach')?.mtime ?? 0;
  fs.renameSync(tmpWrite, peachPath);

  await chat({ npc: NPC, event_type: 'greeting' });
  const cache = peekCorpusCache('peach');
  ok('热更后缓存 mtime 已变化（未重启进程即重新加载）',
    !!cache && cache.mtime > mtimeBefore, `mtime ${mtimeBefore} → ${cache?.mtime}`);
  ok('热更后的生效语料里包含新写入的条目', !!cache?.data?.routine?.in_class?.includes(hotTag));

  // 恢复临时语料原状（只影响临时目录；生产语料全程未被触碰）
  const restored = JSON.parse(fs.readFileSync(path.join(REAL_CORPUS, 'peach_corpus.json'), 'utf-8'));
  const tmpRestore = `${peachPath}.tmp_restore`;
  fs.writeFileSync(tmpRestore, JSON.stringify(restored, null, 2), 'utf-8');
  fs.renameSync(tmpRestore, peachPath);
  ok('热更验证结束后临时语料已还原', fs.existsSync(peachPath));

  // 隔离自证：生产语料目录指纹必须与开工时逐字节一致
  const prodAfter = fs.readdirSync(REAL_CORPUS).sort()
    .map(f => `${f}:${fs.statSync(path.join(REAL_CORPUS, f)).mtimeMs}:${fs.statSync(path.join(REAL_CORPUS, f)).size}`)
    .join('|');
  ok('生产语料目录未被本次自测修改（隔离自证）', prodBefore === prodAfter);

  console.log('\n✨ 外置语料与热更闭环验证完毕！');
} catch (err) {
  fail++;
  failures.push({ name: '脚本异常', detail: String(err?.stack || err) });
  console.error('\n✗ 脚本异常:', err);
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  try {
    const { getDb } = await import('../src/db.mjs');
    getDb().close();
  } catch { /* ignore */ }
  try {
    const lg = await import('../src/logger.mjs');
    await lg.closeLog?.();
  } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 150));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 句柄占用则跳过 */ }
}

console.log('\n────────────────────────────────────────────────────────');
console.log(`  通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  for (const f of failures) console.log(`   ✗ ${f.name}${f.detail ? '  → ' + f.detail : ''}`);
  console.log('\n  HOT CORPUS TEST FAILED');
  process.exit(1);
}
console.log('  通过');
process.exit(0);
