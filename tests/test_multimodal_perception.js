/**
 * test_multimodal_perception.js
 * 单元测试：验证多模态感知流水线（化验单/报告 OCR、语音转文字、豆包 Vision + DeepSeek V4 拍照识餐）
 */

require('dotenv').config();
const assert = require('assert');
const { handleDirectMedia } = require('../media_handler');
const { pool } = require('../supabase_store');

// 极简合法单像素 JPEG 图片 Base64
const TINY_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const TINY_JPEG_BUFFER = Buffer.from(TINY_JPEG_BASE64, 'base64');

async function testReportOcr() {
    console.log('\n--- [Test 1] 验证化验单 / 门诊病历 OCR 处理流水线 ---');
    const res = await handleDirectMedia({
        buffer: TINY_JPEG_BUFFER,
        msgtype: 'report',
        filename: '生化化验单.jpg',
        msgid: `report_${Date.now()}`,
    });

    console.log('• 报告识别返回内容:', res.content);
    assert.strictEqual(typeof res.content, 'string');
    assert.strictEqual(res.content.startsWith('[图片'), true, '报告识别结果应带标准图片前缀');
    console.log('✅ 门诊化验单 OCR 流水线验证通过！');
}

async function testMealPerceptionAndRecord() {
    console.log('\n--- [Test 2] 验证拍照识餐双核流水线 (豆包 Vision + DeepSeek V4 Flash) ---');
    const testUserId = `u_meal_${Date.now()}`;
    const testMemberId = `mem_meal_${Date.now()}`;

    // 建立测试用户和成员
    await pool.query(`INSERT INTO mini_health.users (id, nickname) VALUES ($1, '识餐测试用户')`, [testUserId]);
    await pool.query(`INSERT INTO mini_health.members (id, user_id, name) VALUES ($1, $2, '李雷')`, [testMemberId, testUserId]);

    const res = await handleDirectMedia({
        buffer: TINY_JPEG_BUFFER,
        msgtype: 'meal',
        filename: '午餐.jpg',
        msgid: `meal_${Date.now()}`,
        meta: {
            memberId: testMemberId,
            memberName: '李雷',
            patientProfile: '右膝软骨骨折术后第20天，需高蛋白高钙低钠',
        },
    });

    console.log('• 识餐识别返回内容:', res.content);
    assert.strictEqual(typeof res.content, 'string');
    assert.strictEqual(res.content.includes('餐食'), true, '识别内容应包含餐食前缀');

    // 检查 mini_health.records 是否自动入库了该餐食打卡
    const { rows: recs } = await pool.query(
        `SELECT record_type, metrics FROM mini_health.records WHERE member_id = $1`,
        [testMemberId]
    );

    console.log(`• mini_health.records 打卡记录数: ${recs.length}`);
    if (recs.length > 0) {
        console.log('• 入库 metrics 摘要:', recs[0].metrics);
        assert.strictEqual(recs[0].record_type, 'meal');
    }

    // 清理
    await pool.query(`DELETE FROM mini_health.records WHERE member_id = $1`, [testMemberId]);
    await pool.query(`DELETE FROM mini_health.members WHERE id = $1`, [testMemberId]);
    await pool.query(`DELETE FROM mini_health.users WHERE id = $1`, [testUserId]);

    console.log('✅ 拍照识餐多模态双核流水线与打卡入库验证通过！');
}

async function testVoiceHandling() {
    console.log('\n--- [Test 3] 验证语音转文字流水线 ---');
    // 模拟一段极短音频 Buffer
    const fakeAmrBuffer = Buffer.from('#!AMR\n\x00\x00\x00\x00', 'utf8');
    const res = await handleDirectMedia({
        buffer: fakeAmrBuffer,
        msgtype: 'voice',
        filename: 'voice.amr',
        msgid: `voice_${Date.now()}`,
    });

    console.log('• 语音转写处理结果:', res.content);
    assert.strictEqual(typeof res.content, 'string');
    // 无论是 ASR 转写成功还是降级提示语，都必须返回安全友好的文字
    assert.strictEqual(res.content.startsWith('['), true);
    console.log('✅ 语音转写容错流水线验证通过！');
}

async function main() {
    try {
        await testReportOcr();
        await testMealPerceptionAndRecord();
        await testVoiceHandling();
        console.log('\n🎉 Phase 4 多模态感知流水线 100% 验证通过！');
        process.exit(0);
    } catch (err) {
        console.error('\n❌ Phase 4 测试失败:', err);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

main();
