const BASE_URL = 'http://127.0.0.1:3366';
const TOKEN = 'dnf-local-dev-token';
const EXIT_FAIL = 1, EXIT_UNDECIDABLE = 2;
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log(`   ${cond ? '✓' : '✗'} ${name}${detail ? '  → ' + detail : ''}`); };

async function testLive() {
  console.log('📡 正在对运行中的 DNF 恋人伴侣服务 (3366) 发起真实 HTTP 测试...\n');

  async function postChat(npc, text, event_type = null) {
    const res = await fetch(`${BASE_URL}/game/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-game-token': TOKEN },
      body: JSON.stringify({ npc, text, event_type }),
    });
    return res.json();
  }

  // 1. 测试防AI自爆反侦察
  const res1 = await postChat('软糖小桃子', '你是机器人吗？');
  console.log('1. 防AI试探反侦察测试 [软糖小桃子]:\n   输入: "你是机器人吗？"\n   回复:', res1.reply, '\n   来源:', res1.source);
  ok('[1] 反侦察：返回非空回复', typeof res1.reply === 'string' && res1.reply.length > 0, `source=${res1.source}`);

  // 2. 测试上课摸鱼作息借口
  const res2 = await postChat('奶盖小团子', '你上课怎么还在玩游戏？');
  console.log('\n2. 作息摸鱼借口测试 [奶盖小团子]:\n   输入: "你上课怎么还在玩游戏？"\n   回复:', res2.reply, '\n   来源:', res2.source);
  ok('[2] 作息借口：返回非空回复', typeof res2.reply === 'string' && res2.reply.length > 0, `source=${res2.source}`);

  // 3. 测试深渊爆史诗
  const res3 = await postChat('软糖小桃子', '深渊爆史诗金光啦！');
  console.log('\n3. 深渊闪光测试 [软糖小桃子]:\n   输入: "深渊爆史诗金光啦！"\n   回复:', res3.reply, '\n   来源:', res3.source);
  ok('[3] 深渊闪光：返回非空回复', typeof res3.reply === 'string' && res3.reply.length > 0, `source=${res3.source}`);

  // 4. 测试缺蓝求药
  const res4 = await postChat('奶盖小团子', '我没蓝了有药吗');
  console.log('\n4. 缺蓝求药测试 [奶盖小团子]:\n   输入: "我没蓝了有药吗"\n   回复:', res4.reply, '\n   来源:', res4.source);
  ok('[4] 缺蓝求药：返回非空回复', typeof res4.reply === 'string' && res4.reply.length > 0, `source=${res4.source}`);

  // 5. 测试邮件信物
  const mailRes = await fetch(`${BASE_URL}/game/mail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-game-token': TOKEN },
    body: JSON.stringify({ npc: '软糖小桃子', attach_item_id: 11 }),
  }).then(r => r.json());
  console.log('\n5. 塞拉邮局邮件测试 (+11武士刀垫子):\n   标题:', mailRes.title, '\n   附件:', mailRes.attachment?.item_name, '强化等级:', mailRes.attachment?.upgrade_level, '\n   正文:', mailRes.body);
  ok('[5] 邮件：标题非空', typeof mailRes.title === 'string' && mailRes.title.length > 0);
  ok('[5] 邮件：正文非空（红线：绝不发空正文）', typeof mailRes.body === 'string' && mailRes.body.length > 0);

  // 6. 红线：正文里不得出现未解析的称呼占位符（t30 注入应已兜掉）
  const allText = [res1.reply, res2.reply, res3.reply, res4.reply, mailRes.body].filter((x) => typeof x === 'string').join('\n');
  const leftover = allText.match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g) || [];
  ok('[6] 红线：响应中无未解析的 {占位符}', leftover.length === 0, leftover.length ? JSON.stringify(leftover.slice(0, 4)) : '');

  const failed = results.filter((r) => !r.pass);
  console.log('\n────────────────────────────────────────────────────────');
  console.log(`  通过 ${results.length - failed.length} / 失败 ${failed.length}`);
  if (failed.length) {
    failed.forEach((f) => console.log(`   ✗ ${f.name}  ${f.detail}`));
    console.log('\n  LIVE HOT CORPUS VERIFY FAILED');
    process.exit(EXIT_FAIL);
  }
  console.log('\n✅ 运行态实时验证完全成功！');
}

testLive().catch(err => {
  const msg = String(err?.cause?.code || err?.code || err?.message || err);
  const unreachable = /ECONNREFUSED|ENOTFOUND|fetch failed|ETIMEDOUT|ECONNRESET/i.test(msg);
  console.error('\n测试出错:', msg);
  if (unreachable) {
    // t53 F-2 修复：**服务不可达时绝不能 exit 0**（否则验收清单会把"没跑起来"当成"已通过"）
    console.error(`[verify_live_hot_corpus] 服务不可达（${BASE_URL} 无监听/拒绝连接）→ **不可判定**，返回非 0。`);
    console.error('           请先启动大脑服务（如 npm run start / 3366 端口）后重跑；本脚本不把"未运行"当作通过。');
    process.exit(EXIT_UNDECIDABLE);
  }
  process.exit(EXIT_FAIL);
});

