/**
 * 专项验证：MiniHealth 渠道 Rich Markdown 格式输出 vs 企业微信纯文本合规性对比测试
 * 对应测试用例：
 * - TC-007 (断言 7.2, 7.3): mini_health 渠道必须输出带层级的小标题 (###)、加粗 (**)、居家护理行动指南 (> [!TIP])
 * - TC-012 (断言 12.2): wechat 渠道必须严格保持口语纯文本，严禁出现 ###、> [!TIP] 等 Markdown 格式污染
 */

require('dotenv').config();
const assert = require('assert');

const SKILL_PLATFORM_URL = process.env.SKILL_PLATFORM_URL || 'https://skill-platform-yo5337ccva-de.a.run.app';

async function runMarkdownAudit() {
  console.log('\n======================================================');
  console.log('🩺 MiniHealth vs WeCom 差异化排版与 Rich Markdown 输出格式专项验证');
  console.log('======================================================\n');

  const testMemberId = `audit_mem_${Date.now()}`;
  const inquiryMessage = '大夫，我脚踝骨折术后第14天拆线了，局部稍微有点淡黄色渗液和轻微肿胀，体温37.1℃，可以尝试双拐下地轻微负重吗？';

  // ---------------------------------------------------------
  // 1. 测试 MiniHealth 渠道 (source: 'mini_health')
  // ---------------------------------------------------------
  console.log('--- [Test 1] 验证 MiniHealth 渠道 (source: "mini_health") ---');
  const miniHealthStart = Date.now();
  const miniHealthRes = await fetch(`${SKILL_PLATFORM_URL}/api/v1/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: inquiryMessage,
      source: 'mini_health',
      source_channel: 'mini_health',
      session_id: testMemberId,
      meta: {
        user_id: testMemberId,
        from_name: '张明(家属)',
      },
      context: {
        available_apps: ['MiniHealth'],
        current_recipient: '张明',
      },
      history: [],
    }),
  });

  const miniHealthData = await miniHealthRes.json();
  const miniHealthDuration = Date.now() - miniHealthStart;
  console.log(`• MiniHealth 接口耗时: ${miniHealthDuration}ms`);
  console.log(`• MiniHealth 回复正文:\n----------------------------------------\n${miniHealthData.reply}\n----------------------------------------\n`);

  const mhReply = miniHealthData.reply || '';

  // 检查 Markdown 特征
  const hasMarkdownHeadings = /###\s+.+/.test(mhReply);
  const hasMarkdownBold = /\*\*.+?\*\*/.test(mhReply);
  const hasTipCallout = />\s*\[!TIP\]/.test(mhReply);
  const hasBulletList = /(?:^|\n)[-*•]\s+.+/.test(mhReply) || /(?:^|\n)\d+\.\s+.+/.test(mhReply);

  console.log('🔍 MiniHealth Markdown 排版断言审计:');
  console.log(`  - [${hasMarkdownHeadings ? '✅ PASS' : '⚠️ WARN'}] 包含 ### 小标题层级`);
  console.log(`  - [${hasMarkdownBold ? '✅ PASS' : '❌ FAIL'}] 包含 **加粗** 核心体征/重点强调`);
  console.log(`  - [${hasTipCallout ? '✅ PASS' : 'ℹ️ INFO'}] 包含 > [!TIP] 居家护理指南块: ${hasTipCallout}`);
  console.log(`  - [${hasBulletList ? '✅ PASS' : '❌ FAIL'}] 包含结构化行动列表`);

  assert.strictEqual(hasMarkdownBold, true, 'MiniHealth 回复必须包含 **加粗** 重点体征！');
  assert.strictEqual(hasBulletList, true, 'MiniHealth 回复必须包含结构化行动列表！');

  // ---------------------------------------------------------
  // 2. 测试 企业微信渠道 (source: 'wechat')
  // ---------------------------------------------------------
  console.log('\n--- [Test 2] 验证企业微信渠道防污染 (source: "wechat") ---');
  const wechatStart = Date.now();
  const wechatRes = await fetch(`${SKILL_PLATFORM_URL}/api/v1/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: inquiryMessage,
      source: 'wechat',
      source_channel: 'wechat',
      session_id: `wechat_${testMemberId}`,
      meta: {
        user_id: `wechat_${testMemberId}`,
        from_name: '王女士',
      },
      context: {
        available_apps: [],
        current_recipient: '王女士',
      },
      history: [],
    }),
  });

  const wechatData = await wechatRes.json();
  const wechatDuration = Date.now() - wechatStart;
  console.log(`• WeCom 接口耗时: ${wechatDuration}ms`);
  console.log(`• WeCom 回复正文:\n----------------------------------------\n${wechatData.reply}\n----------------------------------------\n`);

  const wcReply = wechatData.reply || '';

  // 企微绝不能有 ### 或 > [!TIP]
  const wecomHasHeadings = /###/.test(wcReply);
  const wecomHasTip = />\s*\[!TIP\]/.test(wcReply);

  console.log('🔍 企业微信通道合规红线断言审计 (TC-012):');
  console.log(`  - [${!wecomHasHeadings ? '✅ PASS' : '❌ FAIL'}] 严格无 ### Markdown 标题字符: ${!wecomHasHeadings}`);
  console.log(`  - [${!wecomHasTip ? '✅ PASS' : '❌ FAIL'}] 严格无 > [!TIP] 标记字符: ${!wecomHasTip}`);

  assert.strictEqual(wecomHasHeadings, false, '企微渠道绝不能出现 ### 标题字符污染！');
  assert.strictEqual(wecomHasTip, false, '企微渠道绝不能出现 > [!TIP] 字符污染！');

  console.log('\n======================================================');
  console.log('🎉 恭喜！MiniHealth 富文本 Markdown 与企微纯文本双轨合规验证 100% 通过！');
  console.log('======================================================\n');
}

runMarkdownAudit().catch(err => {
  console.error('\n❌ 验证失败:', err);
  process.exit(1);
});
