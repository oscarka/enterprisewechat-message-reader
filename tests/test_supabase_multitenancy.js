/**
 * test_supabase_multitenancy.js
 * 单元测试：验证 supabase_store.js 在多租户 (wechat_archiver vs mini_health) 下的独立读写与历史回查
 */

const assert = require('assert');
const {
    saveMessage,
    getRecentHistory,
    saveRecord,
    pool,
} = require('../supabase_store');

async function testWecomSaveAndHistory() {
    console.log('\n--- [Test 1] 验证企微原有消息写入与历史回查 (兼容性验证) ---');
    const extUserId = `test_wecom_user_${Date.now()}`;
    const msgId1 = `wecom_msg_1_${Date.now()}`;
    const msgId2 = `wecom_msg_2_${Date.now()}`;

    // 1. 写入用户发的消息 (inbound)
    await saveMessage({
        msgid: msgId1,
        seq: 1,
        externalUserId: extUserId,
        externalUserName: '企微客户A',
        employeeUserId: 'emp_01',
        employeeName: '企业顾问小李',
        direction: 'inbound',
        msgtype: 'text',
        content: '请问骨折护理方案？',
        msgTime: new Date(Date.now() - 2000),
    }, 'wechat_archiver');

    // 2. 写入 AI/员工回复的消息 (outbound)
    await saveMessage({
        msgid: msgId2,
        seq: 2,
        externalUserId: extUserId,
        externalUserName: '企微客户A',
        employeeUserId: 'emp_01',
        employeeName: '企业顾问小李',
        direction: 'outbound',
        msgtype: 'text',
        content: '骨折初期切记抬高患肢并避免负重。',
        msgTime: new Date(Date.now() - 1000),
    }, 'wechat_archiver');

    // 3. 读取历史
    const history = await getRecentHistory(extUserId, 20, 'wechat_archiver');
    assert.strictEqual(history.length, 2, '应该成功返回2条历史');
    assert.strictEqual(history[0].role, 'user', '第一条应该是用户消息');
    assert.strictEqual(history[0].content, '请问骨折护理方案？');
    assert.strictEqual(history[1].role, 'assistant', '第二条应该是顾问回复');
    assert.strictEqual(history[1].content, '骨折初期切记抬高患肢并避免负重。');

    // 4. 确认 mini_health 绝对查不到这批企微数据
    const miniHistory = await getRecentHistory(extUserId, 20, 'mini_health');
    assert.strictEqual(miniHistory.length, 0, 'mini_health 绝对不能查到企微的消息');

    // 清理
    await pool.query('DELETE FROM wechat_archiver.messages WHERE external_user_id = $1', [extUserId]);
    console.log('✅ 企微消息写入与历史回查测试通过！');
}

async function testMiniHealthSaveAndHistory() {
    console.log('\n--- [Test 2] 验证 MiniHealth 消息写入与家庭成员会话回查 ---');
    const testUserId = `u_test_${Date.now()}`;
    const memberId = `mem_test_${Date.now()}`;
    const msgId1 = `mini_msg_1_${Date.now()}`;
    const msgId2 = `mini_msg_2_${Date.now()}`;

    // 先插入测试用户和成员以满足外键约束
    await pool.query(
        `INSERT INTO mini_health.users (id, nickname) VALUES ($1, '测试主账号')`,
        [testUserId]
    );
    await pool.query(
        `INSERT INTO mini_health.members (id, user_id, name) VALUES ($1, $2, '家庭成员张三')`,
        [memberId, testUserId]
    );

    // 1. 写入用户文字提问
    await saveMessage({
        msgid: msgId1,
        memberId,
        direction: 'inbound',
        msgtype: 'text',
        content: '我今天骨折第10天可以洗澡吗？',
        msgTime: new Date(Date.now() - 3000),
    }, 'mini_health');

    // 2. 写入 AI 结构化回复并带 meta 卡片
    await saveMessage({
        msgid: msgId2,
        memberId,
        direction: 'outbound',
        msgtype: 'text',
        content: '骨折石膏固定期间严禁直接淋水，防止石膏软化及伤口感染。',
        meta: { suggestions: ['如何进行患肢擦浴？', '拆线前有哪些防水套推荐？'] },
        msgTime: new Date(Date.now() - 1000),
    }, 'mini_health');

    // 3. 读取历史
    const history = await getRecentHistory(memberId, 20, 'mini_health');
    assert.strictEqual(history.length, 2, '应该成功返回2条历史');
    assert.strictEqual(history[0].role, 'user');
    assert.strictEqual(history[0].content, '我今天骨折第10天可以洗澡吗？');
    assert.strictEqual(history[1].role, 'assistant');
    assert.strictEqual(history[1].content, '骨折石膏固定期间严禁直接淋水，防止石膏软化及伤口感染。');
    assert.strictEqual(Array.isArray(history[1].meta.suggestions), true, 'meta 中追问建议应被正确保留');

    // 4. 确认 wechat_archiver 绝对查不到该成员的消息
    const wecomHistory = await getRecentHistory(memberId, 20, 'wechat_archiver');
    assert.strictEqual(wecomHistory.length, 0, 'wechat_archiver 绝对不能查到 mini_health 的消息');

    // 5. 验证打卡记录 saveRecord
    const recId = `rec_${Date.now()}`;
    await saveRecord({
        id: recId,
        memberId,
        recordType: 'meal',
        metrics: { calories: 520, protein: 28 },
        sourceMsgId: msgId1,
    });

    const { rows: recRows } = await pool.query('SELECT * FROM mini_health.records WHERE id = $1', [recId]);
    assert.strictEqual(recRows.length, 1);
    assert.strictEqual(recRows[0].record_type, 'meal');
    assert.strictEqual(recRows[0].metrics.calories, 520);

    // 清理
    await pool.query('DELETE FROM mini_health.records WHERE member_id = $1', [memberId]);
    await pool.query('DELETE FROM mini_health.messages WHERE member_id = $1', [memberId]);
    await pool.query('DELETE FROM mini_health.members WHERE id = $1', [memberId]);
    await pool.query('DELETE FROM mini_health.users WHERE id = $1', [testUserId]);
    console.log('✅ MiniHealth 会话持久化、meta 传递与打卡记录测试通过！');
}

async function main() {
    try {
        await testWecomSaveAndHistory();
        await testMiniHealthSaveAndHistory();
        console.log('\n🎉 Phase 2 多租户 Schema 隔离与历史回查测试 100% 通过！');
        process.exit(0);
    } catch (err) {
        console.error('\n❌ Phase 2 测试失败:', err);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

main();
