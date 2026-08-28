/**
 * inbound_queue.js
 *
 * 统一用户入队与即时出队管理器：
 * 1. 收集用户的文字消息、语音转写文本；
 * 2. 监听 MediaTaskManager 的任务状态；
 * 3. 触发规则：
 *    - 当且仅当当前用户的所有文件全部解析完毕（无 'processing' 状态的任务）时，立即打包出队；
 *    - 若没有文件解析任务，文字/语音收到后即刻出队；
 *    - 纯媒体无文字时：全部解析完成后仍出队（让 Ingest 存入 user_recent_files 备用）。
 */

const {
    getUserMediaTasks,
    hasProcessingTasks,
    clearUserMediaTasks,
    taskEmitter,
} = require('./media_task_manager');

function _log(type, extra = {}) {
    console.log(JSON.stringify({ severity: 'INFO', type, ...extra, ts: new Date().toISOString() }));
}

// Map<userId, { texts: Array<{ content: string, msgId: string, timestamp: number }>, meta: object, callback: Function, safetyTimer: NodeJS.Timeout }>
const _userQueues = new Map();

// 极端异常兜底超时（防止某个 OCR 任务网络底层死锁导致用户通道永久阻塞）
const MAX_MEDIA_WAIT_MS = parseInt(process.env.MAX_MEDIA_WAIT_MS || '60000', 10);

/**
 * 尝试检查并出队（Flush）
 */
function tryFlush(userId) {
    const queue = _userQueues.get(userId);
    if (!queue) return;

    // 如果该用户还有文件正在解析中，继续等待，不出队
    if (hasProcessingTasks(userId)) {
        const tasks = getUserMediaTasks(userId);
        const processingCount = tasks.filter(t => t.status === 'processing').length;
        _log('inbound_queue_waiting_media', {
            userId,
            textCount: queue.texts.length,
            totalMediaCount: tasks.length,
            processingCount,
            reason: '尚有文件在后台解析，保持等待，待全部完成后即刻出队',
        });
        return;
    }

    // ── 到达这里说明：所有媒体文件已经全部处理完毕（完成或失败），或者无在途媒体 ──

    if (queue.safetyTimer) {
        clearTimeout(queue.safetyTimer);
        queue.safetyTimer = null;
    }

    const tasks = getUserMediaTasks(userId);
    const texts = queue.texts;
    const meta  = queue.meta;
    const cb    = queue.callback;

    // 清理该用户的队列和媒体任务
    _userQueues.delete(userId);
    clearUserMediaTasks(userId);

    // 构造合并内容
    const textPart = texts.map(t => t.content).filter(Boolean).join('\n');
    
    // 构造所有附件的解析文本（包含成功提取的报告/OCR内容，以及失败的说明）
    const mediaParts = [];
    for (const t of tasks) {
        if (t.extractedText) {
            mediaParts.push(t.extractedText);
        }
    }
    const mediaPart = mediaParts.join('\n\n');

    let combinedContent = '';
    if (textPart && mediaPart) {
        combinedContent = `${textPart}\n\n${mediaPart}`;
    } else if (textPart) {
        combinedContent = textPart;
    } else if (mediaPart) {
        combinedContent = mediaPart;
    }

    if (!combinedContent) {
        _log('inbound_queue_empty_skip', { userId });
        return;
    }

    // 判断是否为纯静默媒体（仅有非语音文件/图片，没有文字且没有语音转写）
    // 语音转写后即代表用户说话，isMediaOnly 应为 false，正常触发 Agent
    const hasOnlyNonVoiceMedia = texts.length === 0 && tasks.length > 0 && tasks.every(t => t.msgtype !== 'voice');
    const isMediaOnly = hasOnlyNonVoiceMedia;

    _log('inbound_queue_flush', {
        userId,
        textCount:  texts.length,
        mediaCount: tasks.length,
        isMediaOnly,
        contentLen: combinedContent.length,
        preview:    combinedContent.slice(0, 100),
    });

    // 异步执行回调，将整合好的数据发往下级处理（如 forwardToSkillPlatform）
    Promise.resolve().then(() => {
        return cb({
            content:      combinedContent,
            userId,
            meta,
            isMediaOnly,
            tasks,
            texts,
        });
    }).catch(err => {
        _log('inbound_queue_cb_error', { userId, error: err.message });
    });
}

/**
 * 将文字/语音消息加入队列
 *
 * @param {string} userId
 * @param {{ content: string, msgId: string, timestamp?: number }} item
 * @param {object} meta - 用户与客服相关元数据
 * @param {function(payload): Promise<void>} callback - 出队时的分发回调
 */
function enqueueText(userId, item, meta, callback) {
    if (!_userQueues.has(userId)) {
        _userQueues.set(userId, {
            texts:       [],
            meta,
            callback,
            safetyTimer: null,
        });
    }

    const q = _userQueues.get(userId);
    q.texts.push({
        content:   item.content,
        msgId:     item.msgId,
        timestamp: item.timestamp || Date.now(),
    });
    q.meta     = meta;
    q.callback = callback;

    // 兜底安全定时器（若有任务异常挂死）
    if (!q.safetyTimer) {
        q.safetyTimer = setTimeout(() => {
            _log('inbound_queue_safety_timeout', {
                userId,
                reason: `等待超过 ${MAX_MEDIA_WAIT_MS}ms 安全上限，强制出队已完成的部分`,
            });
            tryFlush(userId);
        }, MAX_MEDIA_WAIT_MS);
    }
}

/**
 * 注册媒体任务进队列（供纯媒体消息初始化队列元数据）
 */
function touchMediaQueue(userId, meta, callback) {
    if (!_userQueues.has(userId)) {
        _userQueues.set(userId, {
            texts:       [],
            meta,
            callback,
            safetyTimer: null,
        });
    } else {
        const q = _userQueues.get(userId);
        q.meta     = meta;
        q.callback = callback;
    }

    const q = _userQueues.get(userId);
    if (!q.safetyTimer) {
        q.safetyTimer = setTimeout(() => {
            _log('inbound_queue_safety_timeout', {
                userId,
                reason: `等待超过 ${MAX_MEDIA_WAIT_MS}ms 安全上限，强制出队`,
            });
            tryFlush(userId);
        }, MAX_MEDIA_WAIT_MS);
    }
}

// 监听媒体任务状态完成事件：只要该用户的某个媒体任务完成/失败，立即尝试检查出队
taskEmitter.on('any_task_done', ({ userId }) => {
    tryFlush(userId, true);
});

module.exports = {
    enqueueText,
    touchMediaQueue,
    tryFlush,
};
