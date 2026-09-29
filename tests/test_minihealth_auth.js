#!/usr/bin/env node
/**
 * 验证 wechat-archiver ↔ mini-health Token 认证是否正常
 * 运行方式：node test_minihealth_auth.js
 */

const GATEWAY_URL = 'https://wechat-archiver-yo5337ccva-uw.a.run.app';
const TOKEN = 'mh_03cca1e541cc0e9c2c6f453583a839576cdada2c4c86c8ba';
const TEST_MEMBER_ID = 'mini_acc_test_001';

function color(code, text) {
  return `\x1b[${code}m${text}\x1b[0m`;
}
const green = t => color(32, t);
const red = t => color(31, t);
const yellow = t => color(33, t);
const bold = t => color(1, t);

async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    const result = await fn();
    console.log(green('✅ PASS') + (result ? ` ${yellow(result)}` : ''));
    return true;
  } catch (e) {
    console.log(red('❌ FAIL') + ` ${e.message}`);
    return false;
  }
}

async function main() {
  console.log(bold('\n=== wechat-archiver MiniHealth 认证验证 ==='));
  console.log(`网关: ${GATEWAY_URL}\n`);

  let passed = 0, total = 0;

  // 1. 健康检查（无需 Token）
  total++;
  if (await test('健康检查 GET /', async () => {
    const r = await fetch(`${GATEWAY_URL}/`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return `HTTP ${r.status}`;
  })) passed++;

  // 2. 无 Token 访问 /api/minihealth/chat → 应该 401
  total++;
  if (await test('无 Token → 应返回 401', async () => {
    const r = await fetch(`${GATEWAY_URL}/api/minihealth/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: TEST_MEMBER_ID, content: '测试' }),
    });
    if (r.status !== 401) throw new Error(`期望 401，实际 ${r.status}`);
    return `HTTP ${r.status}`;
  })) passed++;

  // 3. 错误 Token → 应该 401
  total++;
  if (await test('错误 Token → 应返回 401', async () => {
    const r = await fetch(`${GATEWAY_URL}/api/minihealth/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MiniHealth-Token': 'wrong_token_xyz',
      },
      body: JSON.stringify({ memberId: TEST_MEMBER_ID, content: '测试' }),
    });
    if (r.status !== 401) throw new Error(`期望 401，实际 ${r.status}`);
    return `HTTP ${r.status}`;
  })) passed++;

  // 4. 正确 Token 访问历史记录
  total++;
  if (await test('正确 Token → GET /api/minihealth/history/:id', async () => {
    const r = await fetch(`${GATEWAY_URL}/api/minihealth/history/${TEST_MEMBER_ID}`, {
      headers: { 'X-MiniHealth-Token': TOKEN },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    const data = await r.json();
    return `HTTP ${r.status}, history.length=${data.count ?? data.history?.length ?? '?'}`;
  })) passed++;

  // 5. 正确 Token 发送聊天（只验证格式，不等待完整 LLM 回复）
  total++;
  if (await test('正确 Token → POST /api/minihealth/chat（简短问题）', async () => {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch(`${GATEWAY_URL}/api/minihealth/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MiniHealth-Token': TOKEN,
        },
        body: JSON.stringify({
          memberId: TEST_MEMBER_ID,
          memberName: '测试用户',
          content: '你好，我想了解高血压的注意事项',
          mediaType: 'text',
        }),
        signal: ctrl.signal,
      });
      clearTimeout(tid);
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      const data = await r.json();
      if (!data.reply) throw new Error('响应中缺少 reply 字段');
      return `HTTP ${r.status}, reply前30字: "${data.reply.slice(0, 30)}..."`;
    } catch (e) {
      clearTimeout(tid);
      throw e;
    }
  })) passed++;

  console.log(`\n${bold('结果：')} ${passed}/${total} 通过`);
  if (passed === total) {
    console.log(green('✅ 所有验证通过！wechat-archiver ↔ mini-health 认证链路正常\n'));
    process.exit(0);
  } else {
    console.log(red(`❌ ${total - passed} 项失败，请检查部署\n`));
    process.exit(1);
  }
}

main().catch(e => {
  console.error(red('\n致命错误：'), e.message);
  process.exit(1);
});
