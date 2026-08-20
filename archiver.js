/**
 * wechat-archiver — 主服务
 *
 * 功能：
 *   1. 持续从企微会话存档接口拉取历史消息（wework-chat-node SDK）
 *   2. 将发送方的 userID 解析为真实姓名（externalcontact/get API）
 *   3. 输出结构化 JSON 日志（Cloud Logging 可直接查询）
 *   4. 将拉取进度（seq）持久化到 GCS，Cloud Run 重启后断点续传
 *
 * 环境变量（见 .env.example）：
 *   WX_CORP_ID, WECOM_CHATDATA_SECRET, WX_AGENT_SECRET
 *   STATE_BUCKET, START_SEQ
 *
 * 注意：
 *   - Cloud Run 要求容器监听 HTTP 端口，此处启动一个最小健康检查服务器
 *   - 会话存档 getChatData 的 IP 白名单需在企微「会话存档」管理页单独添加
 */

require('dotenv').config();

const http        = require('http');
const fs          = require('fs');
const path        = require('path');
const { WeWorkChat } = require('wework-chat-node');

const NameResolver  = require('./name_resolver');
const SeqStore      = require('./seq_store');
const { initSchema, saveMessage, getRecentHistory, updateMessageContent } = require('./supabase_store');
const { forwardToCua, forwardToSkillPlatform } = require('./cua_forwarder');
const { enqueue }      = require('./message_debouncer');
const { handleMedia }  = require('./media_handler');

// 需要尝试下载媒体的消息类型
const MEDIA_TYPES = new Set(['image', 'voice', 'video', 'file']);

// ─── 配置 ─────────────────────────────────────────────────────
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '500', 10);
const PRIVATE_KEY_PATH = path.join(__dirname, 'data', 'rsa_keys', 'private.pem');

// ─── 工具函数 ─────────────────────────────────────────────────
function log(severity, type, extra = {}) {
    const entry = { severity, type, ...extra, ts: new Date().toISOString() };
    console.log(JSON.stringify(entry));
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ─── Cloud Run 健康检查服务器 ──────────────────────────────────
// Cloud Run 要求容器在启动时监听指定端口，否则 startup probe 会超时
const PORT = parseInt(process.env.PORT || '8080', 10);
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
}).listen(PORT, () => {
    log('INFO', 'health_server', { message: `健康检查服务器已启动，监听端口 ${PORT}` });
});


// ─── 消息内容摘要 ─────────────────────────────────────────────
function extractContent(msg) {
    switch (msg.msgtype) {
        case 'text':
            return { content: msg.text?.content || '', summary: (msg.text?.content || '').substring(0, 200) };
        case 'image':
            return { content: '', summary: '[图片]' };
        case 'voice':
            // voiceto_text 是企微自动 ASR 转写，有则直接用
            const vtt = msg.voice?.voiceto_text || '';
            return { content: vtt, summary: vtt ? `[语音转文字]: ${vtt}` : '[语音]' };
        case 'video':
            return { content: '', summary: '[视频]' };
        case 'file':
            return { content: '', summary: `[文件: ${msg.file?.filename || ''}]` };
        case 'link':
            return { content: msg.link?.url || '', summary: `[链接: ${msg.link?.title || ''}]` };
        case 'weapp':
            return { content: '', summary: `[小程序: ${msg.weapp?.title || ''}]` };
        case 'revoke':
            return { content: '', summary: '[消息已撤回]' };
        case 'agree':
            return { content: '', summary: '[同意会话存档]' };
        case 'disagree':
            return { content: '', summary: '[拒绝会话存档]' };
        case 'emotion':
            return { content: '', summary: '[表情]' };
        case 'card':
            return { content: '', summary: `[名片: ${msg.card?.name || ''}]` };
        case 'location':
            return { content: '', summary: `[位置: ${msg.location?.title || ''}]` };
        default:
            return { content: '', summary: `[${msg.msgtype || 'unknown'}]` };
    }
}

// ─── 处理单条消息 ─────────────────────────────────
async function processMessage(msg, nameResolver) {
    const fromId   = msg.from   || '';
    const toList   = msg.tolist || [];
    const toId     = toList[0] || '';
    const roomid   = msg.roomid || '';
    const seq      = msg.seq;

    // 解析发送方和接收方姓名（并行，不互相依赖）
    const [fromName, toName] = await Promise.all([
        nameResolver.resolve(fromId),
        toId ? nameResolver.resolve(toId) : Promise.resolve(null),
    ]);

    // 解析消息内容
    const { content, summary } = extractContent(msg);

    // 解析消息时间（企微 msgtime 是毫秒级时间戳）
    const msgTime = msg.msgtime
        ? new Date(msg.msgtime).toISOString()
        : new Date().toISOString();

    // 判断消息方向：外部用户发给员工 = inbound，员工发给外部用户 = outbound
    const isInbound      = !fromName.isEmployee;
    const extUserId      = isInbound ? fromId : toId;
    const extUserName    = isInbound ? fromName.displayName : (toName?.displayName || toId);
    const empUserId      = isInbound ? toId : fromId;
    const empName        = isInbound ? (toName?.displayName || toId) : fromName.displayName;

    // 构造结构化日志条目（这是核心输出，Cloud Logging 可查询）
    const entry = {
        severity:         'INFO',
        type:             'wechat_message',
        seq,
        msg_time:         msgTime,
        direction:        isInbound ? 'inbound' : 'outbound',
        from_user_id:     fromId,
        from_name:        fromName.displayName,
        from_wechat_name: fromName.wechatName,
        from_remark:      fromName.remark,
        from_is_employee: fromName.isEmployee,
        to_user_ids:      toList,
        to_name:          toName?.displayName || '',
        room_id:          roomid,
        msgtype:          msg.msgtype,
        content_summary:  summary,
        // 仅文本消息才输出完整内容（其他类型太大）
        ...(msg.msgtype === 'text' ? { content } : {}),
    };

    console.log(JSON.stringify(entry));

    // 返回结构化数据，供 Supabase 存储和 CUA 转发使用
    // 注意：企微 SDK 的 seq 在批次级别（ret.last_seq），单条消息可能没有 seq 字段
    // 从 msgid 中提取数字部分作为备用 seq（msgid 格式：{id}_{timestamp}_{suffix}）
    const seqFallback = (() => {
        const parts = (msg.msgid || '').split('_');
        if (parts.length >= 2) {
            const n = parseInt(parts[1], 10);
            if (!isNaN(n)) return n;
        }
        return null;
    })();

    return {
        msgid:            msg.msgid || `seq_${seq}`,
        seq:              seq || seqFallback,
        externalUserId:   extUserId,
        externalUserName: extUserName,
        externalUnionid:  isInbound ? (fromName.unionid || null) : null,  // 外部用户 unionid
        employeeUserId:   empUserId,
        employeeName:     empName,
        direction:        isInbound ? 'inbound' : 'outbound',
        msgtype:          msg.msgtype || '',
        content:          content || '',
        contentSummary:   summary || '',
        roomId:           roomid,
        msgTime:          new Date(msg.msgtime || Date.now()),
        rawJson:          msg,
    };
}

// ─── 主轮询循环 ───────────────────────────────────────────────
async function main() {
    // 1. 检查私钥
    if (!fs.existsSync(PRIVATE_KEY_PATH)) {
        log('CRITICAL', 'startup', { message: `私钥不存在: ${PRIVATE_KEY_PATH}` });
        process.exit(1);
    }
    const privateKey = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');

    // 2. 检查必要环境变量
    const missing = ['WX_CORP_ID', 'WECOM_CHATDATA_SECRET'].filter(k => !process.env[k]);
    if (missing.length > 0) {
        log('CRITICAL', 'startup', { message: `缺少必要环境变量: ${missing.join(', ')}` });
        process.exit(1);
    }

    // 3. 初始化 SDK
    const sdk = new WeWorkChat({
        corpid:      process.env.WX_CORP_ID,
        secret:      process.env.WECOM_CHATDATA_SECRET,
        private_key: privateKey,
        seq:         0,
    });

    const nameResolver = new NameResolver();
    const seqStore     = new SeqStore();

    // 4. 初始化 Supabase 表（如果 DATABASE_URL 未配置则跳过）
    try {
        await initSchema();
    } catch (e) {
        log('WARNING', 'supabase_init_failed', { message: e.message, hint: '存储功能将被跳过，会话存档仍正常运行' });
    }

    // 5. 加载上次进度
    let currentSeq = await seqStore.load();

    log('INFO', 'startup', {
        message:    '企微会话存档拉取服务启动',
        corpId:     process.env.WX_CORP_ID,
        startSeq:   currentSeq,
        pollInterval: POLL_INTERVAL_MS,
        supabase:   process.env.SUPABASE_SERVICE_KEY ? 'REST API 已配置' : '(未配置，存储将跳过)',
        cuaIngest:  process.env.CUA_INGEST_URL || '(未配置，转发将被跳过)',
    });

    // 5. 主循环
    let errorCount = 0;
    let emptyCount = 0;

    while (true) {
        try {
            const ret = sdk.getChatData({
                max_results: 100,
                timeout:     3,
                seq:         currentSeq,
            });

            // 没有新消息
            if (!ret || !ret.data || ret.data.length === 0) {
                errorCount = 0;
                emptyCount++;
                // 每 20 次空轮询（约 60 秒）打一条心跳，确认 API 调用正常
                if (emptyCount % 20 === 1) {
                    log('INFO', 'heartbeat', {
                        message: '轮询正常，暂无新消息',
                        currentSeq,
                        emptyPolls: emptyCount,
                        retHasData: ret ? (ret.data ? ret.data.length : 'data=null') : 'ret=null',
                    });
                }
                await sleep(POLL_INTERVAL_MS);
                continue;
            }

            log('INFO', 'poll_batch', {
                count:      ret.data.length,
                currentSeq,
            });

            // 处理每条消息
            for (const msgStr of ret.data) {
                if (!msgStr) continue;
                let msg;
                try {
                    msg = JSON.parse(msgStr);
                } catch (e) {
                    log('ERROR', 'parse_error', { message: e.message, raw: String(msgStr).substring(0, 100) });
                    continue;
                }

                // 消息年龄过滤：只转发 5 分钟内的消息，防止重启后重播历史
                const MAX_AGE_MS = parseInt(process.env.MAX_MSG_AGE_MS || '300000', 10); // 默认 5 分钟
                const msgAgeMs = msg.msgtime ? Date.now() - msg.msgtime : 0;
                const isFresh = msgAgeMs < MAX_AGE_MS;
                if (!isFresh) {
                    log('INFO', 'msg_age_skip', {
                        seq: msg.seq,
                        ageSec: Math.round(msgAgeMs / 1000),
                        reason: '历史消息（>5分钟），只存档不转发',
                    });
                }

                const result = await processMessage(msg, nameResolver);

                // DEBUG: 记录原始消息结构
                if (msg.msgtype === 'voice') {
                    // 语音消息单独完整记录 voice 对象，确认 voiceto_text 是否存在
                    log('DEBUG', 'voice_raw', {
                        voice:   msg.voice,
                        hasVtt:  !!(msg.voice?.voiceto_text),
                    });
                } else {
                    log('DEBUG', 'raw_message_sample', {
                        rawKeys:    Object.keys(msg),
                        rawSnippet: JSON.stringify(msg).substring(0, 500),
                    });
                }

                // 存入 Supabase
                if (result) {
                    // 存入 Supabase（fire-and-forget，不阻塞转发）
                    saveMessage(result).catch(e =>
                        log('WARNING', 'supabase_save_failed', { message: e.message })
                    );

                    // 仅处理外部用户发起的单聊消息（不含群聊、员工发起）且消息足够新
                    if (result.direction === 'inbound' && !result.roomId && isFresh) {

                        // 确定转发内容
                        let itemContent  = result.content;  // 文本消息直接用
                        let itemMediaUrl = null;

                        // 非语音媒体（图片/视频/文件）标记 mediaOnly，flush 时若仍无内容则静默
                        // 注意：PDF 提取成功后会重置 isMediaOnly = false，确保 agent 能收到
                        let isMediaOnly = MEDIA_TYPES.has(result.msgtype) && result.msgtype !== 'voice';
                        if (MEDIA_TYPES.has(result.msgtype)) {
                            // 媒体消息：立即下载（不等 flush，节省后续处理时间）
                            log('INFO', 'media_eager_download', {
                                userId:    result.externalUserId,
                                msgtype:   result.msgtype,
                                isMediaOnly,
                                reason:    isMediaOnly
                                    ? '立即下载，标记 mediaOnly（flush 时若无文字/语音则静默）'
                                    : '语音消息，立即下载 + 进入防抖队列',
                            });
                            const mediaResult = await handleMedia(sdk, msg).catch(e => {
                                log('WARNING', 'media_handle_failed', { message: e.message });
                                return { content: `[${result.msgtype}]`, mediaUrl: null };
                            });
                            itemContent  = mediaResult.content;
                            itemMediaUrl = mediaResult.mediaUrl;
                            // 将 AI 分析结果存回 Supabase（确保语音转写/图片描述进入历史）
                            if (itemContent && result.msgid) {
                                await updateMessageContent(result.msgid, itemContent).catch(() => {});
                            }
                            // PDF 成功提取内容 → 视为有价值消息，取消 file-only skip
                            if (result.msgtype === 'file' && itemContent && itemContent.includes('AI摘要:')) {
                                isMediaOnly = false;
                            }
                            log('INFO', 'media_download_done', {
                                userId:   result.externalUserId,
                                msgtype:  result.msgtype,
                                content:  (itemContent || '').substring(0, 50),
                                hasUrl:   !!itemMediaUrl,
                            });
                        }

                        // 判断是否需要立即转发给 agent：
                        // ✅ 文字消息（text）→ 立即转发
                        // ✅ 语音转写成功 → 立即转发（用户"说话了"）
                        // ❌ 文件/图片（有无 AI摘要均不转发）→ 只暂存 URL 到 user_recent_files
                        //    等用户主动发文字才触发 agent，届时文件自动挂载到工单
                        const isFileOrImage = result.msgtype === 'file' || result.msgtype === 'image';
                        const isTextMessage = result.msgtype === 'text';
                        const hasMeaningfulContent = !!itemContent && (
                            isTextMessage                           // 文字消息 → 立即触发
                            || result.msgtype === 'voice'           // 语音已转写 → 立即触发
                        );

                        // 先把文件/图片的 AI摘要或图片描述内容通过 ingest 保存到 user_recent_files，但不触发 agent
                        if (isFileOrImage && itemContent && (itemContent.includes('AI摘要:') || itemContent.startsWith('[图片:') || itemContent.startsWith('[文件:'))) {
                            // 有实质描述/摘要：调 ingest 保存（ingest 端会检测 isFileOnlyContent=true，只暂存不触发 agent）
                            log('INFO', 'media_aisum_save', {
                                userId:  result.externalUserId,
                                msgtype: result.msgtype,
                                reason:  '文件/图片已生成AI摘要，通过ingest暂存，等用户发文字再触发agent',
                                preview: itemContent.slice(0, 80),
                            });
                            const history = await getRecentHistory(result.externalUserId, 20).catch(() => []);
                            void forwardToSkillPlatform({
                                content:          itemContent,
                                externalUserId:   result.externalUserId,
                                externalUserName: result.externalUserName,
                                unionid:          result.externalUnionid || null,
                                employeeUserId:   result.employeeUserId,
                                employeeName:     result.employeeName,
                                history,
                                msgId:            result.msgid || '',
                                msgtype:          result.msgtype || 'file',
                                mediaUrl:         itemMediaUrl || null,
                                fileName:         msg.file?.filename || null,
                                fileType:         result.msgtype || null,
                            });
                        } else if (isMediaOnly && !hasMeaningfulContent) {
                            log('INFO', 'media_only_skip', {
                                userId:  result.externalUserId,
                                msgtype: result.msgtype,
                                reason:  '纯媒体消息（无有效摘要），已暂存 URL 到 user_recent_files，等用户发文字再触发 agent',
                                contentPreview: (itemContent || '').slice(0, 60),
                            });
                        } else if (hasMeaningfulContent) {

                            // 文字消息或语音转写成功 → 立即转发
                            log('INFO', 'forward_immediate', {
                                userId:  result.externalUserId,
                                msgtype: result.msgtype,
                                preview: itemContent.substring(0, 50),
                            });
                            const history = await getRecentHistory(result.externalUserId, 20)
                                .catch(() => []);
                            const fileName = msg.file?.filename || (result.msgtype === 'image' ? '图片.jpg' : '');
                            void forwardToSkillPlatform({
                                content:          itemContent,
                                externalUserId:   result.externalUserId,
                                externalUserName: result.externalUserName,
                                unionid:          result.externalUnionid || null,
                                employeeUserId:   result.employeeUserId,
                                employeeName:     result.employeeName,
                                history,
                                msgId:            result.msgid || '',
                                msgtype:          (result.msgtype === 'voice') ? 'text' : (result.msgtype || 'text'),
                                mediaUrl:         itemMediaUrl || null,
                                fileName:         fileName || null,
                                fileType:         result.msgtype || null,
                            });

                        }


                    }
                }

                if (msg.seq && msg.seq > currentSeq) {
                    currentSeq = msg.seq;
                }
            }

            // 更新 seq
            if (ret.last_seq && ret.last_seq > currentSeq) {
                currentSeq = ret.last_seq;
            }

            await seqStore.save(currentSeq);
            errorCount = 0;

        } catch (err) {
            errorCount++;
            const waitMs = Math.min(errorCount * 5000, 60000);

            // 301042 = getChatData IP 白名单未配置（企微「会话存档」管理页需单独添加 IP）
            if (err.message && err.message.includes('whiteip not match')) {
                log('WARNING', 'ip_whitelist_required', {
                    message: '⚠️ 会话存档接口 IP 白名单未配置！请登录企微管理后台 → 管理工具 → 会话内容存档 → IP 白名单 → 添加 35.233.194.33',
                    hint:    '注意：会话存档的 IP 白名单与应用可信 IP 是两个独立配置',
                    retryInMs: waitMs,
                });
            } else {
                log('ERROR', 'poll_error', {
                    message:   err.message,
                    errorCount,
                    retryInMs: waitMs,
                });
            }
            await sleep(waitMs);
        }
    }
}

// ─── 进程守护 ──────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
    log('ERROR', 'unhandled_rejection', { message: String(reason) });
});

main().catch(e => {
    log('CRITICAL', 'crash', { message: e.message, stack: e.stack });
    process.exit(1);
});
