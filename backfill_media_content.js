/**
 * backfill_media_content.js
 * 一次性补录脚本：对 Supabase 里 content 为空的 voice/image/file 消息重新提取内容
 *
 * 使用方式：
 *   node backfill_media_content.js [--dry-run] [--type voice|image|file]
 */
require('dotenv').config();

const { Pool }        = require('pg');
const { Storage }     = require('@google-cloud/storage');
const { GoogleGenAI } = require('@google/genai');
let pdfParse;
try { 
    const mod = require('pdf-parse');
    pdfParse = typeof mod === 'function' ? mod : (mod.PDFParse || mod.default);
} catch(e) {}

const MEDIA_BUCKET = process.env.MEDIA_BUCKET || 'wechat-archiver-media';
const DRY_RUN      = process.argv.includes('--dry-run');
const TYPE_FILTER  = process.argv.includes('--type')
    ? process.argv[process.argv.indexOf('--type') + 1]
    : null;

const pool = new Pool({
    connectionString: process.env.SUPABASE_POOLER_URL
        || 'postgresql://postgres.feaeonavsqzewadgoqeh:lnZbMyimxpMYgUp5@aws-0-us-west-2.pooler.supabase.com:5432/postgres',
    ssl: { rejectUnauthorized: false, checkServerIdentity: () => undefined },
    max: 3,
});

// ── Gemini 工具 ─────────────────────────────────────────────────────────────

async function _describeImage(buffer) {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const resp = await ai.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        contents: [{ parts: [
            { text: '请用1-2句话简洁描述这张图片的主要内容（直接描述，不要解释）：' },
            { inlineData: { mimeType: 'image/jpeg', data: buffer.toString('base64') } },
        ]}],
    });
    return (resp.text || '').trim() || '[图片]';
}

async function _summarizeDocument(text, filename) {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const resp = await ai.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        contents: [{ parts: [{ text:
            `请用2-3句话简洁概括以下文档的主要内容（文件名：${filename}），直接输出摘要，不要解释：\n\n${text.slice(0, 4000)}`
        }]}],
    });
    return (resp.text || '').trim() || text.slice(0, 300);
}

async function _transcribeAudio(buffer) {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const resp = await ai.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        contents: [{ parts: [
            { text: '请将这段语音转写为文字，只输出转写内容，不要加任何解释：' },
            { inlineData: { mimeType: 'audio/amr', data: buffer.toString('base64') } },
        ]}],
    });
    return (resp.text || '').trim();
}

// ── GCS 下载（支持前后一天容差）──────────────────────────────────────────────

async function _downloadFromGCS(msgid, msgtype, msgTime, filename) {
    const storage = new Storage();
    const bucket  = storage.bucket(MEDIA_BUCKET);
    const extMap  = { image: 'jpg', voice: 'amr', video: 'mp4' };
    const ext     = extMap[msgtype] || (filename?.split('.').pop() || 'bin');

    for (const offset of [0, -1, 1]) {
        const d = new Date(new Date(msgTime).getTime() + offset * 86400000);
        const path = `${d.toISOString().slice(0, 10)}/${msgid}.${ext}`;
        try {
            const [buf] = await bucket.file(path).download();
            if (offset !== 0) console.log(`  (日期偏移 ${offset} 天找到)`);
            return buf;
        } catch {}
    }
    throw new Error(`GCS 文件不存在: ${msgid}.${ext}`);
}

// ── 数据库写入 ───────────────────────────────────────────────────────────────

async function updateContent(id, content) {
    if (DRY_RUN) {
        console.log(`  [DRY-RUN] 不写入，内容: ${content.slice(0, 80)}`);
        return;
    }
    await pool.query(
        `UPDATE wechat_archiver.messages SET content = $1 WHERE id = $2`,
        [content, id]
    );
}

// ── 各类型处理 ───────────────────────────────────────────────────────────────

async function processVoice(row) {
    // 优先用 raw_json 里的 voiceto_text（不需要网络请求）
    let rawJson = {};
    try { rawJson = JSON.parse(row.raw_json || '{}'); } catch {}
    const vtt = rawJson?.voice?.voiceto_text;
    if (vtt) {
        await updateContent(row.id, `[语音转文字]: ${vtt}`);
        console.log(`  ✅ raw_json.voiceto_text: ${vtt.slice(0, 60)}`);
        return true;
    }
    // 降级：从 GCS 下载 AMR → Gemini STT
    try {
        const buf        = await _downloadFromGCS(row.id, 'voice', row.msg_time, null);
        const transcript = await _transcribeAudio(buf);
        if (transcript) {
            await updateContent(row.id, `[语音转文字]: ${transcript}`);
            console.log(`  ✅ Gemini STT: ${transcript.slice(0, 60)}`);
            return true;
        }
        console.log(`  ⚠️  STT 结果为空`);
    } catch (e) { console.log(`  ❌ ${e.message}`); }
    return false;
}

async function processImage(row) {
    try {
        const buf  = await _downloadFromGCS(row.id, 'image', row.msg_time, null);
        const desc = await _describeImage(buf);
        await updateContent(row.id, `[图片: ${desc}]`);
        console.log(`  ✅ Gemini Vision: ${desc.slice(0, 60)}`);
        return true;
    } catch (e) { console.log(`  ❌ ${e.message}`); return false; }
}

async function processFile(row) {
    let rawJson = {};
    try { rawJson = JSON.parse(row.raw_json || '{}'); } catch {}
    const filename = rawJson?.file?.filename || '未知文件';
    const ext      = (filename.split('.').pop() || '').toLowerCase();
    try {
        const buf = await _downloadFromGCS(row.id, 'file', row.msg_time, filename);
        if (pdfParse && ext === 'pdf') {
            const pdfData = await pdfParse(buf);
            const rawText = (pdfData.text || '').trim();
            if (rawText) {
                const summary = await _summarizeDocument(rawText, filename);
                await updateContent(row.id, `[文件: ${filename} | AI摘要: ${summary}]`);
                console.log(`  ✅ PDF摘要: ${summary.slice(0, 60)}`);
            } else {
                await updateContent(row.id, `[文件: ${filename}（扫描件/图片PDF）]`);
                console.log(`  ⚠️  PDF无文字（扫描件）`);
            }
        } else {
            await updateContent(row.id, `[客户发来文件：${filename}]`);
            console.log(`  ✅ 非PDF，存文件名`);
        }
        return true;
    } catch (e) { console.log(`  ❌ ${e.message}`); return false; }
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

async function main() {
    const types = TYPE_FILTER ? [TYPE_FILTER] : ['voice', 'image', 'file'];
    console.log(`\n🔧 模式: ${DRY_RUN ? 'DRY-RUN（只看不写）' : '写入'} | 处理类型: ${types.join(', ')}\n`);

    for (const msgtype of types) {
        const { rows } = await pool.query(
            `SELECT id, msgtype, msg_time, raw_json
             FROM wechat_archiver.messages
             WHERE msgtype = $1
               AND (content IS NULL OR content = '')
             ORDER BY msg_time ASC`,
            [msgtype]
        );
        console.log(`\n=== ${msgtype.toUpperCase()} (${rows.length} 条需补录) ===`);
        let ok = 0, fail = 0;
        for (const row of rows) {
            const t = new Date(row.msg_time).toLocaleString('zh-CN');
            process.stdout.write(`[${t}] id=${row.id.slice(0, 16)}... `);
            let success = false;
            if (msgtype === 'voice') success = await processVoice(row);
            if (msgtype === 'image') success = await processImage(row);
            if (msgtype === 'file')  success = await processFile(row);
            success ? ok++ : fail++;
        }
        console.log(`\n→ ${msgtype}: ✅ ${ok} 成功, ❌ ${fail} 失败`);
    }

    await pool.end();
    console.log('\n✅ 补录完成\n');
}

main().catch(e => { console.error(e.message); process.exit(1); });
