/**
 * message_debouncer.js
 *
 * 对同一外部用户连发消息进行防抖聚合，避免用户分句发话时触发多次 CUA 调用。
 *
 * 策略：
 *  - 软定时器（默认 2s）：每收到消息重置；到期后用 Gemini Flash Lite 判断完整性
 *  - 单条短消息（≤ 20 字）直接视为完整，跳过 AI 判断（"你好" 2s 后立即发）
 *  - 硬定时器（默认 5s）：无论如何强制发送，防止用户一直不停打字
 *  - AI 判断宽松：问候语、陈述句、问句都算完整；只有明显未完成才等待
 */

const { GoogleGenAI } = require('@google/genai');

const SOFT_MS  = parseInt(process.env.DEBOUNCE_MS      || '2000',  10);
const HARD_MS  = parseInt(process.env.DEBOUNCE_HARD_MS || '5000', 10);

// Map<userId, { items, softTimer, hardTimer, meta }>
const _buffers = new Map();

function _log(type, extra = {}) {
    console.log(JSON.stringify({ severity: 'INFO', type, ...extra, ts: new Date().toISOString() }));
}

/**
 * 调用 Gemini Flash Lite 判断消息是否完整（宽松）
 * 单条 ≤20 字的消息直接返回 true，不消耗 API 配额
 */
async function _isComplete(contents) {
    // 单条短消息（问候 / 简短表达）直接认为完整
    if (contents.length === 1 && contents[0].length <= 50) {
        _log('debounce_short_msg_skip_ai', {
            reason: '单条短消息（≤50字），跳过 AI 判断，直接视为完整',
            msgLen: contents[0].length,
            preview: contents[0].substring(0, 30),
        });
        return true;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        _log('debounce_ai_skip_no_key', { reason: '未配置 GEMINI_API_KEY，直接视为完整' });
        return true;
    }

    try {
        const ai = new GoogleGenAI({ apiKey });
        const prompt =
`你是一个客服消息完整性判断器。用户在企业微信中连续发来以下消息（按先后顺序）：

${contents.map((c, i) => `${i + 1}. ${c}`).join('\n')}

请判断：用户当前的表达是否已经完整（即无需再等待更多消息就可以回复）？

判断标准（宽松）：
• 任何问候语（你好、在吗、嗨、hello、hi 等）= 完整
• 有完整的疑问或陈述 = 完整
• 多条消息合在一起意思完整 = 完整
• 只有明显的半句话（消息末尾是省略号、或句子明显中断）= 不完整

只回答 yes（完整）或 no（可能还有后续）。`;

        const resp = await ai.models.generateContent({
            model:    'gemini-2.5-flash-lite',
            contents: prompt,
        });
        const text = (resp.text || '').trim().toLowerCase();
        const complete = !text.startsWith('no');
        _log('debounce_ai_judgment', {
            msgCount:  contents.length,
            aiResult:  text.slice(0, 10),
            complete,
            previews:  contents.map(c => c.substring(0, 20)).join(' | '),
        });
        return complete;
    } catch (e) {
        _log('debounce_ai_error', { message: e.message, fallback: '判断失败，默认视为完整' });
        return true; // 失败默认发送
    }
}

/**
 * 立即将缓冲区内容发出并清理
 */
function _flush(userId, callback) {
    const buf = _buffers.get(userId);
    if (!buf || buf.items.length === 0) return;

    clearTimeout(buf.softTimer);
    clearTimeout(buf.hardTimer);
    _buffers.delete(userId);

    _log('debounce_flush', {
        userId,
        itemCount: buf.items.length,
        preview:   buf.items.map(i => (i.content || '').substring(0, 30)).join(' | '),
    });

    // 异步调用，不阻塞
    Promise.resolve().then(() => callback(buf.items, buf.meta)).catch(e =>
        _log('debounce_callback_error', { message: e.message })
    );
}

/**
 * 将一条消息加入防抖缓冲
 *
 * @param {string} userId   - external_user_id（每个客户唯一）
 * @param {{ content: string, mediaUrl?: string }} item
 * @param {{ externalUserId, externalUserName, employeeUserId, employeeName }} meta
 * @param {function(items, meta): Promise<void>} callback - flush 时回调
 */
function enqueue(userId, item, meta, callback) {
    if (!_buffers.has(userId)) {
        _buffers.set(userId, {
            items:      [],
            softTimer:  null,
            hardTimer:  null,
            meta,
        });
    }

    const buf = _buffers.get(userId);
    buf.items.push(item);
    buf.meta = meta; // 以最新一条消息的 meta 为准

    // 重置软定时器
    clearTimeout(buf.softTimer);
    buf.softTimer = setTimeout(async () => {
        const contents = buf.items.map(i => i.content).filter(Boolean);
        _log('debounce_soft_trigger', {
            userId,
            itemCount: buf.items.length,
            softMs:    SOFT_MS,
            previews:  contents.map(c => c.substring(0, 20)).join(' | '),
        });
        const complete = await _isComplete(contents);
        if (complete) {
            _log('debounce_soft_flush', { userId, reason: '软定时器触发 + 判断完整，立即 flush' });
            _flush(userId, callback);
        } else {
            _log('debounce_waiting', { userId, reason: 'AI判断未完整，等待硬定时器兜底', hardMs: HARD_MS });
            // 软定时器触发但未完整，等硬定时器兜底
        }
    }, SOFT_MS);

    // 硬定时器只在第一条消息时设置
    if (!buf.hardTimer) {
        _log('debounce_hard_armed', { userId, hardMs: HARD_MS });
        buf.hardTimer = setTimeout(() => {
            _log('debounce_hard_trigger', {
                userId,
                itemCount: _buffers.get(userId)?.items.length || 0,
                reason:    '硬定时器到期，强制 flush（防止用户连续输入导致永不触发）',
            });
            _flush(userId, callback);
        }, HARD_MS);
    }
}

module.exports = { enqueue };
