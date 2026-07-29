/**
 * media_handler.js
 *
 * 下载企微存档媒体文件，生成可供 Agent 理解的文字内容。
 *
 * ─── 处理策略 ───────────────────────────────────────────────────────────────
 *  图片：SDK 下载 → GCS 存档 → Gemini Vision 生成描述（inline base64，< 15MB）
 *        超过 15MB 则用 GCS URL 引用（Gemini Files API）
 *  语音：SDK 下载 AMR → Google Cloud Speech-to-Text 转文字 → 文字传给 Agent
 *  视频：存 GCS，暂不转写（告知 Agent 有视频）
 *  文件：存 GCS，传文件名给 Agent
 *
 * ─── CUA 接口影响 ────────────────────────────────────────────────────────────
 *  无需改动 CUA 接口，所有媒体最终都转成 content 字符串传入：
 *    图片 → "[图片: 一张显示产品价格499元的截图，背景是白色...]"
 *    语音 → "[语音转文字]: 你们下午几点开门？"
 *    视频 → "[视频消息，时长约XX秒]"
 *    文件 → "[文件: 产品报价单.xlsx]"
 */

const { Storage }     = require('@google-cloud/storage');
const { GoogleGenAI } = require('@google/genai');
// const speech       = require('@google-cloud/speech');  // 已改用 Gemini 转写

const MEDIA_BUCKET    = process.env.MEDIA_BUCKET || 'wechat-archiver-media';
const INLINE_MAX_BYTES = 14 * 1024 * 1024; // 14MB：低于 Gemini 15MB 限制

// 懒加载客户端（Cloud Run 中 ADC 自动生效）
// Cloud STT 已弃用，改用 Gemini 转写

function _log(type, extra = {}) {
    console.log(JSON.stringify({ severity: 'INFO', type, ...extra, ts: new Date().toISOString() }));
}

// ─── 企微 SDK 分片下载 ────────────────────────────────────────────────────────

function _downloadFromSdk(sdk, sdkfileid) {
    const chunks = [];
    let params = { sdk_fileid: sdkfileid, index_buf: '' };  // 注意：是 sdk_fileid 不是 sdkfileid

    for (let i = 0; i < 200; i++) {
        const resp = sdk.getMediaData(params);
        if (resp && resp.data) {
            chunks.push(Buffer.from(resp.data));
        }
        if (!resp || resp.is_finished) break;
        params.index_buf = resp.buf_index || '';
    }

    return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
}

// ─── GCS 上传（公开读，用于存档） ────────────────────────────────────────────

async function _uploadToGCS(buffer, filename, contentType) {
    const storage = new Storage();
    const file = storage.bucket(MEDIA_BUCKET).file(filename);
    await file.save(buffer, { contentType, resumable: false });
    return `https://storage.googleapis.com/${MEDIA_BUCKET}/${filename}`;
}

// ─── Gemini Vision 图片描述 ───────────────────────────────────────────────────

async function _describeImage(buffer, gcsUrl) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return '[图片]';

    try {
        const ai = new GoogleGenAI({ apiKey });

        let part;
        if (buffer.length <= INLINE_MAX_BYTES) {
            // 小图：base64 直接内嵌
            part = { inlineData: { mimeType: 'image/jpeg', data: buffer.toString('base64') } };
        } else {
            // 大图（> 14MB）：用 GCS 公开 URL 引用
            _log('image_use_url', { sizeKB: Math.round(buffer.length / 1024), gcsUrl });
            part = { fileData: { mimeType: 'image/jpeg', fileUri: gcsUrl } };
        }

        const resp = await ai.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: [{
                parts: [
                    { text: '请用1-2句话简洁描述这张图片的主要内容（直接描述，不要解释）：' },
                    part,
                ],
            }],
        });
        return (resp.text || '').trim() || '[图片]';
    } catch (e) {
        _log('vision_error', { message: e.message });
        return '[图片]';
    }
}

// ─── Gemini 语音转文字（替代 Cloud STT，更可靠） ──────────────────────────────

async function _transcribeAudio(buffer) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        _log('stt_error', { message: 'GEMINI_API_KEY not set' });
        return null;
    }

    try {
        const { GoogleGenAI } = require('@google/genai');
        const ai = new GoogleGenAI({ apiKey });

        const resp = await ai.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: [{
                parts: [
                    { text: '请将这段语音转写为文字，只输出转写内容，不要加任何解释或标点说明：' },
                    { inlineData: { mimeType: 'audio/amr', data: buffer.toString('base64') } },
                ],
            }],
        });

        const transcript = (resp.text || '').trim();
        if (!transcript) {
            _log('stt_empty', { reason: 'Gemini 转写结果为空' });
            return null;
        }

        _log('stt_success', { engine: 'gemini', chars: transcript.length, preview: transcript.substring(0, 50) });
        return transcript;
    } catch (e) {
        _log('stt_error', { engine: 'gemini', message: e.message });
        return null;
    }
}

// ─── 对外接口 ─────────────────────────────────────────────────────────────────

/**
 * 处理一条媒体消息：SDK 下载 → GCS 存档 → 生成 Agent 可理解的文字
 *
 * @param {object} sdk  - WeWorkChat SDK 实例
 * @param {object} msg  - 原始消息对象
 * @returns {{ content: string, mediaUrl: string|null }}
 *   content  - 传给 CUA ingest 的文字内容（Agent 将看到此内容）
 *   mediaUrl - GCS 存档 URL（可为 null）
 */
async function handleMedia(sdk, msg) {
    // ── 优先使用企微自带 ASR 转写（voiceto_text），无需下载 ──────────────
    if (msg.msgtype === 'voice' && msg.voice?.voiceto_text) {
        const vtt = msg.voice.voiceto_text;
        _log('voice_vtt_used', { chars: vtt.length, preview: vtt.substring(0, 50) });
        return { content: `[语音转文字]: ${vtt}`, mediaUrl: null };
    }

    const sdkfileid = msg.image?.sdkfileid
        || msg.voice?.sdkfileid
        || msg.video?.sdkfileid
        || msg.file?.sdkfileid;

    if (!sdkfileid) {
        return { content: `[${msg.msgtype || '消息'}]`, mediaUrl: null };
    }

    _log('media_download_start', {
        msgtype:   msg.msgtype,
        msgidPfx:  (msg.msgid || '').substring(0, 20),
    });

    try {
        const buffer = _downloadFromSdk(sdk, sdkfileid);
        if (buffer.length === 0) {
            return { content: `[${msg.msgtype}: 文件为空]`, mediaUrl: null };
        }

        // 上传到 GCS（存档）
        const extMap  = { image: 'jpg', voice: 'amr', video: 'mp4' };
        const ctMap   = { image: 'image/jpeg', voice: 'audio/amr', video: 'video/mp4', file: 'application/octet-stream' };
        const ext     = extMap[msg.msgtype] || (msg.file?.filename?.split('.').pop() || 'bin');
        const ct      = ctMap[msg.msgtype]  || 'application/octet-stream';
        const dateStr = new Date().toISOString().slice(0, 10);
        const gcsName = `${dateStr}/${msg.msgid || Date.now()}.${ext}`;
        const mediaUrl = await _uploadToGCS(buffer, gcsName, ct);

        _log('media_uploaded', {
            msgtype: msg.msgtype,
            sizeKB:  Math.round(buffer.length / 1024),
            mediaUrl,
        });

        // 生成 Agent 可理解的文字内容
        let content;

        if (msg.msgtype === 'image') {
            const desc = await _describeImage(buffer, mediaUrl);
            content = `[图片: ${desc}]`;

        } else if (msg.msgtype === 'voice') {
            // STT 转写（云端 STT 路径）
            const transcript = await _transcribeAudio(buffer);
            if (transcript) {
                content = `[语音转文字]: ${transcript}`;
                _log('stt_success', { chars: transcript.length, preview: transcript.substring(0, 50) });
            } else {
                // STT 失败降级：引导用户文字输入，不暴露系统错误
                content = '[客户发来语音消息，请回复引导其用文字说明需求]';
                _log('stt_fallback', {});
            }

        } else if (msg.msgtype === 'video') {
            content = '[客户发来一段视频，请回复：收到视频，请问有什么可以帮您？]';

        } else if (msg.msgtype === 'file') {
            content = `[客户发来文件：${msg.file?.filename || '未知文件'}]`;

        } else {
            content = `[${msg.msgtype}]`;
        }

        return { content, mediaUrl };

    } catch (e) {
        _log('media_error', { message: e.message, msgtype: msg.msgtype });
        // 语音下载/转写失败：给友好引导语，不暴露系统错误给 Agent
        if (msg.msgtype === 'voice') {
            return { content: '[客户发来语音消息，请回复引导其用文字说明需求]', mediaUrl: null };
        }
        return { content: `[${msg.msgtype}: 处理失败]`, mediaUrl: null };
    }
}

module.exports = { handleMedia };
