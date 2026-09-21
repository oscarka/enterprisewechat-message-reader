/**
 * supabase_store.js
 * 通过 Supabase Transaction Pooler（PostgreSQL 直连）存储企微会话消息
 * 使用 aws-0-us-west-2.pooler.supabase.com 绕开 VPC DNS 无法解析 db.*.supabase.co 的问题
 * 使用 schema 全限定名（wechat_archiver.messages）实现项目隔离
 */
const { Pool } = require('pg');

const POOLER_URL = process.env.SUPABASE_POOLER_URL
    || 'postgresql://postgres.feaeonavsqzewadgoqeh:lnZbMyimxpMYgUp5@aws-0-us-west-2.pooler.supabase.com:5432/postgres';

const pool = new Pool({
    connectionString: POOLER_URL,
    ssl: { rejectUnauthorized: false, checkServerIdentity: () => undefined },
    max: 3,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
    console.error('[Supabase] Pool error:', err.message);
});

/**
 * 初始化：测试连通性
 */
async function initSchema() {
    const client = await pool.connect();
    try {
        const { rows: r1 } = await client.query(
            `SELECT COUNT(*) FROM wechat_archiver.messages`
        );
        const { rows: r2 } = await client.query(
            `SELECT COUNT(*) FROM mini_health.messages`
        );
        console.log(`[Supabase] Pooler 连接成功: wechat_archiver.messages (${r1[0].count} 条), mini_health.messages (${r2[0].count} 条) 已就绪`);
    } finally {
        client.release();
    }
}

/**
 * 写入一条消息（ON CONFLICT DO NOTHING）
 * @param {object} msg - 消息对象
 * @param {string} schema - 'wechat_archiver' | 'mini_health'
 */
async function saveMessage(msg, schema = 'wechat_archiver') {
    try {
        if (schema === 'mini_health') {
            const memberId = msg.memberId || msg.externalUserId;
            const memberName = msg.memberName || msg.name || '微信家庭成员';
            const userId = msg.userId || `u_${memberId.replace(/^mem_/, '')}`;
            const msgId = msg.msgid || msg.id || `msg_${Date.now()}`;
            const msgTime = msg.msgTime instanceof Date
                ? msg.msgTime.toISOString()
                : new Date(msg.msgTime || Date.now()).toISOString();

            // 自动确保所属主用户及家庭成员档案存在，消除外键约束报错
            await pool.query(
                `INSERT INTO mini_health.users (id, nickname) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
                [userId, memberName]
            );
            await pool.query(
                `INSERT INTO mini_health.members (id, user_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
                [memberId, userId, memberName]
            );

            await pool.query(
                `INSERT INTO mini_health.messages
                    (id, member_id, direction, msgtype, content, media_url, meta, msg_time)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (id) DO NOTHING`,
                [
                    msgId,
                    memberId,
                    msg.direction || 'inbound',
                    msg.msgtype || 'text',
                    msg.content || '',
                    msg.mediaUrl || msg.media_url || null,
                    JSON.stringify(msg.meta || {}),
                    msgTime,
                ]
            );
        } else {
            await pool.query(
                `INSERT INTO wechat_archiver.messages
                    (id, seq, external_user_id, external_user_name,
                     employee_user_id, employee_name, direction,
                     msgtype, content, content_summary, room_id, msg_time, raw_json)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                 ON CONFLICT (id) DO NOTHING`,
                [
                    msg.msgid,
                    msg.seq,
                    msg.externalUserId,
                    msg.externalUserName || '',
                    msg.employeeUserId || '',
                    msg.employeeName || '',
                    msg.direction,
                    msg.msgtype,
                    msg.content || '',
                    msg.contentSummary || '',
                    msg.roomId || '',
                    msg.msgTime instanceof Date
                        ? msg.msgTime.toISOString()
                        : new Date(msg.msgTime || Date.now()).toISOString(),
                    JSON.stringify(msg.rawJson || {}),
                ]
            );
        }
    } catch (err) {
        console.error(`[Supabase] saveMessage error [${schema}]:`, err.message);
    }
}

/**
 * 查询某个外部用户/成员最近 N 条消息（升序，最新在末尾）
 * 格式符合 skill-platform agent history 字段要求
 * @param {string} userId - externalUserId 或 memberId
 * @param {number} limit - 提取条数
 * @param {string} schema - 'wechat_archiver' | 'mini_health'
 * @returns {Array<{role: string, content: string, meta?: object}>}
 */
async function getRecentHistory(userId, limit = 20, schema = 'wechat_archiver') {
    try {
        if (schema === 'mini_health') {
            const { rows } = await pool.query(
                `SELECT direction, msgtype, content, meta
                 FROM mini_health.messages
                 WHERE member_id = $1
                   AND content IS NOT NULL
                   AND content != ''
                 ORDER BY msg_time DESC
                 LIMIT $2`,
                [userId, limit]
            );
            return rows.reverse().map(r => ({
                role:    r.direction === 'inbound' ? 'user' : 'assistant',
                content: r.content,
                meta:    r.meta || {},
            }));
        } else {
            const { rows } = await pool.query(
                `SELECT direction, msgtype, content
                 FROM wechat_archiver.messages
                 WHERE external_user_id = $1
                   AND (
                     msgtype = 'text'
                     OR (msgtype = 'voice' AND content != '')
                     OR (msgtype = 'file'  AND content != '')
                     OR (msgtype = 'image' AND content != '')
                   )
                   AND content IS NOT NULL
                   AND content != ''
                 ORDER BY msg_time DESC
                 LIMIT $2`,
                [userId, limit]
            );
            return rows.reverse().map(r => ({
                role:    r.direction === 'inbound' ? 'user' : 'assistant',
                content: r.content,
            }));
        }
    } catch (err) {
        console.error(`[Supabase] getRecentHistory error [${schema}]:`, err.message);
        return [];
    }
}

/**
 * 向 mini_health.records 写入打卡/代谢/生理信号数据
 */
async function saveRecord(record) {
    try {
        const id = record.id || `rec_${Date.now()}`;
        const recordDate = record.record_date || new Date().toISOString().slice(0, 10);
        const memberId = record.memberId || record.member_id;
        const userId = `u_${memberId.replace(/^mem_/, '')}`;

        // 自动确保所属主用户及家庭成员档案存在
        await pool.query(
            `INSERT INTO mini_health.users (id, nickname) VALUES ($1, '微信家庭用户') ON CONFLICT (id) DO NOTHING`,
            [userId]
        );
        await pool.query(
            `INSERT INTO mini_health.members (id, user_id, name) VALUES ($1, $2, '家庭成员') ON CONFLICT (id) DO NOTHING`,
            [memberId, userId]
        );

        await pool.query(
            `INSERT INTO mini_health.records
                (id, member_id, record_type, record_date, metrics, source_msg_id, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             ON CONFLICT (id) DO NOTHING`,
            [
                id,
                memberId,
                record.recordType || record.record_type || 'meal',
                recordDate,
                JSON.stringify(record.metrics || {}),
                record.sourceMsgId || record.source_msg_id || null,
            ]
        );
    } catch (err) {
        console.error('[Supabase] saveRecord error:', err.message);
    }
}

async function updateMessageContent(msgid, content, schema = 'wechat_archiver') {
    try {
        const table = schema === 'mini_health' ? 'mini_health.messages' : 'wechat_archiver.messages';
        await pool.query(
            `UPDATE ${table} SET content = $1 WHERE id = $2`,
            [content, msgid]
        );
    } catch (err) {
        console.error(`[Supabase] updateMessageContent error [${schema}]:`, err.message);
    }
}

async function getLatestInboundTime(userId, schema = 'wechat_archiver') {
    try {
        if (schema === 'mini_health') {
            const { rows } = await pool.query(
                `SELECT msg_time
                 FROM mini_health.messages
                 WHERE member_id = $1
                   AND direction = 'inbound'
                 ORDER BY msg_time DESC
                 LIMIT 1`,
                [userId]
            );
            return rows[0]?.msg_time ? new Date(rows[0].msg_time).getTime() : 0;
        } else {
            const { rows } = await pool.query(
                `SELECT msg_time
                 FROM wechat_archiver.messages
                 WHERE external_user_id = $1
                   AND direction = 'inbound'
                 ORDER BY msg_time DESC
                 LIMIT 1`,
                [userId]
            );
            return rows[0]?.msg_time ? new Date(rows[0].msg_time).getTime() : 0;
        }
    } catch (err) {
        console.error(`[Supabase] getLatestInboundTime error [${schema}]:`, err.message);
        return 0;
    }
}

module.exports = {
    initSchema,
    saveMessage,
    getRecentHistory,
    updateMessageContent,
    getLatestInboundTime,
    saveRecord,
    pool,
};
