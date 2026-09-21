/**
 * test_db_isolation.js
 * 验证 Supabase 中 mini_health 增补建表、外键约束、以及与 wechat_archiver 的数据物理隔离
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { Pool } = require('pg');

const POOLER_URL = process.env.SUPABASE_POOLER_URL
    || 'postgresql://postgres.feaeonavsqzewadgoqeh:lnZbMyimxpMYgUp5@aws-0-us-west-2.pooler.supabase.com:5432/postgres';

const pool = new Pool({
    connectionString: POOLER_URL,
    ssl: { rejectUnauthorized: false, checkServerIdentity: () => undefined },
    connectionTimeoutMillis: 10000,
});

async function runMigration() {
    console.log('\n--- [Step 1] 执行 01_mini_health_schema_extension.sql ---');
    const sqlPath = path.join(__dirname, '..', 'data', 'migrations', '01_mini_health_schema_extension.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    const client = await pool.connect();
    try {
        await client.query(sql);
        console.log('✅ SQL 增补迁移执行成功！');
    } finally {
        client.release();
    }
}

async function verifyTables() {
    console.log('\n--- [Step 2] 校验表结构完整性与既有表保留 ---');
    const { rows } = await pool.query(`
        SELECT table_schema, table_name 
        FROM information_schema.tables 
        WHERE table_schema IN ('mini_health', 'wechat_archiver')
        ORDER BY table_schema, table_name;
    `);

    const tableMap = {};
    for (const r of rows) {
        if (!tableMap[r.table_schema]) tableMap[r.table_schema] = new Set();
        tableMap[r.table_schema].add(r.table_name);
    }

    console.log('mini_health 表列表:', Array.from(tableMap['mini_health'] || []));
    console.log('wechat_archiver 表列表:', Array.from(tableMap['wechat_archiver'] || []));

    // 既有表必须完整保留
    assert.strictEqual(tableMap['mini_health'].has('care_services'), true, '既有表 care_services 必须保留');
    assert.strictEqual(tableMap['mini_health'].has('patient_situations'), true, '既有表 patient_situations 必须保留');
    assert.strictEqual(tableMap['mini_health'].has('service_bookings'), true, '既有表 service_bookings 必须保留');
    assert.strictEqual(tableMap['mini_health'].has('service_widgets'), true, '既有表 service_widgets 必须保留');

    // 增补表必须全部就绪
    assert.strictEqual(tableMap['mini_health'].has('users'), true, '增补表 users 必须就绪');
    assert.strictEqual(tableMap['mini_health'].has('members'), true, '增补表 members 必须就绪');
    assert.strictEqual(tableMap['mini_health'].has('messages'), true, '增补表 messages 必须就绪');
    assert.strictEqual(tableMap['mini_health'].has('records'), true, '增补表 records 必须就绪');

    // 企微表必须完好无损
    assert.strictEqual(tableMap['wechat_archiver'].has('messages'), true, '企微 messages 表必须完好无损');
    console.log('✅ 表结构完整性核实无误！');
}

async function verifyIsolationAndCRUD() {
    console.log('\n--- [Step 3] 验证 CRUD、外键级联与 Schema 隔离性 ---');
    const testUserId = `test_u_${Date.now()}`;
    const testMemberId = `test_m_${Date.now()}`;
    const testMsgId = `test_msg_${Date.now()}`;
    const testRecordId = `test_rec_${Date.now()}`;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. 插入 user
        await client.query(
            `INSERT INTO mini_health.users (id, phone, nickname) VALUES ($1, $2, $3)`,
            [testUserId, '13800000000', '测试用户']
        );

        // 2. 插入 member
        await client.query(
            `INSERT INTO mini_health.members (id, user_id, name, relation, age, gender) VALUES ($1, $2, $3, $4, $5, $6)`,
            [testMemberId, testUserId, '张明 (本人)', 'self', 42, 'male']
        );

        // 3. 插入 message
        await client.query(
            `INSERT INTO mini_health.messages (id, member_id, direction, msgtype, content) VALUES ($1, $2, $3, $4, $5)`,
            [testMsgId, testMemberId, 'inbound', 'text', '我脚骨折了多吃什么好']
        );

        // 4. 插入 record (打卡)
        await client.query(
            `INSERT INTO mini_health.records (id, member_id, record_type, metrics, source_msg_id) VALUES ($1, $2, $3, $4, $5)`,
            [testRecordId, testMemberId, 'meal', JSON.stringify({ calories: 450, protein: 32 }), testMsgId]
        );

        // 5. 验证读取
        const resMsg = await client.query(`SELECT * FROM mini_health.messages WHERE id = $1`, [testMsgId]);
        assert.strictEqual(resMsg.rows.length, 1);
        assert.strictEqual(resMsg.rows[0].content, '我脚骨折了多吃什么好');

        // 6. 验证企微 wechat_archiver.messages 查不到这条记录（严格数据隔离）
        const resWecom = await client.query(`SELECT * FROM wechat_archiver.messages WHERE id = $1`, [testMsgId]);
        assert.strictEqual(resWecom.rows.length, 0, 'mini_health 消息绝不能泄漏到 wechat_archiver.messages');

        // 7. 验证外键约束 (无效的 user_id 应该报错)
        let fkErrorCaught = false;
        try {
            await client.query(
                `INSERT INTO mini_health.members (id, user_id, name) VALUES ('invalid_mem', 'non_existent_user', '无效成员')`
            );
        } catch (e) {
            fkErrorCaught = true;
        }
        assert.strictEqual(fkErrorCaught, true, '外键约束应该生效并拦截无效 user_id');

        await client.query('ROLLBACK'); // 测试数据回滚，保证数据库纯净
        console.log('✅ CRUD、外键约束与两 Schema 隔离测试全部通过！');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function main() {
    try {
        await runMigration();
        await verifyTables();
        await verifyIsolationAndCRUD();
        console.log('\n🎉 Phase 1 数据库增补与隔离测试 100% 验证通过！');
        process.exit(0);
    } catch (err) {
        console.error('\n❌ Phase 1 测试失败:', err);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

main();
