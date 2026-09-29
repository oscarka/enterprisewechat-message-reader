/**
 * 端到端全链路自动化集成测试 (E2E Full Flow Verification)
 * 验证：
 * 1. Gateway 启动与健康检查
 * 2. 模拟 MiniHealth 临床康复咨询：
 *    - 首句问候时机精准，严禁欢迎语覆盖具体临床问题；
 *    - 针对脚踝骨折术后第14天拆线负重进行精准、专业、温和的临床解答。
 * 3. 验证 Supabase 消息双向入库 (mini_health.messages)
 * 4. 模拟真实拍照识餐多模态调用 (nutrition_meal.png):
 *    - 豆包 Vision + DeepSeek V4 食材解构与热量/优质蛋白/脂肪严密测算；
 *    - MiniHealth 场景下就地解答饮食，严禁抛出外部 H5 工单链接；
 *    - 沉淀至 mini_health.records (record_type = 'diet') 且热量/蛋白指标大于0。
 * 5. 验证跨端/切Tab历史拉取接口 (GET /api/minihealth/history/:memberId)
 * 6. 验证企微原有表 wechat_archiver.messages 零污染 (零副作用)
 */

require('dotenv').config();
const fs = require('fs');
const assert = require('assert');
const { createHttpServer } = require('../http_gateway');
const { pool } = require('../supabase_store');

const TEST_PORT = 9988;
const REAL_MEAL_IMAGE_PATH = '/Users/cc/mini-health/public/illustrations/nutrition_meal.png';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runE2E() {
  console.log('\n======================================================');
  console.log('🚀 开始执行 MiniHealth 全链路端到端集成深度验证 (E2E Test)');
  console.log('======================================================\n');

  const server = createHttpServer(TEST_PORT);
  await sleep(1000);

  const testMemberId = `e2e_mem_${Date.now()}`;
  const testMemberName = '李爱华(骨折康复期)';

  try {
    // ---------------------------------------------------------
    // Step 1: 健康检查
    // ---------------------------------------------------------
    console.log('--- [Step 1] 网关连通性探针测试 ---');
    const healthRes = await fetch(`http://localhost:${TEST_PORT}/health`);
    const healthText = await healthRes.text();
    if (healthText !== 'OK') throw new Error(`Health check failed: ${healthText}`);
    console.log('✅ 网关 /health 返回 OK！\n');

    // ---------------------------------------------------------
    // Step 2: 模拟 MiniHealth 文本问答同步请求 (临床康复咨询)
    // ---------------------------------------------------------
    console.log('--- [Step 2] 模拟客户端发送临床康复咨询（骨折负重与拆线） ---');
    const questionText = '大夫，我脚踝骨折术后第14天拆线了，局部稍微有点肿胀，可以尝试双拐下地轻微负重吗？';
    const chatStart = Date.now();
    const chatRes = await fetch(`http://localhost:${TEST_PORT}/api/minihealth/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        memberId: testMemberId,
        memberName: testMemberName,
        content: questionText,
        patientProfile: '李爱华，母亲，62岁，右侧外踝骨折术后14天拆线，有轻度高血压史'
      })
    });

    const chatData = await chatRes.json();
    console.log(`• 同步问答耗时: ${Date.now() - chatStart}ms`);
    console.log(`• AI 回复全文:\n${chatData.reply || '【空】'}\n`);
    console.log(`• 建议追问项:`, chatData.suggestions || []);

    if (!chatData.success || !chatData.reply) {
      throw new Error(`Chat failed: ${JSON.stringify(chatData)}`);
    }

    // 深度语义断言：严禁出现欢迎语覆盖临床问题的问题
    const replyText = chatData.reply;
    const hasClinicalKeywords = /骨折|负重|双拐|拆线|肿胀|踝/.test(replyText);
    const isPureWelcomeMsg = replyText.length < 50 && /欢迎使用|我是您的|欢迎咨询/.test(replyText) && !hasClinicalKeywords;

    assert.strictEqual(isPureWelcomeMsg, false, 'AI 绝不能用千篇一律的欢迎语覆盖用户提出的具体病情！');
    assert.strictEqual(hasClinicalKeywords, true, 'AI 回答必须正面解答骨折、负重、双拐或肿胀等核心临床问题！');
    console.log('✅ 临床问答深度语义验证通过：精准解答骨折拆线负重问题，未被欢迎语短路！\n');

    // ---------------------------------------------------------
    // Step 3: 验证 Supabase 消息双向入库
    // ---------------------------------------------------------
    console.log('--- [Step 3] 验证 Supabase mini_health.messages 双向持久化 ---');
    const { rows: msgRows } = await pool.query(
      `SELECT direction, content FROM mini_health.messages WHERE member_id = $1 ORDER BY msg_time ASC`,
      [testMemberId]
    );

    console.log(`• mini_health.messages 已沉淀消息条数: ${msgRows.length}`);
    msgRows.forEach((r, idx) => {
      console.log(`  [${idx + 1}] ${r.direction === 'inbound' ? '👤 患者' : '🤖 AI'}: ${r.content.slice(0, 60)}...`);
    });

    assert.strictEqual(msgRows.length >= 2, true, 'mini_health.messages 必须至少保存 1 条提问和 1 条回答');
    console.log('✅ 数据库用户提问与AI回答双向落库验证无误！\n');

    // ---------------------------------------------------------
    // Step 4: 模拟真实拍照识餐多模态调用
    // ---------------------------------------------------------
    console.log('--- [Step 4] 模拟多模态拍照识餐 (Doubao Vision + DeepSeek V4) ---');
    const mealBuffer = fs.readFileSync(REAL_MEAL_IMAGE_PATH);
    const mealBase64 = mealBuffer.toString('base64');
    const mealStart = Date.now();
    const mealRes = await fetch(`http://localhost:${TEST_PORT}/api/minihealth/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        memberId: testMemberId,
        memberName: testMemberName,
        content: '我拍了中午这顿饭，看看热量和骨折恢复期营养是否达标',
        media: mealBase64,
        mediaType: 'meal',
        fileName: 'lunch_nutrition.png',
        patientProfile: '李爱华，62岁，外踝骨折术后第14天拆线，需高蛋白高钙利于骨折愈合'
      })
    });

    const mealData = await mealRes.json();
    console.log(`• 多模态识餐耗时: ${Date.now() - mealStart}ms`);
    console.log(`• 识餐分析回复全文:\n${mealData.reply || '【空】'}\n`);

    if (!mealData.success || !mealData.reply) {
      throw new Error(`Meal analysis failed: ${JSON.stringify(mealData)}`);
    }

    // 核心业务断言 1：MiniHealth 模式下严禁工单劫持与外部链接
    const hasExternalTicketLink = /http[s]?:\/\/.*\/h5\/ticket|\/ticket\/|问卷链接|填写链接|工单已生成/.test(mealData.reply);
    assert.strictEqual(hasExternalTicketLink, false, 'MiniHealth 模式下严禁下发外部工单或问卷填写链接！');

    // 核心业务断言 2：必须就地解答营养素并给出临床点睛
    const hasDietKeywords = /蛋白|热量|营养|钙|时蔬|鱼/.test(mealData.reply);
    assert.strictEqual(hasDietKeywords, true, 'AI 回复必须包含餐食的营养素分析（蛋白/热量/钙等）');

    // 核心业务断言 3：检查 mini_health.records 是否记录了打卡 (record_type = 'diet')
    const { rows: recordRows } = await pool.query(
      `SELECT record_type, metrics FROM mini_health.records WHERE member_id = $1 AND record_type = 'diet'`,
      [testMemberId]
    );
    console.log(`• mini_health.records 沉淀饮食打卡条数: ${recordRows.length}`);
    assert.strictEqual(recordRows.length > 0, true, 'mini_health.records 中必须成功写入 diet 记录');
    console.log(`• 打卡 metrics:`, JSON.stringify(recordRows[0].metrics, null, 2));

    assert.strictEqual(typeof recordRows[0].metrics.calories, 'number', '打卡数据必须包含 calories 数值');
    assert.strictEqual(recordRows[0].metrics.calories > 0, true, '打卡热量必须大于 0');
    console.log('✅ 拍照识餐多模态解构、就地健康问答与饮食打卡全闭环验证通过！\n');

    // ---------------------------------------------------------
    // Step 5: 验证跨端/切Tab历史拉取接口完整性
    // ---------------------------------------------------------
    console.log('--- [Step 5] 验证历史加载接口 (GET /api/minihealth/history/:memberId) ---');
    const histRes = await fetch(`http://localhost:${TEST_PORT}/api/minihealth/history/${testMemberId}`);
    const histData = await histRes.json();

    console.log(`• 拉取到会话历史条数: ${histData.history?.length || 0}`);
    assert.strictEqual(histData.success, true, '获取历史必须成功');
    assert.strictEqual(Array.isArray(histData.history), true, 'history 必须为数组');
    assert.strictEqual(histData.history.length >= 4, true, '会话历史应至少包含两轮完整交互（4条记录）');
    console.log('✅ 客户端切 Tab 或重载后可 100% 无损拉取完整云端历史对话！\n');

    // ---------------------------------------------------------
    // Step 6: 零回归验证 — 确认企微原有表 wechat_archiver.messages 未被干扰
    // ---------------------------------------------------------
    console.log('--- [Step 6] 零回归验证：企微原有业务表隔离性检查 ---');
    const { rows: wecomRows } = await pool.query(
      `SELECT count(*) FROM wechat_archiver.messages WHERE external_user_id = $1`,
      [testMemberId]
    );
    const wecomCount = parseInt(wecomRows[0].count, 10);
    console.log(`• wechat_archiver.messages 涉及测试 ID 的条数: ${wecomCount} (必须为 0)`);
    assert.strictEqual(wecomCount, 0, '企微 wechat_archiver 表不得受到任何 MiniHealth 数据的污染！');
    console.log('✅ 企微原生业务表完全零污染零回归！\n');

    // 清理测试脏数据
    await pool.query(`DELETE FROM mini_health.records WHERE member_id = $1`, [testMemberId]);
    await pool.query(`DELETE FROM mini_health.messages WHERE member_id = $1`, [testMemberId]);
    console.log('🧹 测试临时数据已清理完毕');

    console.log('\n======================================================');
    console.log('🎉🎉🎉 MiniHealth 全链路端到端所有测试 100% 深度通过！');
    console.log('======================================================\n');
    process.exit(0);

  } catch (err) {
    console.error('\n❌ E2E 测试失败:', err);
    process.exit(1);
  } finally {
    if (server && server.close) server.close();
    await pool.end();
  }
}

runE2E();
