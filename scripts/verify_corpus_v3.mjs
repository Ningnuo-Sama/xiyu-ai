#!/usr/bin/env node
/**
 * scripts/verify_corpus_v3.mjs —— 语料 v3 归一校验器（t19 交付物）
 *
 * 唯一门禁口径：doc/lovers/恋人语料硬红线与允许口径-2026-10-12.md（A/B/C/D/E/F 六类 + 三条纠错 + 单段 ≤58B）
 * **权威范围（必读）**：**玩家可见源 = `xiyu-ai/data/dnf_corpus/**`**（本校验器默认/`--prod` 校验的就是它）。
 *    Go 侧那两池（硬编码兜底）门禁只是**补充**——Go 两池全绿 **不等于**玩家看不到风险，
 *    因为 `getLocalGamerGirlReply` / `getMailGiftList` **优先读热语料**。任何"语料合规"结论必须以本校验器为准。
 * 设计要点（对应 t19 契约与 t33 审计结论）：
 *   · schema-aware：按容器分类执行预算，**元数据容器完全豁免长度**；不认识 schema → 不可判定（非 0）
 *   · 声明 vs 使用：`forbidden_address` / `fingerprint` / `self_describe` 等**声明性容器**先剔除再扫对白域
 *   · D-1 真元词汇：先做角色名白名单；D-2 反 AI 侦察反击句按语境豁免（红线 §4）
 *   · 结构兼容：与 v1 基线（备份目录）逐 key 比对类型 —— 加载器按键名取值
 *   · t37 八门禁 G-K1..G-K8：G-K7（配额实测/事后滑窗）为运行时项 → DEFERRED（--strict 时计非 0）
 *
 * 用法：
 *   node scripts/verify_corpus_v3.mjs                  # 校验暂存目录（默认）
 *   node scripts/verify_corpus_v3.mjs --prod           # 校验生产目录 xiyu-ai/data/dnf_corpus
 *   node scripts/verify_corpus_v3.mjs --dir <path>     # 指定目录
 *   node scripts/verify_corpus_v3.mjs --strict-deferred
 * 退出码：0=全绿（DEFERRED 不计失败）；1=硬失败；2=不可判定（拒绝出结论）；3=harness 错误
 */
import fs from 'node:fs';
import path from 'node:path';

const EXIT_OK = 0, EXIT_FAIL = 1, EXIT_UNDECIDABLE = 2, EXIT_HARNESS = 3;

const argv = process.argv.slice(2);
const STRICT = argv.includes('--strict-deferred');
const USE_PROD = argv.includes('--prod');
const REVERSE_ADDRESS_TEST = argv.includes('--address-reverse-case');
const STRICT_QUANTIFIER = argv.includes('--strict-quantifier');
const KEY_REVERSE_TEST = argv.includes('--key-reverse-case');

// ═══════════════════════════════════════════════════════════════════════════
// 读者键路径白名单（t59 · 漂移家族门禁）——**以代码真实读点为据**，不凭文档臆造
//   导出方式（可复核）：
//     cd D:\GitHub\xiyu-ai && rg -n "hotData\.[a-zA-Z_]+(\?\.[a-zA-Z_]+)?" src/game_dnf.mjs
//     cd D:\GitHub\xiyu-ai && rg -n "\?\.mail_templates" src/game_dnf.mjs
//     cd D:\GitHub\dnf-robot-act12 && rg -n "loverFirstMeetSceneKey|loverFirstMeetTopKey" internal/composition/backend/act12/lover_corpus_pool.go
//   判定口径：
//     · kind=stringArray → 必须是「非空数组，元素均为非空字符串」
//     · kind=mailTemplates → 必须是数组，且 **至少 1 条** 的 `dialogue[<role>]` 为非空字符串
//       （注：`mail_templates` 的元素是对象而非字符串，不能按 stringArray 判）
//   ⚠️ 三人**逐角色**都要满足（JS 侧按 roleKey 取同一路径；缺则 pool=undefined → 走兜底 = 玩家可见降级）
// ═══════════════════════════════════════════════════════════════════════════
const KEY_PATHS = [
  { path: 'proactive_greetings', kind: 'stringArray', src: 'src/game_dnf.mjs:347' },
  { path: 'social.anti_bot', kind: 'stringArray', src: 'src/game_dnf.mjs:354' },
  { path: 'social.jealous', kind: 'stringArray', src: 'src/game_dnf.mjs:426' },
  { path: 'social.greeting', kind: 'stringArray', src: 'src/game_dnf.mjs:429' },
  { path: 'social.standby', kind: 'stringArray', src: 'src/game_dnf.mjs:432' },
  { path: 'social.sweet_talk', kind: 'stringArray', src: 'src/game_dnf.mjs:437' },
  { path: 'routine.in_class', kind: 'stringArray', src: 'src/game_dnf.mjs:363,368' },
  { path: 'routine.lunch', kind: 'stringArray', src: 'src/game_dnf.mjs:364' },
  { path: 'routine.afternoon', kind: 'stringArray', src: 'src/game_dnf.mjs:365' },
  { path: 'routine.curfew', kind: 'stringArray', src: 'src/game_dnf.mjs:366' },
  { path: 'routine.late_night', kind: 'stringArray', src: 'src/game_dnf.mjs:367' },
  { path: 'abyss.pray', kind: 'stringArray', src: 'src/game_dnf.mjs:375' },
  { path: 'abyss.spark_epic', kind: 'stringArray', src: 'src/game_dnf.mjs:376' },
  { path: 'abyss.bald_head', kind: 'stringArray', src: 'src/game_dnf.mjs:377' },
  { path: 'abyss.kill_apc', kind: 'stringArray', src: 'src/game_dnf.mjs:378' },
  { path: 'upgrade.broken', kind: 'stringArray', src: 'src/game_dnf.mjs:384' },
  { path: 'upgrade.success', kind: 'stringArray', src: 'src/game_dnf.mjs:387' },
  { path: 'upgrade.clonte_amplify', kind: 'stringArray', src: 'src/game_dnf.mjs:390' },
  { path: 'dungeon.out_of_mana', kind: 'stringArray', src: 'src/game_dnf.mjs:396' },
  { path: 'dungeon.player_dead', kind: 'stringArray', src: 'src/game_dnf.mjs:399' },
  { path: 'dungeon.companion_dead', kind: 'stringArray', src: 'src/game_dnf.mjs:402' },
  { path: 'dungeon.entry', kind: 'stringArray', src: 'src/game_dnf.mjs:405' },
  { path: 'materials.need_obsidian', kind: 'stringArray', src: 'src/game_dnf.mjs:411' },
  { path: 'materials.need_soul', kind: 'stringArray', src: 'src/game_dnf.mjs:414' },
  { path: 'materials.need_calamity', kind: 'stringArray', src: 'src/game_dnf.mjs:417' },
  { path: 'materials.cube_reimburse', kind: 'stringArray', src: 'src/game_dnf.mjs:420' },
  { path: 'mail_templates', kind: 'mailTemplates', src: 'src/game_dnf.mjs:1206' },
  { path: 'naming.first_meet', kind: 'stringArray', src: 'dnf-robot-act12/internal/composition/backend/act12/lover_corpus_pool.go:35-36,131' },
];
/**
 * **已声明的键路径缺口**（grandfather 清单）——设计要点（自清理）：
 * 缺了**且在此清单里** → 记为已知债务（note，不 hard fail）；
 * 缺了但**不在**清单里 → `KEY-PATH` **hard fail**（新漂移必拦）；
 * 清单里的条目**若已补齐** → `KEY-GAP-STALE` **hard fail**（防止债务清单只增不减、悄悄过期）。
 *
 * 📌 **t60 已清空**：原 18 条 heika 缺口（`social.jealous/greeting/standby` + `abyss.*`×4 + `upgrade.*`×3
 *    + `dungeon.*`×4 + `materials.*`×4）已由 t60 补齐——每池 **6 条**专属台词、共 **108 条**（逐条过硬约束），
 *    见 `doc/lovers/t60补齐heika池报告-2026-10-12.md`。清单现为**空 = 无已知漂移债务**；
 *    今后若再发现新缺口，须在此显式声明并附 `why/risk/owner`。
 */
const KEY_GAPS = [];

/**
 * **文件级读者契约（t60 白名单扩展）**——把"确实读取语料"的脚本读点并入白名单（文件级）。
 * 导出方式：
 *   cd D:\GitHub\xiyu-ai && rg -n "dnf_corpus|_corpus\.json|CORPUS_DIR" scripts -g "*.mjs"
 * 归属判定：
 *   · `build_clean_verbatim_bank.mjs`（t45 出题器，:26/:31/:108/:196）——按 `{role}_corpus.json` 读取，
 *     并**对所有非元数据叶子做全局遍历**（`walk()`+`SKIP_KEYS`）+ 只取 `mail_templates[].dialogue.<role>`：
 *     文件级契约由此常量覆盖；`mail_templates[].dialogue.<role>` 已由 `KEY_PATHS` 的 `mailTemplates` 覆盖；
 *     **全局叶子遍历无法逐路径枚举**，其风险（把非台词叶子当台词——t52 邮件档崩盘的结构原因）
 *     由**逐叶子门禁**（BUDGET/A/D/E/SPLICE/DUP…）承担，故不并入路径白名单。
 *   · `test_hot_corpus.mjs`(:26,:162) / `dnf_brain_p0_smoke.mjs`(:32,:413) / `test_hot_reload_live.mjs`(:6)
 *     ——只读拷贝生产语料做热更与自证 ⇒ 同属**文件级**契约。
 *   · `verify_*.mjs`（含本文件）——**校验者自身**，其"读点"就是本门禁，不计入产品读者。
 */
const KEY_FILE_READERS = [
  { file: 'peach_corpus.json', readers: ['src/game_dnf.mjs', 'scripts/build_clean_verbatim_bank.mjs:31,108,196', 'scripts/test_hot_corpus.mjs:26,162', 'scripts/dnf_brain_p0_smoke.mjs:32,413', 'scripts/test_hot_reload_live.mjs:6'] },
  { file: 'tuanzi_corpus.json', readers: ['src/game_dnf.mjs', 'scripts/build_clean_verbatim_bank.mjs:31,108,196'] },
  { file: 'heika_corpus.json', readers: ['src/game_dnf.mjs', 'scripts/build_clean_verbatim_bank.mjs:31,108,196'] },
  { file: 'mail_templates.json', readers: ['src/game_dnf.mjs:1206', 'scripts/build_clean_verbatim_bank.mjs:40-42'] },
];
const dirArgIdx = argv.indexOf('--dir');
// 默认校验「当前最新暂存」= t72 五池落地后的 v36；历史版本用 --dir 指定
const DEFAULT_STAGED = path.resolve('D:/GitHub/dnf-robot-act12/doc/lovers/staged_corpus_v36');
const PREV_STAGED = path.resolve('D:/GitHub/dnf-robot-act12/doc/lovers/staged_corpus_v35');
// 构建产物（staged_report.json）与 v1 原始基线备份都留在 t19 的 staged_corpus_v3 里，供后续版本回退查找
const BASE_STAGED = path.resolve('D:/GitHub/dnf-robot-act12/doc/lovers/staged_corpus_v3');
const PROD = path.resolve('data/dnf_corpus');
const DIR = dirArgIdx >= 0 ? path.resolve(argv[dirArgIdx + 1] || '') : (USE_PROD ? PROD : DEFAULT_STAGED);
// v1 基线备份目录可能在历史 staging 里（t19 建的）；按 [DIR, 上一版 staging, 默认 staging] 顺序寻找
const BACKUP = [
  path.join(DIR, '_backup_v1_20261012'),
  path.join(BASE_STAGED, '_backup_v1_20261012'),
  path.join(PREV_STAGED, '_backup_v1_20261012'),
  path.join(DEFAULT_STAGED, '_backup_v1_20261012'),
].find((p) => fs.existsSync(p)) || path.join(DIR, '_backup_v1_20261012');

const REQUIRED = ['peach_corpus.json', 'tuanzi_corpus.json', 'heika_corpus.json', 'mail_templates.json'];
const ADDITIVE = ['mail_scenarios_v3.json', 'long_letters.json', 'calendar_contract.json', 'role_letters_gap_manifest.json'];

const issues = [], deferred = [], notes = [], undecidable = [];
const hardFail = (gate, problem, extra = {}) => issues.push({ gate, problem, ...extra });
const defer = (gate, why) => deferred.push({ gate, why });
const undec = (gate, why) => undecidable.push({ gate, why });

// ── 通道分类（与 doc/lovers/staged_corpus_v3/build_corpus_v3.mjs 保持同步；改一处必须改两处）──
const META_ROOTS = new Set([
  'character', 'meta', 'fingerprint', 'fingerprint_contract', 'fingerprint_meta', 'self_describe',
  'coverage', 'byte_index', 'byte_annotation', 'timeline', 'scene_media', 'counts', 'schema',
  'purpose', 'aligned_to', 'db_field_mapping', 'two_part_letter_contract', 'channel_budgets_gbk',
  'item_whitelist', 'address_variables', 'address_tiers', 'forbidden_address', 'alias_candidates',
  'aliases', 'measured', 'rule_reading', 'quality_baseline',
  'variable_convention', 'authoritative_rules', 'source_docs', 'go_side_gap', 'fingerprint_alignment',
  'config', 'manifest', 'gates', 'quota', 'by_day', 'unlock_keys_allowed', 'revoked_keys',
  // t54 收窄（t53 F-5）：**不再把 `territory_boundary` / `distinct_from` 当根级豁免**——
  // 否则会形成"三词被全局豁免 + 又没有使用侧判据"的盲区。声明判定改由 `isTerritoryDeclaration()` 精确限定。
]);
const META_LEAF = new Set([
  'description', 'reason', 'note', 'name', 'scenario', 'category', 'id', 'count', 'item_id',
  'upgrade_level', '_source_role', 'schema', 'generated_at', 'contract', 'structure_mapping',
  'before_v3', 'after_v1', 'mail_excerpt_max_gbk', 'gallery_url_pattern', 'kind', 'unlock',
  'written_at', 'source_ref', 'status_suggested', 'gallery_link', 'companion', 'companion_uid',
  'role', 'by_role', 'counts', 'published', 'warning', 'hint', 'tags', 'media', 'stage_gate',
  'dedup_key', 'evidence', 'mood', 'event', 'day', 'weekday', 'phase', 'window', 'usable',
  'bytes', 'sha256', 'files', 'db', 'dir', 'at', 'total', 'letters', 'mail_templates', 'diary',
  'source', 'threshold', 'per_day_total', 'status', 'method',
]);
const BUDGETS = { chat: 58, white: 80, yellow: 60, mail_title: 30, mail_body: 360, gallery: Infinity };
const GBK_2BYTE = [
  [0x00A4, 0x00A4], [0x2010, 0x203B], [0x203C, 0x206F], [0x20AC, 0x20AC], [0x2103, 0x21FF],
  [0x2460, 0x24FF], [0x2500, 0x267F], [0x3000, 0x30FF], [0x3105, 0x3129], [0x3220, 0x3229],
  [0x4E00, 0x9FA5], [0x9FA6, 0x9FFF], [0xFE30, 0xFE4F], [0xFF00, 0xFF5E], [0xFFE0, 0xFFE5],
];
function gbk(s) {
  let n = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) { n += 1; continue; }
    let two = false;
    for (const [lo, hi] of GBK_2BYTE) if (cp >= lo && cp <= hi) { two = true; break; }
    n += two ? 2 : 0;
  }
  return n;
}
const segments = (p) => p.split(/[.[\]]+/).filter(Boolean).map((s) => (/^\d+$/.test(s) ? '#' : s));
function classify(p) {
  const segs = segments(p), root = segs[0] || '', leaf = segs[segs.length - 1] || '';
  if (/^_/.test(leaf)) return 'meta';
  if (META_ROOTS.has(root)) return 'meta';
  if (segs.includes('mail_templates') || segs.includes('mails') || segs.includes('dialogue')) {
    if (leaf === 'gallery_full') return 'gallery';
    if (/^(title|mail_title|subject)$/.test(leaf)) return 'mail_title';
    if (segs.includes('dialogue')) return 'mail_body';
    if (META_LEAF.has(leaf)) return 'meta';
  }
  if (leaf === 'gallery_full') return 'gallery';
  if (/^(title|mail_title|subject)$/.test(leaf)) return 'mail_title';
  if (leaf === 'body' || leaf === 'mail_excerpt') return 'mail_body';
  if (META_LEAF.has(leaf)) return 'meta';
  const joined = segs.join('.');
  if (/yellow|megaphone/.test(joined)) return 'yellow';
  if (/white|ambient|onscreen|presence|encounter/.test(joined)) return 'white';
  return 'chat';
}
const isDeclaration = (p) => /forbidden_address|disallow|banned|禁用|rule_reading|self_describe|_meta/.test(p);
/**
 * 三词领地（老地方/别迟到/照旧）的**声明容器**判定 —— t54 收窄口径（t53 F-5）：
 * 只有 `fingerprint.territory_boundary*`（"禁止越界使用"清单）与 `fingerprint.distinct_from.*`
 * （在与团子对比时列举她的领地用语）算"声明"。**其余任何位置一律按"使用"判定**：
 *   · 出现在 `tuanzi` 的对白/邮件 → **合规**（这是她的领地）；
 *   · 出现在 `heika`（或 peach）的对白/邮件 → **hard fail**（越界）。
 * 依据：t34 修复清单 B4「把 老地方/别迟到/照旧 从黑咖归还团子」+ captain 2026-10-12 正式裁定。
 */
const TERRITORY_WORDS = ['老地方', '别迟到', '照旧'];
const isTerritoryDeclaration = (p) => /^fingerprint\.territory_boundary|^fingerprint\.distinct_from/.test(p) || isDeclaration(p);

function walk(obj, prefix = '', out = []) {
  if (typeof obj === 'string') { out.push([prefix.replace(/^\./, ''), obj]); return out; }
  if (Array.isArray(obj)) { obj.forEach((v, i) => walk(v, `${prefix}[${i}]`, out)); return out; }
  if (obj && typeof obj === 'object') { for (const [k, v] of Object.entries(obj)) walk(v, `${prefix}.${k}`, out); return out; }
  return out;
}
function typeTree(obj, prefix = '', out = new Map()) {
  if (Array.isArray(obj)) { out.set(prefix, 'array'); obj.forEach((v, i) => typeTree(v, `${prefix}[#]`, out)); return out; }
  if (obj && typeof obj === 'object') { out.set(prefix, 'object'); for (const [k, v] of Object.entries(obj)) typeTree(v, prefix ? `${prefix}.${k}` : k, out); return out; }
  out.set(prefix, typeof obj);
  return out;
}

// ── 0. 入参与目录 ──
if (!fs.existsSync(DIR)) { console.error(`[harness] dir not found: ${DIR}`); process.exit(EXIT_HARNESS); }
if (!fs.existsSync(path.join(DIR, 'peach_corpus.json'))) {
  console.error(`[harness] ${DIR} 下没有 peach_corpus.json —— 用 --dir 指定语料目录`);
  process.exit(EXIT_HARNESS);
}
const loaded = {};
for (const f of [...REQUIRED, ...ADDITIVE]) {
  const p = path.join(DIR, f);
  if (!fs.existsSync(p)) {
    if (REQUIRED.includes(f)) undec(`FILE`, `必需文件缺失：${f}`);
    else notes.push(`附加文件不存在（可接受的纯加法缺省）：${f}`);
    continue;
  }
  try { loaded[f] = JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch (e) { hardFail('JSON.parse', `${f} 解析失败：${e.message}`); }
}

// ── 1. GATE STRUCT：与 v1 基线逐 key 比对类型（证明加载器按键名取值仍成立）──
if (fs.existsSync(BACKUP)) {
  for (const f of REQUIRED) {
    const b = path.join(BACKUP, f);
    if (!fs.existsSync(b) || !loaded[f]) continue;
    const base = typeTree(JSON.parse(fs.readFileSync(b, 'utf-8')));
    const cur = typeTree(loaded[f]);
    const missing = [], typeChanged = [];
    for (const [k, t] of base) {
      if (!cur.has(k)) missing.push(k);
      else if (cur.get(k) !== t) typeChanged.push({ key: k, baseline: t, staged: cur.get(k) });
    }
    if (missing.length) hardFail('STRUCT', `${f}: v1 基线键缺失 ${missing.length} 个`, { samples: missing.slice(0, 8) });
    if (typeChanged.length) hardFail('STRUCT', `${f}: 键类型被改（违反"不改既有键语义"）`, { samples: typeChanged.slice(0, 8) });
    // 加载器实际读取的池必须是字符串数组
    const LOADER_POOLS = {
      'peach_corpus.json': ['proactive_greetings', 'routine.in_class', 'routine.lunch', 'routine.afternoon', 'routine.curfew',
        'routine.late_night', 'social.greeting', 'social.jealous', 'social.standby', 'social.sweet_talk', 'social.anti_bot',
        'dungeon.entry', 'dungeon.out_of_mana', 'dungeon.player_dead', 'dungeon.companion_dead', 'dungeon.clear_boss',
        'dungeon.flip_card_good', 'dungeon.flip_card_bad', 'abyss.pray', 'abyss.spark_epic', 'abyss.kill_apc', 'abyss.bald_head',
        'upgrade.ready', 'upgrade.success', 'upgrade.broken', 'materials.need_obsidian', 'materials.need_soul',
        'materials.need_calamity', 'materials.cube_reimburse', 'materials.repair_weapon'],
      'tuanzi_corpus.json': ['proactive_greetings', 'routine.in_class', 'routine.lunch', 'routine.afternoon', 'routine.curfew',
        'routine.late_night', 'social.greeting', 'social.jealous', 'social.standby', 'social.sweet_talk', 'social.anti_bot',
        'dungeon.entry', 'dungeon.out_of_mana', 'dungeon.player_dead', 'dungeon.companion_dead', 'dungeon.clear_boss',
        'dungeon.flip_card_good', 'dungeon.flip_card_bad', 'abyss.pray', 'abyss.spark_epic', 'abyss.kill_apc', 'abyss.bald_head',
        'upgrade.ready', 'upgrade.success', 'upgrade.broken', 'materials.need_obsidian', 'materials.need_soul',
        'materials.need_calamity', 'materials.cube_reimburse', 'materials.repair_weapon'],
      'heika_corpus.json': ['proactive_greetings', 'routine.in_class', 'routine.lunch', 'routine.afternoon', 'routine.curfew',
        'routine.late_night', 'social.anti_bot', 'social.sweet_talk'],
    };
    const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
    for (const pool of (LOADER_POOLS[f] || [])) {
      const v = getPath(loaded[f], pool);
      if (v === undefined) continue; // 该角色原本没有这个池
      if (!Array.isArray(v)) hardFail('LOADER_POOL', `${f}: ${pool} 必须是数组（加载器取 .length 与随机抽样）`, { got: typeof v });
      else if (v.some((x) => typeof x !== 'string')) hardFail('LOADER_POOL', `${f}: ${pool} 含非字符串元素`);
      else if (!v.length) hardFail('LOADER_POOL', `${f}: ${pool} 为空数组（会取到 undefined 台词）`);
    }
  }
  // mail_templates 必须是数组，且每条要能被 getMailGiftList() 映射（item_id/category/dialogue 三要素）
  if (Array.isArray(loaded['mail_templates.json'])) {
    loaded['mail_templates.json'].forEach((it, i) => {
      const miss = ['item_id', 'category', 'dialogue'].filter((k) => it[k] === undefined);
      if (miss.length) hardFail('MAIL_SHAPE', `mail_templates[${i}] 缺 ${miss.join('/')}（getMailGiftList 会取到 undefined）`, { id: it.id });
      if (it.dialogue && typeof it.dialogue === 'object' && !('title' in it.dialogue)) {
        hardFail('MAIL_SHAPE', `mail_templates[${i}].dialogue 缺 title（v3 新结构未转换）`, { id: it.id });
      }
    });
  } else if (loaded['mail_templates.json'] !== undefined) {
    hardFail('MAIL_SHAPE', 'mail_templates.json 顶层必须是数组（loadMailTemplatesHot 依赖 [].map）');
  }
} else {
  undec('STRUCT', `缺少 v1 基线备份目录 ${BACKUP} → 无法证明"结构与加载器兼容"`);
}

// ── 2. GATE BUDGET / A / D / TEMPLATE / E / BRACE （对白域，声明性容器剔除）──
const A_RX = /(70|85|90|100)\s*级|二觉|二次觉醒|70CC|安徒恩|卢克|超时空|普雷|伊希斯|奥兹玛|巴卡尔|虚无之境|真猪|列瑟芬|幽灵列车|绝望之塔|领主之塔|守护者祭坛|巨龙地下城|称号簿|成就系统|公会大厅|修炼道场|修炼场|名望|三攻|技攻|独立攻击力|团本|男格斗|男法师|女鬼剑|守护者|魔枪士|剑影|刃影|旅人/;
const D1_RX = /AI|人工智能|大模型|大语言模型|提示词|prompt|角色扮演|系统提示|被设定|我是程序|我是机器人/;
const D2_RX = /你才(是)?(机器人|AI|大模型)|再叫AI|谁是AI|图灵测试/;
const TPL_RX = /%s|\{0\}|（此处|\(此处|【待填】/;
const CS_RX = /亲亲呢|尊敬的|为您服务|请稍等|感谢理解|客服|如有疑问/;
const BAN_RX = /大英雄|勇士大人|冒险家|主人|亲爱的/;
const NAME_WL = /黑咖小助手|软糖小桃子|奶盖小团子/g;
const VAR_WL = new Set(['player_nickname', 'player_alias', 'self_name', 'self_thing']);
const FENCE_RX = /```|\*\*|^#{1,6} /m;

let totalLeaves = 0, dialogueLeaves = 0;
const perFile = {};
const chatByRole = { peach: new Map(), tuanzi: new Map(), heika: new Map() };
for (const [f, obj] of Object.entries(loaded)) {
  const st = { leaves: 0, dialogue: 0, over: [], aDialogue: [], aMeta: [], d1: [], d2: 0, tpl: [], cs: [], ban: [], braces: [], vars: new Set() };
  for (const [p, text] of walk(obj)) {
    st.leaves++; totalLeaves++;
    const ch = classify(p);
    if (ch !== 'meta') dialogueLeaves++;
    if (ch === 'meta') {
      if (A_RX.test(text) && !isDeclaration(p)) st.aMeta.push({ path: p, sample: text.slice(0, 40) });
      continue;
    }
    st.dialogue++;
    if (gbk(text) > BUDGETS[ch]) st.over.push({ path: p, channel: ch, gbk: gbk(text), budget: BUDGETS[ch] });
    if (isDeclaration(p)) continue; // 声明 ≠ 使用
    if (A_RX.test(text)) st.aDialogue.push({ path: p, sample: text.slice(0, 40) });
    let t = text.replace(NAME_WL, '《角色名》');
    if (D1_RX.test(t)) { if (D2_RX.test(text) || /anti_bot/.test(p)) st.d2++; else st.d1.push({ path: p, sample: t.slice(0, 40) }); }
    if (TPL_RX.test(text)) st.tpl.push({ path: p, sample: text.slice(0, 40) });
    if (CS_RX.test(text)) st.cs.push({ path: p, sample: text.slice(0, 40) });
    if (BAN_RX.test(text)) st.ban.push({ path: p, sample: text.slice(0, 40) });
    if (/\{\{/.test(text)) st.braces.push({ path: p, sample: text.slice(0, 40) });
    for (const m of text.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)) st.vars.add(m[1]);
    if (FENCE_RX.test(text)) st.cs.push({ path: p, sample: 'markdown/换行痕迹: ' + text.slice(0, 30) });
    const role = /peach/.test(f) ? 'peach' : /tuanzi/.test(f) ? 'tuanzi' : /heika/.test(f) ? 'heika' : null;
    if (role && (ch === 'chat' || ch === 'white')) if (!chatByRole[role].has(text)) chatByRole[role].set(text, p);
  }
  perFile[f] = st;
  if (st.over.length) hardFail('BUDGET', `${f}: ${st.over.length} 条超通道预算`, { samples: st.over.slice(0, 10) });
  if (st.aDialogue.length) hardFail('A-REDLINE', `${f}: 对白域命中 A 类硬红线 ${st.aDialogue.length} 条`, { samples: st.aDialogue.slice(0, 6) });
  if (st.aMeta.length) notes.push(`${f}: 元数据域 A 类命中 ${st.aMeta.length} 条（仅告警，不计失败）`);
  if (st.d1.length) hardFail('D1-METAWORD', `${f}: 真元词汇 ${st.d1.length} 条（已做角色名白名单与 D-2 豁免）`, { samples: st.d1.slice(0, 6) });
  if (st.tpl.length) hardFail('TEMPLATE', `${f}: 模板残留 ${st.tpl.length} 条`, { samples: st.tpl.slice(0, 6) });
  if (st.cs.length) hardFail('CUSTOMER-TONE', `${f}: 说教/客服腔/Markdown ${st.cs.length} 条`, { samples: st.cs.slice(0, 6) });
  if (st.braces.length) hardFail('BRACE', `${f}: 双花括号残留 ${st.braces.length} 条（冻结写法为单花）`, { samples: st.braces.slice(0, 6) });
  const badVars = [...st.vars].filter((v) => !VAR_WL.has(v) && v !== 'token');
  if (badVars.length) hardFail('VAR-WHITELIST', `${f}: 出现白名单外的变量名 ${badVars.join(',')}`, {});
}

// ── 3. GATE BAN-HARDCODE（**任意硬编码称呼扫描**；不再依赖枚举词表）──
//   t44 门禁升级：16 处「哥哥」之所以漏过，是因为旧门禁只扫「大英雄/勇士大人/冒险家」枚举。
//   新机制三层：
//     V1 已知称呼表（可增长）——命中即硬失败；
//     V2 结构候选：句首 `token[，,！!]` 呼语形态，剔除白名单后，**同一 token 出现 ≥3 次即硬失败**
//        （内容无关：词表里没有的新称呼只要反复出现就会红——这是"换汤不换药"的解法）；
//     V3 评测语汇（元叙事泄漏）——对白域 0 命中；元规则句本身全局 0 命中。
//   声明性容器（forbidden_address / self_describe / `_` 前缀）豁免，但**逐条登记**到 notes。
// V1 只收「**确实是面向玩家的固定称呼**」的词（上下文歧义词不收，避免误伤：
// 如「老板多送了一份小菜」的"老板"是店主、「我宝宝(赫德尔)今天很能打」的"宝宝"是召唤兽、
// 「你那宝贝武器」的"宝贝"是形容词）。**上下文歧义词一律交给 V2 结构候选 + 人审**。
const ADDR_BAN = [/哥哥/, /大英雄/, /勇士大人/, /冒险家/, /主人/, /亲爱的/, /老公/, /老婆/, /死鬼/, /亲亲/];
const ADDR_OK = new Set(['小桃子', '桃子', '本小姐', '本天才', '你', '喂', '哎', '那个', '名字', '谁',
  '今天', '明天', '昨天', '前天', '刚才', '早上', '中午', '下午', '晚上', '深夜', '凌晨', '早八', '最近', '以前', '后来',
  '其实', '要是', '如果', '话说', '对了', '还有', '反正', '总之', '不过', '因为', '所以', '然后', '结果', '本来', '可能',
  '大概', '据说', '听说', '我', '说真的', '讲真', '喂喂', '同学们', '老师', '室友', '阿姨', '赫德尔',
  // ── t44 实测补入的「非呼语开头」白名单（句首词/感叹/自语，非对玩家的固定称呼）──
  '晚安', '走啦进图', '你去吧', '算了', '笨蛋', '看什么看', '光头了吧', '拿去', '站住', '我算过',
  '别', '快点', '过来', '等下', '先去', '再去', '要不要', '早起', '通宵', '碎了', '上啦', '闪啦', '过图啦', '摸摸头',
  // ── t72 实测补入的「非呼语开头」白名单（句首承接/安慰式陈述，**不是**对玩家的称呼）──
  //    · 「你忙你的」= 让对方继续自己的事（陈述/许可），不是在叫他
  //    · 「回来就好」= 安慰式陈述（她自我安抚/定调），不是在叫他
  '你忙你的', '回来就好']);
const DIALOGUE_LINE_RX = /^([\u4e00-\u9fa5A-Za-z]{2,4})[，,！!：:]/;
const EVAL_RX = /属于本角色|句尾|颜文字|数字论证|本角色/;
const RULE_SENTENCE = '凡句尾无语气词、无颜文字且含数字论证的句子，不属于本角色。';
/** 地址门禁的**纯函数**实现（真跑与反向用例共用同一份逻辑） */
function computeAddressGate(files) {
  const knownHits = [], structCand = new Map(), evalHits = [], declared = [];
  let ruleSentenceGlobal = 0;
  for (const [f, obj] of Object.entries(files)) {
    for (const [p, text] of walk(obj)) {
      if (text.includes(RULE_SENTENCE)) {
        // F-3 的允许收容处：`_` 前缀元数据（移动留痕）；对白域不得出现
        if (!/^_|\._/.test(p) && !/^_meta/.test(p)) ruleSentenceGlobal += 1;
      }
      if (isDeclaration(p)) { if (ADDR_BAN.some((rx) => rx.test(text))) declared.push({ file: f, path: p, sample: text.slice(0, 24) }); continue; }
      const ch = classify(p);
      if (ch === 'meta' || ch === 'gallery') continue;
      if (ADDR_BAN.some((rx) => rx.test(text))) knownHits.push({ file: f, path: p, sample: text.slice(0, 30) });
      if (EVAL_RX.test(text)) evalHits.push({ file: f, path: p, sample: text.slice(0, 30) });
      if (ch === 'chat' || ch === 'white') {
        const m = DIALOGUE_LINE_RX.exec(text.trim());
        if (m && !ADDR_OK.has(m[1]) && !/^\{/.test(text.trim())) {
          const t = m[1];
          if (!structCand.has(t)) structCand.set(t, []);
          structCand.get(t).push({ file: f, path: p, sample: text.slice(0, 24) });
        }
      }
    }
  }
  return {
    knownHits, evalHits, declared, ruleSentenceGlobal,
    repeated: [...structCand.entries()].filter(([, v]) => v.length >= 3),
    single: [...structCand.entries()].filter(([, v]) => v.length < 3),
    candTokens: structCand,
  };
}

{
  const g = computeAddressGate(loaded);
  const { knownHits, repeated, single, evalHits, declared, ruleSentenceGlobal } = g;
  if (knownHits.length) hardFail('BAN-ADDRESS-V1', `已知硬编码称呼 ${knownHits.length} 处（对白域/邮件域）`, { samples: knownHits.slice(0, 8) });
  if (repeated.length) hardFail('BAN-ADDRESS-V2', `结构候选称呼反复出现（≥3 次）→ 视为硬编码称呼：${repeated.map(([t, v]) => `${t}×${v.length}`).join('、')}`, { samples: repeated.slice(0, 4).map(([t, v]) => ({ token: t, count: v.length, path: v[0].path })) });
  for (const [t, v] of single.slice(0, 20)) notes.push(`ADDRESS-CANDIDATE(待审): 「${t}」×${v.length}（${v[0].path}）—— 若属面向玩家的固定称呼，请加入 ADDR_BAN 或改写为变量`);
  if (single.length > 20) notes.push(`ADDRESS-CANDIDATE(待审) 另有 ${single.length - 20} 个低频候选未逐条列出（完整清单见 verify_corpus_v3_output.json 的 notes 过滤 ADDRESS-CANDIDATE）`);
  if (evalHits.length) hardFail('EVAL-VOCAB', `评测语汇出现在对白域 ${evalHits.length} 处`, { samples: evalHits.slice(0, 6) });
  if (ruleSentenceGlobal) hardFail('RULE-SENTENCE', `元规则句在语料中仍存在 ${ruleSentenceGlobal} 处（F-3 未清）`, {});
  notes.push(`声明性容器中的称呼词登记（豁免但留痕）：${declared.length} 处`);
}

// ── 3a. 反向用例：往临时语料塞一个**词表外**的新称呼（老板），门禁必须变红 ──
if (REVERSE_ADDRESS_TEST) {
  const probe = JSON.parse(JSON.stringify(loaded));
  const pe = probe['peach_corpus.json'] || probe[Object.keys(probe)[0]];
  const target = pe?.social?.greeting || pe?.proactive_greetings;
  const injectedPaths = [];
  if (Array.isArray(target)) {
    for (let k = 0; k < 3; k++) {
      // 用词表内不存在的称呼 + 呼语形态，模拟"新出现的同类词"
      const line = `老板${k === 0 ? '，' : k === 1 ? '！' : '，'}今天上线挺早啊`;
      if (target[k] === undefined) target.push(line); else target[k] = line;
      injectedPaths.push(`social.greeting[${k}]`);
    }
  }
  const g2 = computeAddressGate(probe);
  const wentRed = g2.knownHits.length > 0 || g2.repeated.length > 0;
  console.log(`[verify_corpus_v3][reverse-case] 注入「老板」×3 @ ${injectedPaths.join(', ')} → V1命中=${g2.knownHits.length} V2重复token=${JSON.stringify(g2.repeated.map(([t, v]) => `${t}×${v.length}`))} → ${wentRed ? 'RED ✅（门禁有效）' : 'GREEN ❌（门禁失效！）'}`);
  if (!wentRed) hardFail('REVERSE-CASE', '反向用例失败：注入词表外称呼「老板」后门禁仍为绿 —— 说明门禁仍是"枚举词表换汤不换药"', {});
  else notes.push('反向用例通过：词表外新称呼「老板」×3 会触发 BAN-ADDRESS-V2 硬失败');

  // 反向用例 2：**领地词越界**（往 heika 塞一处「老地方」→ GATE TERRITORY 必须变红）
  // 与 §3c 的 GATE TERRITORY 同规则（此处内联，避免与主流程耦合）
  {
    const probe2 = JSON.parse(JSON.stringify(loaded));
    const hk = probe2['heika_corpus.json'];
    const injected = [];
    const clip = hk?.social?.standby || hk?.proactive_greetings || hk?.mail_templates;
    if (Array.isArray(clip)) { clip[0] = '今晚老地方见，别让我等'; injected.push('heika_corpus.' + (hk?.social?.standby ? 'social.standby[0]' : 'proactive_greetings[0]')); }
    const terrHits = [];
    for (const [f, obj] of Object.entries(probe2)) {
      const role = /peach/.test(f) ? 'peach' : /tuanzi/.test(f) ? 'tuanzi' : /heika/.test(f) ? 'heika' : 'other';
      if (role === 'tuanzi') continue;
      for (const [p, text] of walk(obj)) {
        if (isTerritoryDeclaration(p)) continue;
        const hit = TERRITORY_WORDS.filter((w) => text.includes(w));
        if (hit.length) terrHits.push(`${f}::${p}`);
      }
    }
    const wentRed2 = terrHits.length > 0;
    console.log(`[verify_corpus_v3][reverse-case] 注入「老地方」×1 @ ${injected.join(', ') || '(未注入)'} → TERRITORY 越界命中=${terrHits.length} ${JSON.stringify(terrHits.slice(0, 3))} → ${wentRed2 ? 'RED ✅（门禁有效）' : 'GREEN ❌（门禁失效！）'}`);
    if (!injected.length) undec('REVERSE-CASE-TERRITORY', '无法定位注入点（heika 对白池结构变化）→ 领地反向用例未执行');
    else if (!wentRed2) hardFail('REVERSE-CASE-TERRITORY', '反向用例失败：往 heika 注入领地词「老地方」后门禁仍绿', {});
    else notes.push('反向用例通过：heika 侧出现「老地方」会触发 GATE TERRITORY 硬失败；tuanzi 侧同类文本不触发');
  }
}

// ── 3g-rev. 反向用例 3：**键路径漂移**（把一条白名单键改名 → GATE KEY-PATH 必须变红）──
if (KEY_REVERSE_TEST) {
  const probe3 = JSON.parse(JSON.stringify(loaded));
  const pe = probe3['peach_corpus.json'];
  const renamed = [];
  // 选一条**未在 KEY_GAPS 声明**的必填键（peach 的 routine.lunch）
  if (pe?.routine && Array.isArray(pe.routine.lunch)) {
    pe.routine.lunch_renamed_broken = pe.routine.lunch;
    delete pe.routine.lunch;
    renamed.push('peach_corpus.routine.lunch → routine.lunch_renamed_broken（改名模拟"内容写在旧键名"）');
  }
  // 再验一条"类型错误"形态：把 stringArray 换成对象
  if (pe?.social && Array.isArray(pe.social.greeting)) {
    pe.social.greeting = { note: '错型探针' };
    renamed.push('peach_corpus.social.greeting: array → object（类型错误探针）');
  }
  const g3 = computeKeyPathGate(probe3);
  const red = g3.failures.length >= 2;
  console.log(`[verify_corpus_v3][key-reverse-case] ${renamed.join(' / ')}`);
  console.log(`[verify_corpus_v3][key-reverse-case] → KEY-PATH 失败 ${g3.failures.length} 条：${JSON.stringify(g3.failures.map((f) => `${f.role}/${f.path}(${f.why})`))} → ${red ? 'RED ✅（门禁有效）' : 'GREEN ❌（门禁失效！）'}`);
  if (!renamed.length) undec('REVERSE-CASE-KEY', '无法定位注入点（peach 结构变化）→ 键路径反向用例未执行');
  else if (!red) hardFail('REVERSE-CASE-KEY', '反向用例失败：改名/改型白名单键后 KEY-PATH 门禁未达 2 条失败', { failures: g3.failures });
  else notes.push('反向用例通过：白名单键被**改名**或**改型**会触发 GATE KEY-PATH 硬失败（≥2 条）；还原后应复绿');

  // 反向用例 3b：**过期缺口自清理** —— 合成一条假缺口声明（不依赖真实 KEY_GAPS，故 t60 清空后探针仍长期有效）
  const probe4 = JSON.parse(JSON.stringify(loaded));
  const fakeGap = [{ role: 'heika', path: 'social.greeting', why: '探针合成', risk: '探针合成', owner: 'probe' }];
  const g4 = computeKeyPathGate(probe4, fakeGap);
  const redStale = g4.staleGaps.some((s) => s.role === 'heika' && s.path === 'social.greeting');
  if (!redStale) hardFail('REVERSE-CASE-KEY-STALE', '自清理失效：对一条"已存在却仍被声明为缺口"的条目未产生 KEY-GAP-STALE', { staleGaps: g4.staleGaps });
  else {
    console.log(`[verify_corpus_v3][key-reverse-case] 探针：把已存在的 heika.social.greeting 声明为缺口 → KEY-GAP-STALE 命中 ${JSON.stringify(g4.staleGaps.map((s) => `${s.role}/${s.path}`))} → RED ✅（自清理有效；真实 KEY_GAPS 当前 ${KEY_GAPS.length} 条）`);
    notes.push('反向用例通过：KEY_GAPS 声明的缺口被补齐后会触发 KEY-GAP-STALE（债务清单自清理，不会只增不减）');
  }
}


// ── 3b. GATE PERIOD：桃子私聊/白字句号率 ≤0.05（F-1 / §18 T-6；邮件与长信不受限）──
{
  const rows = {};
  for (const [f, obj] of Object.entries(loaded)) {
    const role = /peach/.test(f) ? 'peach' : /tuanzi/.test(f) ? 'tuanzi' : /heika/.test(f) ? 'heika' : null;
    if (!role) continue;
    let tot = 0, per = 0;
    for (const [p, text] of walk(obj)) {
      const ch = classify(p);
      if (ch !== 'chat' && ch !== 'white') continue;
      tot += 1; if (text.trim().endsWith('。')) per += 1;
    }
    rows[role] = { lines: tot, period_lines: per, rate: tot ? +(per / tot).toFixed(4) : 0 };
  }
  notes.push(`按通道句号率（chat+white）：${JSON.stringify(rows)}`);
  // §18 T-6：私聊/白字「按通道」统计，>0.05 即必修 —— **约束全部角色**（不是只约束桃子）；
  // 邮件/长信通道不受此限（已在 classify 中排除 mail_*）。
  for (const r of ['peach', 'tuanzi', 'heika']) {
    if (rows[r] && rows[r].rate > 0.05) hardFail('PERIOD-RATE', `${r} 私聊/白字句号率 ${rows[r].rate} > 0.05（§18 T-6 必修；W2 类）`, { role: r, rows: rows[r] });
  }
  // B2 黑咖量词覆盖（t34 §173 窄口径）：报告 + 台账，阈值由 --strict-quantifier 决定是否硬失败
  {
    const QTY = /概率|误差|统计|样本|两成|按平均|记录在册|对过[一二两三四五六七八九十百0-9]+遍/;
    const hk = loaded['heika_corpus.json'];
    if (hk) {
      let ok = 0, tot = 0;
      for (const [p, text] of walk(hk)) {
        const ch = classify(p);
        if (ch !== 'chat' && ch !== 'white') continue;
        tot += 1; if (QTY.test(text)) ok += 1;
      }
      const rate = tot ? +(ok / tot).toFixed(4) : 0;
      notes.push(`B2 黑咖量词覆盖（窄口径，目标 ≥0.95）：${ok}/${tot} = ${rate}`);
      if (STRICT_QUANTIFIER && rate < 0.95) hardFail('B2-QUANTIFIER', `黑咖量词覆盖 ${rate} < 0.95`, { ok, tot });
    }
  }
}

// ── 3c. GATE TERRITORY：三词领地（老地方/别迟到/照旧 属**奶盖小团子**）
//   依据：t34 修复清单 B4 + captain 2026-10-12 裁定（已写入《恋人语料硬红线与允许口径》§6）。
//   规则：只许出现在 tuanzi 的对白/邮件；**heika/peach 侧出现即 hard fail**；声明容器豁免但登记。
{
  const usage = { tuanzi: [], heika: [], peach: [], other: [] };
  const declared = [];
  for (const [f, obj] of Object.entries(loaded)) {
    const role = /peach/.test(f) ? 'peach' : /tuanzi/.test(f) ? 'tuanzi' : /heika/.test(f) ? 'heika' : 'other';
    for (const [p, text] of walk(obj)) {
      const hit = TERRITORY_WORDS.filter((w) => text.includes(w));
      if (!hit.length) continue;
      if (isTerritoryDeclaration(p)) { declared.push({ file: f, path: p, words: hit }); continue; }
      usage[role].push({ file: f, path: p, words: hit, sample: text.slice(0, 40) });
    }
  }
  const violations = [...usage.heika, ...usage.peach, ...usage.other];
  if (violations.length) {
    hardFail('TERRITORY', `三词（老地方/别迟到/照旧）出现在**非团子**使用处 ${violations.length} 条（越界）`, { samples: violations.slice(0, 8) });
  }
  notes.push(`三词领地：tuanzi 使用处 ${usage.tuanzi.length} 条（合规保留）｜越界 ${violations.length} 条｜声明容器 ${declared.length} 处（豁免并登记：${declared.map((d) => d.path).slice(0, 3).join(' / ')}${declared.length > 3 ? ' …' : ''}）`);
}

// ── 3d. GATE SPLICE / FRAGMENT-TAIL：t44「机械追加」留下的两类残骸（t51 实证）
//   SPLICE：`！，` `。，` 等拼接残骸（追加时没看前一个标点）
//   FRAGMENT-TAIL：裸量词碎片 `，概率|，样本|，误差|，统计`（读起来断句）
{
  const splice = [], frag = [], dupComma = [];
  for (const [f, obj] of Object.entries(loaded)) {
    for (const [p, text] of walk(obj)) {
      if (classify(p) === 'meta' || classify(p) === 'gallery') continue;
      if (/[！。？~…]\s*[，,]/.test(text)) splice.push({ file: f, path: p, sample: text.slice(0, 44) });
      if (/[，,](概率|样本|误差|统计)$/.test(text.trim())) frag.push({ file: f, path: p, sample: text.slice(-24) });
      if (/，\s*，/.test(text)) dupComma.push({ file: f, path: p, sample: text.slice(0, 44) });
    }
  }
  if (splice.length) hardFail('SPLICE', `嫁接式尾句（标点后紧跟逗号）${splice.length} 条`, { samples: splice.slice(0, 6) });
  if (dupComma.length) hardFail('DUP-COMMA', `重复逗号（\`，，\` 拼接残骸）${dupComma.length} 条`, { samples: dupComma.slice(0, 6) });
  if (frag.length) hardFail('FRAGMENT-TAIL', `裸量词碎片尾巴${frag.length} 条（半截句）`, { samples: frag.slice(0, 6) });
  // 量词率的**跨角色**报告：防止后人再把「量词」读成黑咖"独占"（t51 Q074 反证）
  if (loaded['heika_corpus.json']) {
    const QTY = /概率|误差|统计|样本|两成|按平均|记录在册|对过[一二两三四五六七八九十百0-9]+遍/;
    const rows = {};
    for (const role of ['peach', 'tuanzi', 'heika']) {
      const obj = loaded[`${role}_corpus.json`];
      if (!obj) continue;
      let ok = 0, tot = 0;
      for (const [p, text] of walk(obj)) {
        const ch = classify(p);
        if (ch !== 'chat' && ch !== 'white') continue;
        tot += 1; if (QTY.test(text)) ok += 1;
      }
      rows[role] = { ok, tot, rate: tot ? +(ok / tot).toFixed(4) : 0 };
    }
    notes.push(`量词率（跨角色，口径=**近独占而非严格独占**）：${JSON.stringify(rows)} —— 团子/桃子亦有零星「记账」类命中（如 tuanzi memory.appointment 已归位；残留命中已在 t54 报告登记），故 B2 只主张**黑咖覆盖下限**，不主张"他角色不得用量词"`);
  }
}


// ── 3e. GATE FIRST-MEET-POOL：三位恋人的「初见专用台词」池必须存在且 ≥6 条
//   背景（t48 → t58）：Go 侧初见事件**直读 `naming.first_meet`**，命中即用角色专属台词；
//   池缺失/为空 ⇒ 玩家看到的是 `ACT12_LOVER_FIRST_MEET_POOL_UNAVAILABLE` 降级后的**泛化问候**
//   （团子曾因"内容落在 `encounter.first_meet`（路径漂移）"而 0 条，属玩家可见缺陷）。
//   故在语料侧钉住下限，防止未来静默回退。
{
  const rows = {};
  for (const role of ['peach', 'tuanzi', 'heika']) {
    const obj = loaded[`${role}_corpus.json`];
    if (!obj) continue;
    const pool = obj?.naming?.first_meet;
    const n = Array.isArray(pool) ? pool.filter((s) => typeof s === 'string' && s.trim().length > 0).length : 0;
    rows[role] = n;
    if (n < 6) hardFail('FIRST-MEET-POOL', `${role} 的 naming.first_meet 有效条目 ${n} 条（<6）→ 初见会降级为泛化问候（玩家可见）`, { role, count: n });
  }
  notes.push(`初见专用池 naming.first_meet：${JSON.stringify(rows)}（下限 6；Go 侧 t48 用例 TestLoverFirstMeetPoolAgainstRealCorpus 逐人断言 ok=true）`);
}

// ── 3f. GATE KEY-PATH：读者键路径白名单（t59 漂移家族门禁）
//   纯函数实现：真跑与反向用例共用同一份逻辑。
function computeKeyPathGate(files, gaps = KEY_GAPS) {
  const out = { failures: [], present: [], gapsHit: [], staleGaps: [], rows: [] };
  const gapKey = new Set(gaps.map((g) => `${g.role}|${g.path}`));
  for (const role of ['peach', 'tuanzi', 'heika']) {
    const obj = files[`${role}_corpus.json`];
    if (!obj) { out.failures.push({ role, path: '(文件)', why: `${role}_corpus.json 未加载` }); continue; }
    for (const { path: p, kind, src } of KEY_PATHS) {
      const segs = p.split('.');
      let cur = obj;
      for (const s of segs) cur = (cur && typeof cur === 'object') ? cur[s] : undefined;
      let verdict = null, shape = '';
      if (cur === undefined) { verdict = '缺失'; shape = 'undefined'; }
      else if (!Array.isArray(cur)) { verdict = '类型错误'; shape = Array.isArray(cur) ? 'array' : typeof cur; }
      else if (kind === 'stringArray') {
        const good = cur.filter((x) => typeof x === 'string' && x.trim().length > 0).length;
        shape = `array(${cur.length} 条，有效 ${good})`;
        if (good === 0) verdict = '空池';
      } else if (kind === 'mailTemplates') {
        const good = cur.filter((x) => x && typeof x === 'object' && typeof x.dialogue?.[role] === 'string' && x.dialogue[role].trim().length > 0).length;
        shape = `array(${cur.length} 条，${role} 槽有效 ${good})`;
        if (good === 0) verdict = '空池';
      }
      const key = `${role}|${p}`;
      out.rows.push({ role, path: p, src, kind, shape, verdict });
      if (!verdict) { out.present.push({ role, path: p }); if (gapKey.has(key)) out.staleGaps.push({ role, path: p, why: '已在 KEY_GAPS 声明但现已补齐 → 请从清单移除（自清理）' }); continue; }
      if (gapKey.has(key)) out.gapsHit.push({ role, path: p, verdict, shape });
      else out.failures.push({ role, path: p, why: verdict, shape, src, hint: `读者 ${src}；缺则走兜底=玩家可见降级` });
    }
  }
  // 清单里声明了、但实际并不缺的 → 过期条目（防止债务清单只增不减）
  for (const g of gaps) {
    const hit = out.gapsHit.some((h) => h.role === g.role && h.path === g.path);
    const present = out.present.some((h) => h.role === g.role && h.path === g.path);
    if (present && !hit) out.staleGaps.push({ role: g.role, path: g.path, why: 'KEY_GAPS 声明为缺口，实测已存在 → 过期条目，请移除' });
  }
  return out;
}
{
  const g = computeKeyPathGate(loaded);
  // 文件级读者契约（t60 白名单扩展）
  const missingFiles = KEY_FILE_READERS.filter((r) => loaded[r.file] === undefined);
  if (missingFiles.length) hardFail('KEY-FILE', `文件级读者契约缺失 ${missingFiles.length} 份：${missingFiles.map((m) => m.file).join('、')}`, { readers: missingFiles });
  notes.push(`文件级读者契约（t60 扩展）：${KEY_FILE_READERS.map((r) => r.file).join('、')} —— 读者：${[...new Set(KEY_FILE_READERS.flatMap((r) => r.readers.map((x) => x.split(':')[0])))].join(' / ')}`);
  if (g.failures.length) {
    hardFail('KEY-PATH', `读者键路径缺失/空池 ${g.failures.length} 处（新漂移，未被 KEY_GAPS 声明）`, { samples: g.failures.slice(0, 8) });
  }
  if (g.staleGaps.length) {
    hardFail('KEY-GAP-STALE', `KEY_GAPS 有 ${g.staleGaps.length} 条过期条目（已补齐或不存在缺口）→ 请更新清单`, { samples: g.staleGaps.slice(0, 8) });
  }
  notes.push(`读者键路径白名单：共 ${KEY_PATHS.length} 条 × 3 角色 = ${KEY_PATHS.length * 3} 项断言；满足 ${g.present.length} 项，**已知缺口 ${g.gapsHit.length} 项（KEY_GAPS 声明，见一致性报告）**`);
  const gapByRole = {};
  for (const h of g.gapsHit) gapByRole[h.role] = [...(gapByRole[h.role] || []), h.path];
  for (const [r, list] of Object.entries(gapByRole)) notes.push(`  ⚠ ${r} 已知键路径缺口 ${list.length} 条：${list.join('、')}`);
  // --key-report：把白名单断言与顶层键集合差异落成可复核的 JSON（供一致性报告引用）
  if (argv.includes('--key-report')) {
    const topLevel = {};
    for (const role of ['peach', 'tuanzi', 'heika']) {
      const obj = loaded[`${role}_corpus.json`];
      topLevel[role] = obj ? Object.keys(obj).sort() : null;
    }
    const allTop = [...new Set(Object.values(topLevel).flatMap((x) => x || []))].sort();
    const topDiff = allTop.map((k) => ({ key: k, missingIn: ['peach', 'tuanzi', 'heika'].filter((r) => !(topLevel[r] || []).includes(k)) }))
      .filter((x) => x.missingIn.length > 0);
    const report = {
      generated_at: new Date().toISOString(),
      whitelist_export_cmds: [
        'cd D:\\GitHub\\xiyu-ai && rg -n "hotData\\.[a-zA-Z_]+(\\?\\.[a-zA-Z_]+)?" src/game_dnf.mjs',
        'cd D:\\GitHub\\xiyu-ai && rg -n "\\?\\.mail_templates" src/game_dnf.mjs',
        'cd D:\\GitHub\\dnf-robot-act12 && rg -n "loverFirstMeetSceneKey|loverFirstMeetTopKey" internal/composition/backend/act12/lover_corpus_pool.go',
      ],
      whitelist: KEY_PATHS, assertions: g.rows, satisfied: g.present, known_gaps: g.gapsHit, stale_gaps: g.staleGaps,
      file_level_readers: KEY_FILE_READERS,
      top_level_keys: topLevel, top_level_diff: topDiff,
    };
    fs.mkdirSync(path.resolve('logs'), { recursive: true });
    const rp = path.resolve('logs/key_path_report.json');
    fs.writeFileSync(rp, JSON.stringify(report, null, 2) + '\n', 'utf-8');
    console.log(`[verify_corpus_v3] 键路径报告已落盘：${rp}`);
  }
}

// ── 3h. GATE PENDING-READER（t72）：**内容预留键**——读者尚未落地，故**不进 KEY_PATHS**
//   原则沿用 t59：「白名单以**代码真实读点**为据」。t72 新增的 4 组键（return_reunion / followup /
//   farewell / silence_note）**当前无任何读者**（`rg` 于 src/ 与 internal/ 均 0 命中；db 里的
//   `expected_followup` 是**同名无关列**）。但内容既已落盘，就不能"悄悄消失" ⇒ 用本清单做
//   **存在性/类型/非空**断言（**非**读者契约），并明确标注：当 Go 侧 `return_reunion` 等实现落地后，
//   应把它们**移入 KEY_PATHS**。
const KEY_PATHS_PENDING_READER = [
  { path: 'naming.return_reunion', kind: 'tieredStringArray', note: '设计 §5.2：B 支回归三档（gap_3_4 / gap_5_9 / gap_10_plus）；读者=待实现的 `return_reunion` 事件' },
  { path: 'social.followup', kind: 'tieredStringArray', note: '追问三档（continue_topic / share / discuss）；读者=待实现的追问链路（t66）' },
  { path: 'social.farewell', kind: 'stringArray', note: '告别收尾语；读者=待实现的告别识别' },
  { path: 'social.silence_note', kind: 'stringArray', note: '§21.5 静默期「她还在」信号（每 7 天 ≤1 封）；读者=待实现的静默投递' },
];
{
  const rows = [];
  for (const role of ['peach', 'tuanzi', 'heika']) {
    const obj = loaded[`${role}_corpus.json`];
    if (!obj) continue;
    for (const { path: p, kind, note } of KEY_PATHS_PENDING_READER) {
      const cur = p.split('.').reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), obj);
      let ok = false, shape = '';
      if (cur === undefined) shape = 'undefined';
      else if (kind === 'stringArray') { ok = Array.isArray(cur) && cur.filter((x) => typeof x === 'string' && x.trim()).length > 0; shape = `array(${Array.isArray(cur) ? cur.length : 'n/a'})`; }
      else if (kind === 'tieredStringArray') {
        const tiers = cur && typeof cur === 'object' && !Array.isArray(cur) ? Object.entries(cur) : [];
        const good = tiers.filter(([, v]) => Array.isArray(v) && v.filter((x) => typeof x === 'string' && x.trim()).length > 0);
        ok = tiers.length > 0 && good.length === tiers.length;
        shape = `{${tiers.map(([k, v]) => `${k}:${Array.isArray(v) ? v.length : 'n/a'}`).join(', ')}}`;
      }
      rows.push({ role, path: p, ok, shape });
      if (!ok) hardFail('PENDING-READER', `${role} 的内容预留键 ${p} 缺失/空池（${shape}）——内容已声明落地却不存在`, { role, path: p, shape, note });
    }
  }
  notes.push(`内容预留键（**未进 KEY_PATHS**，因读者未落地）：${KEY_PATHS_PENDING_READER.map((k) => k.path).join('、')} —— 存在/类型/非空断言 ${rows.filter((r) => r.ok).length}/${rows.length}；实现落地后应移入 KEY_PATHS`);
}

// ── 4. GATE DUP：同角色 / 跨角色逐字重复 ──
{
  const roles = ['peach', 'tuanzi', 'heika'];
  const across = [];
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
    const a = chatByRole[roles[i]], b = chatByRole[roles[j]];
    for (const [k, pa] of a) if (b.has(k)) across.push({ text: k, a: roles[i], b: roles[j], pa, pb: b.get(k) });
  }
  if (across.length) hardFail('DUP-CROSS', `跨角色逐字重复 ${across.length} 条`, { samples: across.slice(0, 5) });
  for (const r of roles) {
    if (!chatByRole[r].size) undec('DUP-WITHIN', `${r} 的对白域为空 → 无法判定同角色重复`);
  }
}

// ── 5. GATE REPORT-DEP：遮名测试与仪器校验（由 build 产出，缺 → 不可判定）──
{
  const rp = path.join(DIR, 'staged_report.json');
  if (!fs.existsSync(rp)) {
    // 生产目录按设计只放语料、不放构建产物（staged_report.json 是 build 的产物）。
    // 因此**仅当** --prod 且确证构建产物存在于 staging 时，才降级为 DEFERRED（并显式打印）；
    // 其余任何情况一律 UNDECIDABLE（退出码非 0），不放松"不可判定必须报非 0"。
    const candidates = [path.join(DIR, 'staged_report.json'), path.join(BASE_STAGED, 'staged_report.json'), path.join(PREV_STAGED, 'staged_report.json'), path.join(DEFAULT_STAGED, 'staged_report.json')];
    const reportOwner = candidates.find((p) => fs.existsSync(p)) || null;
    if (reportOwner) {
      defer('MASK/INSTRUMENT', `本目录不含构建产物（按设计：生产/下游 staged 目录只放语料）；遮名校验与 GBK 仪器校验已在构建目录核过：${reportOwner}`);
    } else {
      undec('MASK/INSTRUMENT', 'staged_report.json 缺失 → 遮名测试与 GBK 仪器校验不可复现');
    }
  } else {
    const rep = JSON.parse(fs.readFileSync(rp, 'utf-8'));
    const m = rep.mask_test || {};
    if (!m.accuracy) undec('MASK', 'staged_report.json 无 mask_test.accuracy');
    else {
      for (const r of ['peach', 'tuanzi', 'heika']) {
        if ((m.sampled?.[r] || 0) < 30) hardFail('MASK', `${r} 遮名抽样不足 30（实际 ${m.sampled?.[r]}）`);
        else if ((m.accuracy[r] || 0) < 0.5) hardFail('MASK', `${r} 遮名唯一归属率 ${m.accuracy[r]} < 0.5`);
      }
    }
    const ins = rep.instrument || {};
    const ok = (ins.sources || []).some((s) => s.checked > 0 && (s.rate || 0) >= 0.99);
    if (!ins.sources) undec('INSTRUMENT', 'staged_report.json 无 instrument.sources');
    else if (!ok) hardFail('INSTRUMENT', 'GBK 计数器未通过与草稿自带字节标注的交叉验证（≥0.99）', { sources: ins.sources });
  }
}

// ── 6. GATE t37：G-K1..G-K8 ──
{
  const cc = loaded['calendar_contract.json'];
  if (!cc) undec('G-K*', 'calendar_contract.json 缺失 → t37 八门禁不可判定');
  else {
    const revoked = new Set(cc.revoked_keys || []);
    const allowed = new Set(cc.unlock_keys_allowed || []);
    const byDay = cc.by_day || {};
    // G-K2 白名单
    const seen = new Set();
    for (const [d, v] of Object.entries(byDay)) for (const k of [...(v.content_keys || []), ...(v.carrier_keys || [])]) {
      if (!allowed.has(k)) hardFail('G-K2', `${d} 出现白名单外 key: ${k}`);
      if (seen.has(k)) hardFail('G-K1', `key 重复投放: ${k}`);
      seen.add(k);
    }
    // G-K1 每日唯一（内容级）
    for (const [d, v] of Object.entries(byDay)) {
      const n = (v.content_keys || []).length;
      if (d === 'D0') { if (n !== 0) hardFail('G-K1', `D0 不应有内容级 unlock（实际 ${n}）`); }
      else if (n !== 1) hardFail('G-K1', `${d} 内容级 unlock 应为 1，实际 ${n}`);
    }
    // G-K3 天数完整性
    for (let i = 1; i <= 7; i++) if (!byDay[`D${i}`]) hardFail('G-K3', `缺 D${i} 的行`);
    // G-K4 D3 归属
    if ((byDay.D3?.content_keys || []).join() !== 'unlock_media_areachat') hardFail('G-K4', `D3 内容级应为 unlock_media_areachat，实际 ${JSON.stringify(byDay.D3?.content_keys)}`);
    if (!(byDay.D3?.carrier_keys || []).includes('unlock_gallery_ch1')) hardFail('G-K4', 'D3 载体级应含 unlock_gallery_ch1');
    // G-K5 D7 章序 + revoked 0 命中
    if ((byDay.D7?.content_keys || []).join() !== 'unlock_gallery_ch2') hardFail('G-K5', `D7 内容级应为 unlock_gallery_ch2，实际 ${JSON.stringify(byDay.D7?.content_keys)}`);
    for (const k of revoked) if (seen.has(k)) hardFail('G-K5', `已作废 key 被投放: ${k}`);
    // G-K6 黄字 0
    if ((cc.quota?.yellow_in_d0_d7 ?? 0) !== 0) hardFail('G-K6', `D0–D7 黄字应为 0，实际 ${cc.quota?.yellow_in_d0_d7}`);
    // G-K8 未回上限（X-6 更正）
    const ua = cc.quota?.unanswered_regular_cap;
    if (ua !== 2) hardFail('G-K8', `完全未回上限应为 2（X-6 更正），实际 ${ua}`);
    // X-7 口径：10 分钟窗口 = 全媒介
    if (cc.quota?.cross_channel_scope !== 'all_media') hardFail('G-K8', `10 分钟窗口口径应为 all_media（X-7），实际 ${cc.quota?.cross_channel_scope}`);
    // 逐日配额自洽
    const tot = cc.quota?.per_day_total || {};
    const sum = Object.values(tot).reduce((a, b) => a + b, 0);
    if (Object.keys(tot).length !== 8) hardFail('G-K7', 'per_day_total 应覆盖 D0–D7 共 8 天');
    for (const [d, v] of Object.entries(tot)) {
      if (v < 0) hardFail('G-K7', `${d} 配额为负`);
      if ((cc.quota?.shared_regular_and_penetration_daily_cap || 0) < v) hardFail('G-K7', `${d} 单日 ${v} 超共享上限`);
    }
    // G-K7 运行时项 → DEFERRED（必须带 L-3 事后滑窗）
    defer('G-K7', '配额实测依赖运行时账本 lover_ledger.sqlite 与投递日志；须由 t27 程序执行（含 L-3 事后滑窗层）。本校验器只做静态自洽，不代跑。');
    notes.push(`逐日配额合计 = ${sum}（共享池最高 D3=5/6，已裁定接受；擦线日 ${JSON.stringify(cc.quota?.no_new_reason_for)} 不得再增派主动理由）`);
  }
}

// ── 输出 ──
const summary = {
  dir: DIR, mode: USE_PROD ? 'prod' : 'staged',
  files: Object.keys(loaded), leaves: totalLeaves, dialogue_leaves: dialogueLeaves,
  hard_failures: issues, deferred, undecidable, notes,
};
console.log(JSON.stringify(summary, null, 2));
console.log(`[verify_corpus_v3] files=${Object.keys(loaded).length} leaves=${totalLeaves} dialogue=${dialogueLeaves}`);
console.log(`[verify_corpus_v3] hard_failures=${issues.length} deferred=${deferred.length} undecidable=${undecidable.length}`);
for (const i of issues) console.log(`  FAIL ${i.gate}: ${i.problem}`);
for (const d of deferred) console.log(`  DEFERRED ${d.gate}: ${d.why.slice(0, 120)}`);
for (const u of undecidable) console.log(`  UNDECIDABLE ${u.gate}: ${u.why}`);
// 输出落点：**绝不写入被校验目录**（--prod 时写进语料目录会污染生产）
const OUT_LOG_DIR = path.resolve('logs');
fs.mkdirSync(OUT_LOG_DIR, { recursive: true });
const outPath = path.join(OUT_LOG_DIR, `verify_corpus_v3_output${USE_PROD ? '-prod' : ''}.json`);
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n', 'utf-8');
console.log(`[verify_corpus_v3] 报告落盘（不在被校验目录内）：${outPath}`);

if (issues.length) process.exit(EXIT_FAIL);
if (undecidable.length) process.exit(EXIT_UNDECIDABLE);
if (STRICT && deferred.length) { console.error('[verify_corpus_v3] --strict-deferred：存在未执行的运行时门禁 → 拒绝出结论'); process.exit(EXIT_UNDECIDABLE); }
process.exit(EXIT_OK);
