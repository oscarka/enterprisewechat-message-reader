/**
 * media_task_manager.js
 *
 * 用户媒体任务管理器：
 * 1. 负责管理每个用户并发下载、上传 GCS、OCR/PDF 解析的生命周期。
 * 2. 状态机：'processing' -> 'completed' (带提取文本) | 'failed' (带错误标记)
 * 3. 任意任务状态改变时，通过事件通知监听者（InboundQueue）。
 */

const EventEmitter = require('events');
const taskEmitter  = new EventEmitter();

// Map<userId, Map<taskId, MediaTask>>
const _userTasks = new Map();

function _log(type, extra = {}) {
    console.log(JSON.stringify({ severity: 'INFO', type, ...extra, ts: new Date().toISOString() }));
}

/**
 * 注册并启动一个媒体异步处理任务
 *
 * @param {string} userId
 * @param {string} taskId
 * @param {string} msgtype - 'image' | 'file' | 'voice' | 'video'
 * @param {string} fileName
 * @param {function(): Promise<{ content: string, mediaUrl: string }>} processorFn - 实际下载/OCR 执行函数
 */
function createAndRunMediaTask(userId, taskId, msgtype, fileName, processorFn) {
    if (!_userTasks.has(userId)) {
        _userTasks.set(userId, new Map());
    }

    const userMap = _userTasks.get(userId);
    const task = {
        id:            taskId,
        userId,
        msgtype,
        fileName:      fileName || (msgtype === 'image' ? '图片.jpg' : '附件'),
        fileUrl:       null,
        status:        'processing',
        extractedText: '',
        error:         null,
        createdAt:     Date.now(),
    };

    userMap.set(taskId, task);

    _log('media_task_started', {
        userId,
        taskId,
        msgtype,
        fileName: task.fileName,
    });

    // 异步执行，不阻塞主循环
    (async () => {
        try {
            const result = await processorFn();
            task.fileUrl       = result?.mediaUrl || null;
            task.extractedText = (result?.content || '').trim();
            task.status        = 'completed';

            _log('media_task_completed', {
                userId,
                taskId,
                msgtype,
                hasUrl:     !!task.fileUrl,
                contentLen: task.extractedText.length,
                preview:    task.extractedText.slice(0, 80),
            });
        } catch (err) {
            task.status = 'failed';
            task.error  = err.message || '解析失败';
            // 标记打不开/解析失败，方便让 Agent 告知客户
            task.extractedText = `【附件: ${task.fileName} (无法正常打开或解析: ${task.error})】`;

            _log('media_task_failed', {
                userId,
                taskId,
                error: err.message,
            });
        } finally {
            // 状态变更，通知队列检查是否可以出队
            taskEmitter.emit(`task_done:${userId}`, task);
            taskEmitter.emit('any_task_done', { userId, task });
        }
    })();

    return task;
}

/**
 * 获取指定用户当前所有媒体任务
 */
function getUserMediaTasks(userId) {
    const userMap = _userTasks.get(userId);
    if (!userMap) return [];
    return Array.from(userMap.values());
}

/**
 * 检查指定用户是否还有正在处理中的媒体任务
 */
function hasProcessingTasks(userId) {
    const tasks = getUserMediaTasks(userId);
    return tasks.some(t => t.status === 'processing');
}

/**
 * 清空指定用户已完成/已消费的媒体任务
 */
function clearUserMediaTasks(userId) {
    _userTasks.delete(userId);
}

module.exports = {
    createAndRunMediaTask,
    getUserMediaTasks,
    hasProcessingTasks,
    clearUserMediaTasks,
    taskEmitter,
};
