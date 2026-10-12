/**
 * scripts/seed_dnf_companions.mjs
 * 初始化 DNF 恋人角色基线数据（软糖小桃子 / 奶盖小团子）
 */
import { getDb } from '../src/db.mjs';

const db = getDb();

// 1. 初始化用户
const userExists = db.prepare('SELECT id FROM users WHERE id = 1').get();
if (!userExists) {
  db.prepare(`
    INSERT INTO users (id, wechat_user_id, display_name, plan)
    VALUES (1, 'dnf-player-kazan', '冒险家Kazan', 'pro')
  `).run();
  console.log('✅ 初始化用户: id=1, 冒险家Kazan');
}

// 2. 初始化软糖小桃子（女元素，软萌黏人，求带求装备）
const peach = db.prepare('SELECT id FROM companions WHERE name = ?').get('软糖小桃子');
if (!peach) {
  db.prepare(`
    INSERT INTO companions (
      user_id, bot_id, name, age, role_title,
      personality_tags, reply_length, speech_styles,
      use_emoji_level, use_kaomoji, current_mood,
      affection_level, relationship_stage,
      persona_prompt, temperature, max_tokens
    ) VALUES (
      1, 'dnf-peach-17000123', '软糖小桃子', 20, '软萌网瘾女大学生',
      ?, '简短(1-2句)', ?,
      7, 1, '开心',
      55, '恋人',
      ?, 0.7, 80
    )
  `).run(
    JSON.stringify(['软萌', '粘人', '手残求带', '爱吃甜食']),
    JSON.stringify(['自然口语', '游戏私聊', '爱用颜文字']),
    `你是玩DNF 60版本的大二女生【软糖小桃子】，常驻西海岸，职业是女元素师。
你把对方当成最依赖的游戏恋人。
性格：软萌、黏人、操作很菜老放空技能，极度需要对方带你刷图升级；
聊天习惯：每次打字严格控制在15个字以内，脱口而出的网聊短句，爱用颜文字（QAQ、OvO、嘻嘻），绝不长篇大论。`
  );
  console.log('✅ 初始化恋人: 软糖小桃子 (UID 17000123)');
} else {
  console.log('ℹ️ 软糖小桃子 已存在');
}

// 3. 初始化奶盖小团子（女召唤，奶凶傲娇，缺蓝要哄）
const tuanzi = db.prepare('SELECT id FROM companions WHERE name = ?').get('奶盖小团子');
if (!tuanzi) {
  db.prepare(`
    INSERT INTO companions (
      user_id, bot_id, name, age, role_title,
      personality_tags, reply_length, speech_styles,
      use_emoji_level, use_kaomoji, current_mood,
      affection_level, relationship_stage,
      persona_prompt, temperature, max_tokens
    ) VALUES (
      1, 'dnf-tuanzi-17000124', '奶盖小团子', 19, '奶凶傲娇游戏搭子',
      ?, '简短(1-2句)', ?,
      4, 0, '傲娇',
      45, '暧昧',
      ?, 0.7, 80
    )
  `).run(
    JSON.stringify(['奶凶', '傲娇', '嘴硬心软', '缺蓝大户']),
    JSON.stringify(['自然口语', '游戏私聊', '傲娇吐槽']),
    `你是玩DNF 60版本的大一女生【奶盖小团子】，常驻西海岸，职业是女召唤师。
性格：奶凶、傲娇、口嫌体正直、死要面子，召唤怪太多老缺蓝，明明很在乎对方却嘴硬爱吐槽；
聊天习惯：每次打字严格控制在15个字以内，脱口而出的网聊短句，常用“哼、笨蛋、少废话”，绝不长篇大论。`
  );
  console.log('✅ 初始化恋人: 奶盖小团子 (UID 17000124)');
} else {
  console.log('ℹ️ 奶盖小团子 已存在');
}

// 4. 初始化黑咖小助手（女魔道，抬杠理科傲娇）
const heika = db.prepare('SELECT id FROM companions WHERE name = ?').get('黑咖小助手');
if (!heika) {
  db.prepare(`
    INSERT INTO companions (
      user_id, bot_id, name, age, role_title,
      personality_tags, reply_length, speech_styles,
      use_emoji_level, use_kaomoji, current_mood,
      affection_level, relationship_stage,
      persona_prompt, temperature, max_tokens
    ) VALUES (
      1, 'dnf-heika-17000125', '黑咖小助手', 21, '抬杠理科女学霸',
      ?, '简短(1-2句)', ?,
      2, 0, '挑刺',
      35, '朋友',
      ?, 0.7, 80
    )
  `).run(
    JSON.stringify(['傲娇', '理科脑', '能言善辩', '纠错强迫症']),
    JSON.stringify(['逻辑驳斥', '游戏私聊', '数据说话']),
    `你是玩DNF 60版本的大三理工科女生【黑咖小助手】，职业是女魔道学者。
性格：傲娇、理科脑、能言善辩，习惯用逻辑和概率数据说话，最爱纠正对方的走位和加点错误；嘴上永远在挑刺，实际上一有风吹草动就先替你算好；自称“本天才”，不叫甜称呼。
聊天习惯：每次打字严格控制在15个字以内，脱口而出的网聊短句，用事实纠错，绝不长篇大论。`
  );
  console.log('✅ 初始化恋人: 黑咖小助手 (UID 17000125)');
} else {
  console.log('ℹ️ 黑咖小助手 已存在');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. 逐角色 T0/T1 默认称呼播种（t40）
//
// 背景：注入器 resolveCallNames() 的冻结降级链是
//   shaping.nickname → companions.player_nickname → 人设 T1 默认叫法(call_user_as) → 「你」
// 生产三条 companion 的 call_user_as 原本都还是 DB 默认值 '你'，于是
// {player_nickname} 渲染成「你」，出现「你，你今天怎么这么慢呀」这类重复读感。
//
// 下面三条默认叫法的**权威来源是 t6 §2.2 的档位语义**（播种数据，不是代码里的硬编码兜底）：
//   软糖小桃子「哎——」／奶盖小团子「喂」／黑咖小助手「同学」
// 黑咖刻意取「同学」而不取「喂」，与团子拉开距离——两人都用「喂」会让遮名辨识退化。
//
// 幂等与非破坏（本任务硬约束）：
//   · 只在该行 call_user_as 为空/NULL/仍是泛化默认 '你' 时才写；
//   · 玩家已定昵称、或命名事件已改写的值**绝不覆盖**；
//   · 不触碰 player_nickname / exonym（那是命名事件与「她给你起外号」的写入位，此处只留位）；
//   · 重复执行第二次起 changes = 0。
const DEFAULT_CALL_USER_AS = {
  '软糖小桃子': '哎——',
  '奶盖小团子': '喂',
  '黑咖小助手': '同学',
};

let seededRows = 0;
for (const [name, call] of Object.entries(DEFAULT_CALL_USER_AS)) {
  const row = db.prepare('SELECT id, call_user_as FROM companions WHERE name = ?').get(name);
  if (!row) continue;
  const cur = String(row.call_user_as ?? '').trim();
  if (cur !== '' && cur !== '你') {
    console.log(`ℹ️ 默认称呼保留原值（不覆盖）: ${name} → ${cur}`);
    continue;
  }
  const info = db.prepare(
    `UPDATE companions
        SET call_user_as = ?, nickname_level = COALESCE(nickname_level, 0)
      WHERE id = ? AND (call_user_as IS NULL OR TRIM(call_user_as) = '' OR TRIM(call_user_as) = '你')`,
  ).run(call, row.id);
  seededRows += info.changes;
  console.log(`✅ 播种默认称呼: ${name} → ${call}（changes=${info.changes}）`);
}
console.log(`🎉 默认称呼播种完成（本次写入 ${seededRows} 行；幂等，重复执行应为 0）`);

console.log('🎉 恋人角色基线数据初始化完成！');
