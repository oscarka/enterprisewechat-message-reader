/**
 * test_minihealth_http_gateway.js
 * 单元测试：验证 wechat-archiver HTTP 网关为 MiniHealth 提供的同步问答端点与历史查询
 */

const assert = require('assert');
const axios = require('axios');
const { createHttpServer } = require('../http_gateway');
const { pool } = require('../supabase_store');

const TEST_PORT = 9876;
const BASE_URL = `http://localhost:${TEST_PORT}`;

async function main() {
    console.log('\n--- 启动测试 HTTP 网关 ---');
    const server = createHttpServer(TEST_PORT);

    try {
        // 1. 验证 Cloud Run 健康检查探针兼容性
        console.log('\n--- [Test 1] 校验健康检查探针 (GET / 与 GET /health) ---');
        const probeResp = await axios.get(`${BASE_URL}/health`);
        assert.strictEqual(probeResp.status, 200);
        assert.strictEqual(probeResp.data, 'OK');
        console.log('✅ 健康检查探针 100% 兼容正常！');

        // 2. 准备测试用户与家庭成员
        const testUserId = `u_gw_${Date.now()}`;
        const testMemberId = `mem_gw_${Date.now()}`;
        await pool.query(
            `INSERT INTO mini_health.users (id, nickname) VALUES ($1, '网关测试用户')`,
            [testUserId]
        );
        await pool.query(
            `INSERT INTO mini_health.members (id, user_id, name) VALUES ($1, $2, '张小明')`,
            [testMemberId, testUserId]
        );

        // 3. 测试 MiniHealth 同步文字提问 (POST /api/minihealth/chat)
        console.log('\n--- [Test 2] MiniHealth 同步文字提问 ---');
        const t0 = Date.now();
        const chatResp = await axios.post(`${BASE_URL}/api/minihealth/chat`, {
            memberId: testMemberId,
            memberName: '张小明',
            content: '脚踝骨折术后第14天，伤口轻微发红需要看医生吗？',
            msgtype: 'text',
        }, { timeout: 35000 });

        const elapsedMs = Date.now() - t0;
        console.log(`收到 AI 同步答复 (耗时: ${elapsedMs}ms):`);
        console.log('• Reply Preview:', chatResp.data.reply.slice(0, 100));
        console.log('• Suggestions:', chatResp.data.suggestions);

        assert.strictEqual(chatResp.status, 200);
        assert.strictEqual(typeof chatResp.data.reply === 'string' && chatResp.data.reply.length > 0, true, '必须返回非空回复');
        assert.strictEqual(Array.isArray(chatResp.data.suggestions), true, '必须返回建议追问数组');
        assert.strictEqual(chatResp.data.source, 'wechat-archiver-gateway');
        console.log('✅ 同步问答握手测试通过！');

        // 4. 验证会话已双向入库至 mini_health.messages
        console.log('\n--- [Test 3] 验证 Supabase mini_health.messages 双向写入 ---');
        const { rows: msgs } = await pool.query(
            `SELECT direction, content, meta FROM mini_health.messages WHERE member_id = $1 ORDER BY msg_time ASC`,
            [testMemberId]
        );
        assert.strictEqual(msgs.length, 2, '应该包含1条用户提问与1条AI答复');
        assert.strictEqual(msgs[0].direction, 'inbound');
        assert.strictEqual(msgs[0].content.includes('脚踝骨折术后第14天'), true);
        assert.strictEqual(msgs[1].direction, 'outbound');
        assert.strictEqual(msgs[1].content.length > 0, true);
        console.log('✅ 数据库双向持久化验证通过！');

        // 5. 验证历史记录拉取端点 (GET /api/minihealth/history/:memberId)
        console.log('\n--- [Test 4] 验证客户端历史加载接口 ---');
        const histResp = await axios.get(`${BASE_URL}/api/minihealth/history/${testMemberId}`);
        assert.strictEqual(histResp.status, 200);
        assert.strictEqual(histResp.data.count, 2);
        assert.strictEqual(histResp.data.history[0].role, 'user');
        assert.strictEqual(histResp.data.history[1].role, 'assistant');
        console.log('✅ 客户端历史记录加载接口测试通过！');

        // 清理测试数据
        await pool.query('DELETE FROM mini_health.messages WHERE member_id = $1', [testMemberId]);
        await pool.query('DELETE FROM mini_health.members WHERE id = $1', [testMemberId]);
        await pool.query('DELETE FROM mini_health.users WHERE id = $1', [testUserId]);

        console.log('\n🎉 Phase 3 HTTP 网关与同步问答测试 100% 通过！');
        process.exit(0);

    } catch (err) {
        console.error('\n❌ Phase 3 测试失败:', err.response?.data || err.message);
        process.exit(1);
    } finally {
        server.close();
        await pool.end();
    }
}

main();
