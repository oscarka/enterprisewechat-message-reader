/**
 * cua_forwarder.js
 * 将企微入站消息转发给 CUA 平台，触发 AI 回复
 *
 * ─── 幂等 + 重试机制 ───────────────────────────────────────────────────────
 *
 * 1. 每条消息带 idempotency_key（企微 msgid），CUA 侧用 Redis 去重
 *    → 重试时即使消息已处理，也不会被重复入队
 *
 * 2. 遇到 5xx 错误自动重试（最多 3 次，间隔 5s / 10s / 20s）
 *    → 解决 CUA backend 短暂重启/502 导致消息丢失的问题
 *
 * 3. 所有重试耗尽后记录 cua_forward_dead 日志（供人工补发）
 *
 * ─── meta 字段说明（给 CUA 平台方）────────────────────────────────────────
 *
 * meta.recipient  - 消息发送方名称，CUA 回复给谁
 * meta.app        - "企业微信"
 * meta.user_id    - 外部联系人 ID（企微 external_userid）
 *
 * ─────────────────────────────────────────────────────────────────────────
 */

const axios = require('axios');

const CUA_INGEST_URL         = process.env.CUA_INGEST_URL;
const SKILL_PLATFORM_URL     = process.env.SKILL_PLATFORM_URL; // 新增：直接转发给 Skill Platform
const MAX_RETRY              = 3;
const RETRY_DELAY_MS         = [5000, 10000, 20000]; // 指数退避


/**
 * 将一条入站消息转发给 CUA 平台
 *
 * @param {Object} opts
 * @param {string} opts.content          - 消息文本内容
 * @param {string} opts.externalUserId   - 外部联系人 ID
 * @param {string} opts.externalUserName - 外部联系人名称
 * @param {string} opts.employeeUserId   - 员工 ID
 * @param {string} opts.employeeName     - 员工名称
 * @param {Array}  opts.history          - 近期对话历史 [{role, content}]
 * @param {string} opts.msgId            - 企微消息 ID（幂等键，防重试重复处理）
 */
async function forwardToCua(opts) {
    if (!CUA_INGEST_URL) return;

    const { content, externalUserId, externalUserName, employeeUserId, employeeName, history, msgId } = opts;

    const cuaBase   = CUA_INGEST_URL.replace(/\/api\/ingest.*$/, '');
    const callbackUrl = `${cuaBase}/api/agent-callback`;

    const body = {
        content,
        source:          'wecom',
        session_id:      externalUserId,
        idempotency_key: msgId || '',          // 企微 msgid → CUA 侧 Redis 去重
        meta: {
            from_name: externalUserName || externalUserId,
            user_id:   externalUserId,
            recipient: externalUserName || externalUserId,
            app:       '企业微信',
            channel:   'wecom_archive',
            employee:  employeeName || employeeUserId,
        },
        ...(history && history.length > 0 ? { history } : {}),
        callback_url: callbackUrl,
    };

    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
        try {
            const resp = await axios.post(CUA_INGEST_URL, body, {
                timeout:        15000,
                validateStatus: (s) => s < 500,  // 5xx → catch → 重试；4xx → 业务错误不重试
            });

            if (resp.data && typeof resp.data.destroy === 'function') resp.data.destroy();

            console.log(JSON.stringify({
                type:            'cua_forwarded',
                httpStatus:      resp.status,
                taskId:          resp.data?.task_id || '-',
                accepted:        resp.data?.status  || resp.status,
                attempt,
                externalUserId,
                externalUserName,
                contentLen:      content.length,
                historyLen:      (history || []).length,
                msgId:           msgId || '-',
                ts:              new Date().toISOString(),
            }));
            return; // ✅ 成功

        } catch (err) {
            if (attempt >= MAX_RETRY) {
                // 所有重试耗尽 → 死信日志（人工可查）
                console.error(JSON.stringify({
                    type:           'cua_forward_dead',
                    error:          err.message,
                    attempts:       attempt + 1,
                    externalUserId,
                    externalUserName,
                    contentPreview: content.slice(0, 80),
                    msgId:          msgId || '-',
                    ts:             new Date().toISOString(),
                }));
            } else {
                const delayMs = RETRY_DELAY_MS[attempt] || 20000;
                console.warn(JSON.stringify({
                    type:     'cua_forward_retry',
                    attempt:  attempt + 1,
                    maxRetry: MAX_RETRY,
                    delayMs,
                    error:    err.message,
                    msgId:    msgId || '-',
                    ts:       new Date().toISOString(),
                }));
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }
}

/**
 * 并行转发给 Skill Platform（/api/orch/ingest）
 * fire-and-forget，不阻塞 CUA 转发流程
 */
async function forwardToSkillPlatform(opts) {
    if (!SKILL_PLATFORM_URL) {
        console.warn(JSON.stringify({ type: 'skill_platform_skip', reason: 'SKILL_PLATFORM_URL not set', ts: new Date().toISOString() }));
        return;
    }

    const { content, externalUserId, externalUserName, employeeUserId, employeeName, history, msgId, msgtype, mediaUrl, fileName, fileType, unionid } = opts;

    const body = {
        from_name:       externalUserName || externalUserId,
        from_user_id:    externalUserId,
        unionid:         unionid || null,   // 跨平台唯一 ID，用于 wecom/juhe 身份合并
        content,
        msgtype:         msgtype || 'text',
        channel:         'wecom',
        conversation_id: externalUserId,
        employee_id:     employeeUserId,
        employee_name:   employeeName,
        history:         history || [],
        idempotency_key: msgId || '',
        media_url:       mediaUrl || null,
        file_name:       fileName || null,
        file_type:       fileType || null,
    };


    const url = SKILL_PLATFORM_URL.replace(/\/?$/, '') + '/api/orch/ingest';

    try {
        const resp = await axios.post(url, body, { timeout: 15000 });
        console.log(JSON.stringify({
            type:       'skill_platform_forwarded',
            httpStatus: resp.status,
            url,
            externalUserId,
            externalUserName,
            ts:         new Date().toISOString(),
        }));
    } catch (err) {
        console.warn(JSON.stringify({
            type:  'skill_platform_forward_fail',
            error: err.message,
            url,
            ts:    new Date().toISOString(),
        }));
    }
}

module.exports = { forwardToCua, forwardToSkillPlatform };
