/**
 * cua_forwarder.js
 * 将企微入站消息转发给 CUA 平台，触发 AI 回复
 *
 * ─── 【给 CUA 平台方的 API 变更说明】─────────────────────────────────────────
 *
 * 当前限制（ingest-api 文档 L311）：
 *   "Delivery 目标目前为固定值：recipient 和 app 由 .env 统一配置"
 *
 * 本服务在 meta 字段新增以下字段，请 CUA 平台侧支持：
 *
 * meta.recipient  (string) - 消息发送方的名称（即 CUA 应该回复给谁）
 *                             例: "oscar"
 *                             CUA 应优先用此值作为 delivery.recipient
 *                             而非读取固定 .env 值
 *
 * meta.app        (string) - 回复所用的 App（目前固定为"企业微信"）
 *                             例: "企业微信"
 *
 * meta.user_id    (string) - 外部联系人唯一 ID（企微 external_userid）
 *                             例: "wm9xuHYgAA6TFURBHCp83TkkPgYatcmQ"
 *                             建议 CUA 平台用此值作为 session_id 的依据
 *
 * 推荐的 session_id 格式：直接使用 external_user_id，可保证每个客户的对话历史独立
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

const axios = require('axios');

// CUA 平台的 /api/ingest 地址（通过 Cloudflare Tunnel 或 Tailscale IP 访问）
const CUA_INGEST_URL = process.env.CUA_INGEST_URL; // 例: https://xxx.trycloudflare.com/api/ingest

/**
 * 将一条入站消息（客户 → 员工）转发给 CUA 平台
 *
 * @param {Object} opts
 * @param {string} opts.content          - 消息文本内容
 * @param {string} opts.externalUserId   - 外部联系人 ID (wm... / wo...)
 * @param {string} opts.externalUserName - 外部联系人名称（用于 CUA 找到对话窗口）
 * @param {string} opts.employeeUserId   - 员工 ID
 * @param {string} opts.employeeName     - 员工名称
 * @param {Array}  opts.history          - 近期对话历史 [{role, content}]
 */
async function forwardToCua(opts) {
    if (!CUA_INGEST_URL) {
        // 未配置 CUA_INGEST_URL 时静默跳过（不影响存档功能）
        return;
    }

    const { content, externalUserId, externalUserName, employeeUserId, employeeName, history } = opts;

    // 从 CUA_INGEST_URL 推导 callback_url（把 /api/ingest 换成 /api/agent-callback）
    const cuaBase = CUA_INGEST_URL.replace(/\/api\/ingest.*$/, '');
    const callbackUrl = `${cuaBase}/api/agent-callback`;

    const body = {
        content,
        source:     'wecom',
        session_id: externalUserId,              // 用外部联系人 ID 作为会话 ID，保持对话独立
        meta: {
            from_name:  externalUserName || externalUserId,
            user_id:    externalUserId,
            // ↓ 新增字段：告诉 CUA 平台应该回复给谁（见上方 API 变更说明）
            recipient:  externalUserName || externalUserId,
            app:        '企业微信',
            channel:    'wecom_archive',
            employee:   employeeName || employeeUserId, // 哪个员工账号在对话
        },
        // 传入最近对话历史，让 AI 有上下文
        ...(history && history.length > 0 ? { history } : {}),
        // skill_id：从环境变量读取，留空时 skill-platform 自动路由
        ...(process.env.CUA_SKILL_ID ? { skill_id: process.env.CUA_SKILL_ID } : {}),
        // callback_url：skill 异步执行完后回调此地址推送结果
        callback_url: callbackUrl,
    };

    try {
        // 新接口：POST → 立即返回 202 Accepted + task_id，后台异步处理
        // 无需等待 SSE 流，直接拿到响应即可
        const resp = await axios.post(CUA_INGEST_URL, body, {
            timeout:        15000,
            validateStatus: (s) => s < 500,
        });

        // 如果是旧 SSE 接口（200 + stream），销毁流避免内存泄漏
        if (resp.data && typeof resp.data.destroy === 'function') {
            resp.data.destroy();
        }

        const taskId   = resp.data?.task_id || '-';
        const accepted = resp.data?.status   || resp.status;

        console.log(JSON.stringify({
            type:            'cua_forwarded',
            httpStatus:      resp.status,
            taskId,
            accepted,
            externalUserId,
            externalUserName,
            contentLen:      content.length,
            historyLen:      (history || []).length,
            ts:              new Date().toISOString(),
        }));
    } catch (err) {
        // 转发失败不影响存档（降级处理）
        console.error('[CUA] 转发失败:', err.message);
    }
}

module.exports = { forwardToCua };
