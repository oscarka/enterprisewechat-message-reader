/**
 * test_queue_and_media.js
 * 验证媒体任务并发、多图汇聚、先文后图、坏图容错等场景
 */

const assert = require('assert');
const { createAndRunMediaTask } = require('../media_task_manager');
const { enqueueText, touchMediaQueue, tryFlush } = require('../inbound_queue');

async function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function testScenario1_PureText() {
    console.log('\n--- 场景 1: 纯文字即时出队 ---');
    let flushed = null;
    enqueueText('user_pure_text', { content: '你好，在吗？', msgId: 'm1' }, { user: 'user1' }, (payload) => {
        flushed = payload;
    });
    tryFlush('user_pure_text');

    await delay(50);
    assert.strictEqual(flushed !== null, true, '纯文字应该立刻出队');
    assert.strictEqual(flushed.content, '你好，在吗？');
    assert.strictEqual(flushed.isMediaOnly, false);
    console.log('✅ 场景 1 测试通过！');
}

async function testScenario2_TextAndMultiImagesConcurrent() {
    console.log('\n--- 场景 2: 文字 + 多图并发解析，解析全部完成后出队 ---');
    let flushed = null;
    const userId = 'user_multi_img';

    // 1. 发起第 1 张图（耗时 100ms）
    createAndRunMediaTask(userId, 'img_1', 'image', '血常规.jpg', async () => {
        await delay(100);
        return { content: '[图片内容:\n血常规白细胞: 6.5]', mediaUrl: 'http://gcs/img1.jpg' };
    });

    // 2. 发起第 2 张图（耗时 200ms）
    createAndRunMediaTask(userId, 'img_2', 'image', '生化.jpg', async () => {
        await delay(200);
        return { content: '[图片内容:\n空腹血糖: 5.2]', mediaUrl: 'http://gcs/img2.jpg' };
    });

    // 3. 用户同时发了文字
    enqueueText(userId, { content: '帮我分析一下这两张报告', msgId: 'm_text' }, { user: 'user2' }, (payload) => {
        flushed = payload;
    });
    tryFlush(userId);

    // 在 50ms 时检查：还在解析中，不应该出队
    await delay(50);
    assert.strictEqual(flushed, null, '50ms 时图片还在解析，不应出队');

    // 在 150ms 时检查：第 1 张已完成，第 2 张还在解析，不应该出队
    await delay(100);
    assert.strictEqual(flushed, null, '150ms 时第2张图未完成，不应出队');

    // 在 250ms 时检查：所有图片解析完毕，应该已经合并出队
    await delay(100);
    assert.strictEqual(flushed !== null, true, '250ms 时所有图片已完成，应立刻出队');
    assert.strictEqual(flushed.content.includes('帮我分析一下这两张报告'), true);
    assert.strictEqual(flushed.content.includes('血常规白细胞: 6.5'), true);
    assert.strictEqual(flushed.content.includes('空腹血糖: 5.2'), true);
    assert.strictEqual(flushed.tasks.length, 2);
    console.log('✅ 场景 2 测试通过！');
}

async function testScenario3_CorruptedImageTolerance() {
    console.log('\n--- 场景 3: 图片损坏/解析失败容错，不阻断流程 ---');
    let flushed = null;
    const userId = 'user_corrupt_img';

    // 1 张正常图 (50ms)，1 张损坏图 (50ms)
    createAndRunMediaTask(userId, 'img_ok', 'image', '正常单.jpg', async () => {
        await delay(50);
        return { content: '[图片内容:\n心率: 75bpm]', mediaUrl: 'http://gcs/ok.jpg' };
    });

    createAndRunMediaTask(userId, 'img_broken', 'image', '损坏单.jpg', async () => {
        await delay(50);
        throw new Error('格式损坏，无法解码');
    });

    enqueueText(userId, { content: '看下这两个', msgId: 'm_corrupt' }, { user: 'user3' }, (payload) => {
        flushed = payload;
    });
    tryFlush(userId);

    await delay(100);
    assert.strictEqual(flushed !== null, true, '损坏图也应正常完成状态流转并出队');
    assert.strictEqual(flushed.content.includes('看下这两个'), true);
    assert.strictEqual(flushed.content.includes('心率: 75bpm'), true);
    assert.strictEqual(flushed.content.includes('无法正常打开或解析'), true);
    console.log('✅ 场景 3 测试通过！');
}

async function testScenario4_VoiceMessage() {
    console.log('\n--- 场景 4: 语音消息转写后正常触发 Agent (isMediaOnly = false) ---');
    let flushed = null;
    const userId = 'user_voice';

    createAndRunMediaTask(userId, 'voice_1', 'voice', 'voice.amr', async () => {
        await delay(50);
        return { content: '[语音转文字]: 你们明天几点上班？', mediaUrl: 'http://gcs/voice.amr' };
    });

    touchMediaQueue(userId, { user: 'user4' }, (payload) => {
        flushed = payload;
    });

    await delay(100);
    assert.strictEqual(flushed !== null, true, '语音转写完成后应立即出队');
    assert.strictEqual(flushed.isMediaOnly, false, '语音消息转写后不是纯静默文件，应触发 Agent');
    assert.strictEqual(flushed.content.includes('你们明天几点上班？'), true);
    console.log('✅ 场景 4 测试通过！');
}

async function main() {
    try {
        await testScenario1_PureText();
        await testScenario2_TextAndMultiImagesConcurrent();
        await testScenario3_CorruptedImageTolerance();
        await testScenario4_VoiceMessage();
        console.log('\n🎉 所有单元测试全部通过！');
    } catch (err) {
        console.error('\n❌ 测试失败:', err);
        process.exit(1);
    }
}

main();
