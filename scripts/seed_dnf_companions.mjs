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

console.log('🎉 恋人角色基线数据初始化完成！');
