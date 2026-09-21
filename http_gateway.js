/**
 * http_gateway.js
 * wechat-archiver 统一 HTTP 网关
 *
 * 核心功能：
 * 1. 保持原有 Cloud Run 存活健康检查 (GET / 和 GET /health)；
 * 2. 开放 MiniHealth 同步问答端点 (POST /api/minihealth/chat)；
 * 3. 开放 MiniHealth 历史查询端点 (GET /api/minihealth/history/:memberId)；
 * 4. 接入现有的 InboundQueue 与 MediaTaskManager 事件驱动队列；
 * 5. 调用 Skill Platform 完成认知推理并双向沉淀至 Supabase mini_health.messages。
 */

const http = require('http');
const axios = require('axios');
const { createAndRunMediaTask } = require('./media_task_manager');
const { enqueueText, touchMediaQueue, tryFlush } = require('./inbound_queue');
const { handleDirectMedia } = require('./media_handler');
const { saveMessage, getRecentHistory } = require('./supabase_store');

const SKILL_PLATFORM_URL = process.env.SKILL_PLATFORM_URL || 'https://skill-platform-yo5337ccva-de.a.run.app';

function _log(type, extra = {}) {
    console.log(JSON.stringify({ severity: 'INFO', type, ...extra, ts: new Date().toISOString() }));
}

function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
}

function sendJson(res, statusCode, data) {
    setCorsHeaders(res);
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}

/**
 * 处理 MiniHealth 问答会话
 */
async function handleMiniHealthChat(req, res, body) {
    const {
        memberId,
        memberName,
        content = '',
        media = null,       // Base64 或 data:URL
        mediaType = 'text', // 'text' | 'voice' | 'image' | 'meal' | 'report' | 'file'
        fileName = '',
        patientProfile = '',
    } = body;

    if (!memberId) {
        return sendJson(res, 400, { error: 'memberId is required' });
    }
    if (!content && !media) {
        return sendJson(res, 400, { error: 'Either content or media is required' });
    }

    const userId = memberId;
    const cleanName = memberName || memberId;
    const incomingMsgId = `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    _log('minihealth_chat_inbound', {
        memberId,
        memberName: cleanName,
        hasContent: !!content,
        hasMedia: !!media,
        mediaType,
    });

    // 创建 Promise 等待 InboundQueue flush 回调
    return new Promise((resolve) => {
        let isHandled = false;

        const onFlush = async ({ content: combinedContent, tasks, texts }) => {
            if (isHandled) return;
            isHandled = true;

            try {
                // 1. 写入用户消息进 mini_health.messages
                const firstTask = (tasks || [])[0];
                await saveMessage({
                    msgid: incomingMsgId,
                    memberId,
                    direction: 'inbound',
                    msgtype: mediaType || 'text',
                    content: combinedContent,
                    mediaUrl: firstTask?.fileUrl || null,
                    msgTime: new Date(),
                }, 'mini_health');

                // 2. 从 mini_health.messages 取出最近 20 条历史作为大模型上下文
                const history = await getRecentHistory(memberId, 20, 'mini_health');

                // 3. 调用 Skill Platform /api/v1/agent/chat
                const chatPayload = {
                    content: combinedContent,
                    source: 'mini_health',
                    source_channel: 'mini_health',
                    session_id: memberId,
                    meta: {
                        user_id: memberId,
                        from_name: cleanName,
                    },
                    context: {
                        available_apps: ['MiniHealth'],
                        current_recipient: cleanName,
                    },
                    history: history.slice(0, -1).map(h => ({ // 排除刚插入的本条，防止 prompt 里的当前问题与历史末尾重复
                        role: h.role,
                        content: h.content,
                    })),
                };

                const spUrl = `${SKILL_PLATFORM_URL.replace(/\/+$/, '')}/api/v1/agent/chat`;
                _log('calling_skill_platform', { url: spUrl, memberId, historyLen: chatPayload.history.length });

                const spResp = await axios.post(spUrl, chatPayload, {
                    timeout: 35000,
                    headers: { 'Content-Type': 'application/json' },
                });

                const data = spResp.data || {};
                let reply = (data.reply || '').trim();
                let suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
                const careServiceCard = data.careServiceCard || null;
                const requestId = data.requestId || `req_${Date.now()}`;

                // 若正文中包含 [推荐追问] 或 [追问建议]，做剥离保证卡片气泡纯净
                const match = reply.match(/\[(?:推荐追问|追问建议|快捷追问)\][：:]\s*(.+)$/m);
                if (match) {
                    const parsedSugs = match[1]
                        .split(/[|｜、\n]+/)
                        .map(s => s.trim().replace(/^[\d.-]+\s*/, ''))
                        .filter(Boolean);
                    if (parsedSugs.length > 0) {
                        suggestions = parsedSugs;
                        reply = reply.replace(/\[(?:推荐追问|追问建议|快捷追问)\][：:]\s*(.+)$/m, '').trim();
                    }
                }

                // 4. 将 AI 结构化回复存入 mini_health.messages
                const aiMsgId = `ai_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                await saveMessage({
                    msgid: aiMsgId,
                    memberId,
                    direction: 'outbound',
                    msgtype: 'text',
                    content: reply,
                    meta: { suggestions, careServiceCard, requestId },
                    msgTime: new Date(),
                }, 'mini_health');

                _log('minihealth_chat_success', { memberId, replyLen: reply.length, sugsCount: suggestions.length });

                sendJson(res, 200, {
                    success: true,
                    reply,
                    suggestions,
                    careServiceCard,
                    requestId,
                    source: 'wechat-archiver-gateway',
                });
                resolve();

            } catch (err) {
                _log('minihealth_chat_error', { memberId, error: err.message });
                sendJson(res, 500, {
                    error: 'agent_error',
                    message: err.response?.data?.message || err.message,
                });
                resolve();
            }
        };

        const queueMeta = {
            memberId,
            memberName: cleanName,
            patientProfile,
        };

        // 处理媒体文件
        if (media) {
            let buffer;
            if (Buffer.isBuffer(media)) {
                buffer = media;
            } else if (typeof media === 'string') {
                const cleanBase64 = media.replace(/^data:[^;]+;base64,/, '');
                buffer = Buffer.from(cleanBase64, 'base64');
            } else {
                buffer = Buffer.alloc(0);
            }

            const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            createAndRunMediaTask(userId, taskId, mediaType, fileName || 'upload_media', async () => {
                return await handleDirectMedia({
                    buffer,
                    msgtype: mediaType,
                    filename: fileName,
                    msgid: taskId,
                    meta: { ...queueMeta, memberId },
                });
            });

            touchMediaQueue(userId, queueMeta, onFlush);
        }

        // 处理文本
        if (content) {
            enqueueText(userId, { content, msgId: incomingMsgId }, queueMeta, onFlush);
        }

        // 尝试出队
        tryFlush(userId);
    });
}

/**
 * 查询家庭成员的最近历史消息 (GET /api/minihealth/history/:memberId)
 */
async function handleMiniHealthHistory(req, res, memberId) {
    try {
        const history = await getRecentHistory(memberId, 50, 'mini_health');
        sendJson(res, 200, {
            success: true,
            memberId,
            history,
            count: history.length,
        });
    } catch (e) {
        sendJson(res, 500, { success: false, error: e.message });
    }
}

/**
 * 启动统一 HTTP 服务
 */
function createHttpServer(port = 8080) {
    const server = http.createServer(async (req, res) => {
        setCorsHeaders(res);

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const pathname = url.pathname;

        // 1. Cloud Run 健康检查探针
        if (pathname === '/' || pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('OK');
            return;
        }

        // 2. MiniHealth 历史记录拉取
        if (req.method === 'GET' && pathname.startsWith('/api/minihealth/history/')) {
            const memberId = pathname.replace('/api/minihealth/history/', '');
            await handleMiniHealthHistory(req, res, decodeURIComponent(memberId));
            return;
        }

        // 3. MiniHealth 问答会话
        if (req.method === 'POST' && pathname === '/api/minihealth/chat') {
            let bodyStr = '';
            req.on('data', chunk => {
                bodyStr += chunk;
                // 30MB 保护上限
                if (bodyStr.length > 30 * 1024 * 1024) {
                    req.destroy();
                }
            });
            req.on('end', async () => {
                try {
                    const body = JSON.parse(bodyStr || '{}');
                    await handleMiniHealthChat(req, res, body);
                } catch (err) {
                    sendJson(res, 400, { error: 'Invalid JSON payload' });
                }
            });
            return;
        }

        sendJson(res, 404, { error: 'Not Found', path: pathname });
    });

    server.listen(port, () => {
        _log('http_gateway_started', { port, message: `统一 HTTP 网关已启动，监听端口 ${port}` });
    });

    return server;
}

module.exports = {
    createHttpServer,
    handleMiniHealthChat,
};
