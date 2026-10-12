import fs from 'fs';
import path from 'path';

const BASE_URL = 'http://127.0.0.1:3366';
const TOKEN = 'dnf-local-dev-token';
const CORPUS_PATH = path.resolve('data/dnf_corpus/peach_corpus.json');

async function testHotReloadLive() {
  console.log('🔥 正在现场实测「零重启文件热更新 (Hot Reload)」性能...\n');

  // 读取现有文件
  const original = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf-8'));
  const testPhrase = `【热更现场直出_${Date.now()}】哥哥你看！我不用重启服务就能学会新台词啦OvO！`;

  // 临时注入到防机器人池
  original.social.anti_bot.unshift(testPhrase);
  fs.writeFileSync(CORPUS_PATH, JSON.stringify(original, null, 2), 'utf-8');
  console.log('1. 已向 peach_corpus.json 动态写入新台词:');
  console.log('   "', testPhrase, '"');

  // 等待 100ms 确保存盘
  await new Promise(r => setTimeout(r, 100));

  // 直接发起 HTTP 请求（服务 PID 保持不变，零重启）
  console.log('\n2. 立即发起 HTTP 私聊请求（未重启 Node 进程，PID 保持运行）:');
  const res = await fetch(`${BASE_URL}/game/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-game-token': TOKEN
    },
    body: JSON.stringify({ npc: '软糖小桃子', text: '你是机器人吗？' })
  }).then(r => r.json());

  console.log('   接口返回回复:', res.reply);
  console.log('   是否命中热更台词:', res.reply === testPhrase ? '✅ 完美命中！' : '❌ 未命中');

  // 复原文件
  original.social.anti_bot = original.social.anti_bot.filter(s => !s.includes('【热更现场直出_'));
  fs.writeFileSync(CORPUS_PATH, JSON.stringify(original, null, 2), 'utf-8');
  console.log('\n3. 测试台词已安全清理复原。');

  if (res.reply === testPhrase) {
    console.log('🎉 恭喜！基于 mtime 的外置语料【零感知、毫秒级热更】机制现场验证 100% 成功！');
  } else {
    console.log('⚠️ 热更检测完成。');
  }
}

testHotReloadLive().catch(console.error);
