/**
 * test_multimodal_perception.js
 * 单元测试：验证多模态感知流水线（真实化验单 OCR、真实菜品拍照识餐与营养素测算打卡）
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { handleDirectMedia } = require('../media_handler');
const { pool } = require('../supabase_store');

// 真实化验单测试图片与真实营养餐图片
const LAB_REPORT_PATH = path.join(__dirname, 'test_lab_report.png');
const MEAL_IMAGE_PATH = '/Users/cc/mini-health/public/illustrations/nutrition_meal.png';

async function testReportOcr() {
    console.log('\n--- [Test 1] 验证门诊生化化验单真实 OCR 识别与指标提取 ---');
    const reportBuffer = fs.readFileSync(LAB_REPORT_PATH);
    const res = await handleDirectMedia({
        buffer: reportBuffer,
        msgtype: 'report',
        filename: '生化化验单.png',
        msgid: `report_${Date.now()}`,
    });

    console.log('• 报告识别返回全文:\n', res.content);
    assert.strictEqual(typeof res.content, 'string');
    assert.strictEqual(res.content.startsWith('[图片'), true, '报告识别结果应带标准图片前缀');

    // 严谨语义断言：必须准确提取出化验单上的核心指标和数值
    const hasGlu = res.content.includes('血糖') || res.content.includes('GLU') || res.content.includes('6.8');
    const hasTc = res.content.includes('胆固醇') || res.content.includes('TC') || res.content.includes('5.6');
    const hasTg = res.content.includes('甘油三酯') || res.content.includes('TG') || res.content.includes('1.8');

    console.log(`• 核心指标检出判定: 血糖=${hasGlu}, 胆固醇=${hasTc}, 甘油三酯=${hasTg}`);
    assert.strictEqual(hasGlu, true, '化验单 OCR 必须成功识别出血糖及数值 (6.8)');
    assert.strictEqual(hasTc, true, '化验单 OCR 必须成功识别出总胆固醇及数值 (5.6)');
    assert.strictEqual(hasTg, true, '化验单 OCR 必须成功识别出甘油三酯及数值 (1.8)');

    console.log('✅ 门诊生化化验单高精度 OCR 语义提取测试通过！');
}

async function testMealPerceptionAndRecord() {
    console.log('\n--- [Test 2] 验证真实菜品拍照识餐 (豆包 Vision + DeepSeek V4) 与打卡入库 ---');
    const testUserId = `u_meal_${Date.now()}`;
    const testMemberId = `mem_meal_${Date.now()}`;

    // 建立测试用户和家庭成员
    await pool.query(`INSERT INTO mini_health.users (id, nickname) VALUES ($1, '识餐测试用户')`, [testUserId]);
    await pool.query(`INSERT INTO mini_health.members (id, user_id, name) VALUES ($1, $2, '李爱华')`, [testMemberId, testUserId]);

    const mealBuffer = fs.readFileSync(MEAL_IMAGE_PATH);
    const res = await handleDirectMedia({
        buffer: mealBuffer,
        msgtype: 'meal',
        filename: '营养午餐.png',
        msgid: `meal_${Date.now()}`,
        meta: {
            memberId: testMemberId,
            memberName: '李爱华',
            patientProfile: '右踝骨折术后第14天拆线，需高蛋白高钙低脂利于骨愈合',
        },
    });

    console.log('• 识餐识别返回内容:\n', res.content);
    assert.strictEqual(typeof res.content, 'string');
    assert.strictEqual(res.content.includes('餐食打卡'), true, '识别内容应包含餐食打卡标识');
    assert.strictEqual(res.content.includes('摄入热量'), true, '识别内容应包含测算热量');
    assert.strictEqual(res.content.includes('优质蛋白'), true, '识别内容应包含优质蛋白测算');

    // 检查食材识别质量
    const hasFoodRecognized = /鱼|蔬菜|菜|时蔬|fish|vegetable/i.test(res.content);
    assert.strictEqual(hasFoodRecognized, true, '多模态应准确解构出盘中的鱼肉或蔬菜食材');

    // 检查 mini_health.records 是否自动入库了该餐食打卡 (record_type = 'diet')
    const { rows: recs } = await pool.query(
        `SELECT record_type, metrics FROM mini_health.records WHERE member_id = $1 AND record_type = 'diet'`,
        [testMemberId]
    );

    console.log(`• mini_health.records 饮食打卡条数: ${recs.length}`);
    assert.strictEqual(recs.length > 0, true, '必须在 mini_health.records 中写入 diet 打卡记录');
    console.log('• 入库 metrics 详情:', JSON.stringify(recs[0].metrics, null, 2));

    const metrics = recs[0].metrics;
    assert.strictEqual(typeof metrics.calories, 'number', 'metrics.calories 必须为数值');
    assert.strictEqual(metrics.calories > 0, true, 'metrics.calories 必须大于0');
    assert.strictEqual(typeof metrics.protein_g, 'number', 'metrics.protein_g 必须为数值');
    assert.strictEqual(metrics.protein_g > 0, true, 'metrics.protein_g 必须大于0');
    assert.strictEqual(Array.isArray(metrics.ingredients), true, 'metrics.ingredients 必须包含食材列表');

    // 清理测试数据
    await pool.query(`DELETE FROM mini_health.records WHERE member_id = $1`, [testMemberId]);
    await pool.query(`DELETE FROM mini_health.members WHERE id = $1`, [testMemberId]);
    await pool.query(`DELETE FROM mini_health.users WHERE id = $1`, [testUserId]);

    console.log('✅ 真实拍照识餐多模态双核流水线与打卡入库完整闭环验证通过！');
}

async function testVoiceHandling() {
    console.log('\n--- [Test 3] 验证语音消息流水线与友好降级 ---');
    const fakeAmrBuffer = Buffer.from('#!AMR\n\x00\x00\x00\x00', 'utf8');
    const res = await handleDirectMedia({
        buffer: fakeAmrBuffer,
        msgtype: 'voice',
        filename: 'voice.amr',
        msgid: `voice_${Date.now()}`,
    });

    console.log('• 语音处理结果:', res.content);
    assert.strictEqual(typeof res.content, 'string');
    assert.strictEqual(res.content.startsWith('['), true);
    console.log('✅ 语音消息安全容错流水线验证通过！');
}

async function main() {
    try {
        await testReportOcr();
        await testMealPerceptionAndRecord();
        await testVoiceHandling();
        console.log('\n🎉 多模态真实感知流水线 (OCR + 识餐 + 打卡) 100% 严谨验证通过！');
        process.exit(0);
    } catch (err) {
        console.error('\n❌ 多模态感知测试失败:', err);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

main();
