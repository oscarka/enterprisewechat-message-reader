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
        const { rows } = await client.query(
            `SELECT COUNT(*) FROM wechat_archiver.messages`
        );
        console.log(`[Supabase] Pooler 连接成功，wechat_archiver.messages 已就绪（现有 ${rows[0].count} 条记录）`);
    } finally {
        client.release();
    }
}

/**
 * 写入一条消息（ON CONFLICT DO NOTHING）
 */
async function saveMessage(msg) {
    try {
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
                msg.employeeUserId,
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
    } catch (err) {
        console.error('[Supabase] saveMessage error:', err.message);
    }
}

/**
 * 查询某个外部用户最近 N 条文本消息（升序，最新在末尾）
 * 格式符合 skill-platform agent history 字段要求
 * @returns {Array<{role: string, content: string}>}
 */
async function getRecentHistory(externalUserId, limit = 20) {
    try {
        const { rows } = await pool.query(
            `SELECT direction, content
             FROM wechat_archiver.messages
             WHERE external_user_id = $1
               AND msgtype = 'text'
               AND content IS NOT NULL
               AND content != ''
             ORDER BY msg_time DESC
             LIMIT $2`,
            [externalUserId, limit]
        );
        // 倒序变升序（最新在末尾）
        return rows.reverse().map(r => ({
            role:    r.direction === 'inbound' ? 'user' : 'assistant',
            content: r.content,
        }));
    } catch (err) {
        console.error('[Supabase] getRecentHistory error:', err.message);
        return [];
    }
}

async function getLatestInboundTime(externalUserId) {
    try {
        const { rows } = await pool.query(
            `SELECT msg_time
             FROM wechat_archiver.messages
             WHERE external_user_id = $1
               AND direction = 'inbound'
             ORDER BY msg_time DESC
             LIMIT 1`,
            [externalUserId]
        );
        return rows[0]?.msg_time ? new Date(rows[0].msg_time).getTime() : 0;
    } catch (err) {
        console.error('[Supabase] getLatestInboundTime error:', err.message);
        return 0;
    }
}

module.exports = { initSchema, saveMessage, getRecentHistory, getLatestInboundTime };
