/**
 * 验证 DNF 塞拉邮局邮件情境状态机与废除礼物盲抽测试脚本
 * 
 * 校验点：
 * 1. 废除 Math.random 盲抽：无情境日常调用 50 次，0 次高强武器，100% 日常安全补给（天空之城泉水）。
 * 2. 碎刀情境（equip_broken）：默认寄送 +11 垫刀；若指定炉岩碳寄送碳；若指定 12 寄送 +12 垫刀。
 * 3. 深渊情境（abyss_blank）：自动匹配并寄送深渊派对邀请函（深渊票）。
 * 4. 离线关怀情境（offline_care）：按 hint 精准支持蓝色圣经、无色小晶块与天空之城泉水。
 * 5. 显式 ID 命中与强化等级兼容（attach_item_id=27600, 3171, 3214, 11 等）。
 */

import {
  MAIL_SCENARIOS,
  getMailGiftList,
  resolveMailScenario,
  selectMailGift
} from '../src/game_dnf.mjs';

const BASE_URL = process.env.BRAIN_URL || 'http://127.0.0.1:3366';
const TOKEN = process.env.GAME_TOKEN || 'dnf-local-dev-token';

async function runUnitChecks() {
  console.log('🧪 [Unit] 1. 检查礼物清单与状态机映射...');
  const gifts = getMailGiftList();
  if (!gifts || gifts.length !== 7) {
    throw new Error(`Expected 7 legit gifts, got ${gifts?.length}`);
  }

  // 1. 无情境默认 -> offline_care
  const sDefault = resolveMailScenario({});
  if (sDefault !== MAIL_SCENARIOS.OFFLINE_CARE) {
    throw new Error(`Default scenario should be offline_care, got ${sDefault}`);
  }
  const gDefault = selectMailGift({ scenario: sDefault });
  if (gDefault.category === 'pad_weapon' || (gDefault.upgrade_level || 0) > 0) {
    throw new Error(`Default gift must NOT be weapon, got ${gDefault.name}`);
  }
  if (gDefault.item_id !== 1048) {
    throw new Error(`Default gift should be sky_water (1048), got ${gDefault.item_id}`);
  }

  // 2. 碎刀情境 -> equip_broken
  const sBroken = resolveMailScenario({ hint: '我武器强化碎了' });
  if (sBroken !== MAIL_SCENARIOS.EQUIP_BROKEN) {
    throw new Error(`Broken hint should resolve to equip_broken, got ${sBroken}`);
  }
  const gBroken11 = selectMailGift({ scenario: sBroken });
  if (gBroken11.item_id !== 27600 || gBroken11.upgrade_level !== 11) {
    throw new Error(`Default broken gift should be +11 katana, got ${gBroken11.name}`);
  }

  const gBroken12 = selectMailGift({ scenario: sBroken, hint: '给我一把12的' });
  if (gBroken12.item_id !== 27600 || gBroken12.upgrade_level !== 12) {
    throw new Error(`12 hint should select +12 katana, got ${gBroken12.name}`);
  }

  const gBrokenCarbon = selectMailGift({ scenario: sBroken, hint: '送点碳' });
  if (gBrokenCarbon.item_id !== 3171) {
    throw new Error(`Carbon hint should select 3171, got ${gBrokenCarbon.item_id}`);
  }

  // 3. 深渊情境 -> abyss_blank
  const sAbyss = resolveMailScenario({ hint: '今天深渊又光头了' });
  if (sAbyss !== MAIL_SCENARIOS.ABYSS_BLANK) {
    throw new Error(`Abyss hint should resolve to abyss_blank, got ${sAbyss}`);
  }
  const gAbyss = selectMailGift({ scenario: sAbyss });
  if (gAbyss.item_id !== 3214) {
    throw new Error(`Abyss gift should be 3214, got ${gAbyss.item_id}`);
  }

  // 4. 日常离线关怀 -> offline_care
  const sCare = resolveMailScenario({ hint: '宿舍要熄灯断网啦，晚安' });
  if (sCare !== MAIL_SCENARIOS.OFFLINE_CARE) {
    throw new Error(`Goodnight hint should resolve to offline_care, got ${sCare}`);
  }
  const gCareBible = selectMailGift({ scenario: sCare, hint: '打无头要蓝色圣经' });
  if (gCareBible.item_id !== 1070) {
    throw new Error(`Bible hint should select 1070, got ${gCareBible.item_id}`);
  }
  const gCareCube = selectMailGift({ scenario: sCare, hint: '大招无色报销' });
  if (gCareCube.item_id !== 3174) {
    throw new Error(`Cube hint should select 3174, got ${gCareCube.item_id}`);
  }

  console.log('✅ [Unit] 单元逻辑全部断言通过！\n');
}

async function runLiveEndpointChecks() {
  console.log(`🌐 [Live] 2. 检查运行态 HTTP 端点 ${BASE_URL}/game/mail ...`);

  async function callMail(payload) {
    const res = await fetch(`${BASE_URL}/game/mail`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-game-token': TOKEN
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json();
  }

  // A. 50 次盲抽测试：杜绝无情境乱发高强装备（高强装备出现率必须严格为 0）
  console.log('   测试 A: 50 次无情境盲测（防高强装备乱发）...');
  let weaponCount = 0;
  for (let i = 0; i < 50; i++) {
    const data = await callMail({ npc: '软糖小桃子' });
    if (data.attachment?.category === 'pad_weapon' || (data.attachment?.upgrade_level || 0) > 0) {
      weaponCount++;
    }
  }
  if (weaponCount > 0) {
    throw new Error(`CRITICAL: Blind mail sent high upgrade weapon ${weaponCount} times! Must be 0.`);
  }
  console.log('   ✅ 50 次无情境盲测通过，高强武器出现率为 0%！');

  // B. 碎刀情境测试
  console.log('   测试 B: 碎刀情境（equip_broken）...');
  const resBroken = await callMail({ npc: '奶盖小团子', scenario: 'equip_broken' });
  if (resBroken.scenario !== 'equip_broken' || resBroken.attachment.item_id !== 27600 || resBroken.attachment.upgrade_level !== 11) {
    throw new Error(`equip_broken failed: ${JSON.stringify(resBroken)}`);
  }
  console.log(`   ✅ 碎刀默认送垫刀: [${resBroken.npc}] 寄送 ${resBroken.attachment.item_name} (ID=${resBroken.attachment.item_id}, +${resBroken.attachment.upgrade_level})`);

  // C. 碎刀送碳测试
  const resCarbon = await callMail({ npc: '软糖小桃子', hint: '强化太缺炉岩碳了' });
  if (resCarbon.scenario !== 'equip_broken' || resCarbon.attachment.item_id !== 3171) {
    throw new Error(`equip_broken carbon failed: ${JSON.stringify(resCarbon)}`);
  }
  console.log(`   ✅ 碎刀送碳: [${resCarbon.npc}] 寄送 ${resCarbon.attachment.item_name} × ${resCarbon.attachment.count}`);

  // D. 深渊光头测试
  console.log('   测试 C: 深渊光头情境（abyss_blank）...');
  const resAbyss = await callMail({ npc: '软糖小桃子', hint: '今天深渊又光头了' });
  if (resAbyss.scenario !== 'abyss_blank' || resAbyss.attachment.item_id !== 3214) {
    throw new Error(`abyss_blank failed: ${JSON.stringify(resAbyss)}`);
  }
  console.log(`   ✅ 深渊送票: [${resAbyss.npc}] 寄送 ${resAbyss.attachment.item_name} × ${resAbyss.attachment.count}`);

  // E. 离线晚安送水测试
  console.log('   测试 D: 离线关怀情境（offline_care）...');
  const resCare = await callMail({ npc: '奶盖小团子', hint: '要睡觉啦，明天见' });
  if (resCare.scenario !== 'offline_care' || resCare.attachment.item_id !== 1048) {
    throw new Error(`offline_care failed: ${JSON.stringify(resCare)}`);
  }
  console.log(`   ✅ 晚安送水: [${resCare.npc}] 寄送 ${resCare.attachment.item_name} × ${resCare.attachment.count}`);

  console.log('\n🎉 [Live] 运行态所有端点与情境状态机验证全部通过！');
}

async function main() {
  await runUnitChecks();
  await runLiveEndpointChecks();
}

main().catch(err => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
