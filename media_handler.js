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
let pdfParse; // 懒加载，避免启动时报错
try { 
    const mod = require('pdf-parse');
    pdfParse = typeof mod === 'function' ? mod : (mod.PDFParse || mod.default);
} catch(e) { /* pdf-parse 未安装，降级 */ }
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

async function _describeImage(buffer, gcsUrl) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return '[图片]';

    try {
        const ai = new GoogleGenAI({ apiKey });

        let part;
        if (buffer.length <= INLINE_MAX_BYTES) {
            part = { inlineData: { mimeType: 'image/jpeg', data: buffer.toString('base64') } };
        } else {
            _log('image_use_url', { sizeKB: Math.round(buffer.length / 1024), gcsUrl });
            part = { fileData: { mimeType: 'image/jpeg', fileUri: gcsUrl } };
        }

        // ── 第一步：判断图片类型 ──────────────────────────────────────────────
        const classifyResp = await ai.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: [{
                parts: [
                    { text: '这张图片属于哪种类型？只回答一个词：文档、报告、截图、照片。（文档=合同/证件/表格，报告=检验/化验/检查报告，截图=手机/电脑截图含文字，照片=人物/风景/产品等）' },
                    part,
                ],
            }],
        });
        const imgType = (classifyResp.text || '').trim();
        _log('image_classify', { type: imgType, sizeKB: Math.round(buffer.length / 1024) });

        // ── 第二步：根据类型选择不同处理策略 ────────────────────────────────
        const isTextHeavy = /文档|报告|截图/.test(imgType);

        let prompt;
        if (isTextHeavy) {
            // 文字密集型：全量 OCR，保留所有数值和结构
            prompt = `请对这张图片做完整的文字识别（OCR），提取所有可见的文字内容。
要求：
1. 逐行保留所有数字、指标名称、参考范围、单位
2. 保留表格结构（用竖线分隔列）
3. 保留所有标注（如箭头↑↓、H/L标记）
4. 不要总结，不要省略，原样输出所有文字
格式：[图片内容:\n（完整OCR文字）]`;
        } else {
            // 普通图片：简洁描述
            prompt = '请用1-3句话描述这张图片的主要内容（直接描述，不要解释）：';
        }

        const resp = await ai.models.generateContent({
            model: 'gemini-2.5-flash',   // 文字类用更强的模型
            contents: [{
                parts: [
                    { text: prompt },
                    part,
                ],
            }],
            config: isTextHeavy ? { thinkingConfig: { thinkingBudget: 0 } } : undefined,
        });

        const text = (resp.text || '').trim() || '[图片]';
        if (isTextHeavy) {
            // 包装成统一格式
            return text.startsWith('[图片') ? text : `[图片内容:\n${text}]`;
        }
        return `[图片: ${text}]`;

    } catch (e) {
        _log('vision_error', { message: e.message });
        return '[图片]';
    }
}

// ─── Gemini 文档摘要 ─────────────────────────────────────────────────────────

async function _summarizeDocument(text, filename) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return text.slice(0, 300);
    try {
        const ai = new GoogleGenAI({ apiKey });
        const resp = await ai.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: [{ parts: [{ text:
                `请用2-3句话简洁概括以下文档的主要内容（文件名：${filename}），直接输出摘要，不要解释：\n\n${text.slice(0, 4000)}`
            }] }],
        });
        return (resp.text || '').trim() || text.slice(0, 300);
    } catch (e) {
        _log('summarize_error', { message: e.message });
        return text.slice(0, 300);
    }
}

// ─── Gemini Vision OCR：扫描件/图片 PDF ─────────────────────────────────────
// Gemini 2.5 Flash 原生支持 PDF，可直接 base64 发送识别

async function _ocrPdfWithGemini(buffer, gcsUrl, filename) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    try {
        const ai = new GoogleGenAI({ apiKey });

        let pdfPart;
        if (buffer.length <= INLINE_MAX_BYTES) {
            // 小文件（≤14MB）：base64 直接内嵌
            pdfPart = { inlineData: { mimeType: 'application/pdf', data: buffer.toString('base64') } };
        } else {
            // 大文件：用 GCS URI
            _log('pdf_ocr_use_url', { sizeKB: Math.round(buffer.length / 1024), gcsUrl });
            pdfPart = { fileData: { mimeType: 'application/pdf', fileUri: gcsUrl } };
        }

        const resp = await ai.models.generateContent({
            model: 'gemini-2.5-flash',   // flash-lite 对多页 PDF 可能力度不够
            contents: [{
                parts: [
                    { text: `请仔细阅读这份PDF文档（文件名：${filename}），用3-5句话概括主要内容和关键数据指标（如有异常值请特别指出），直接输出摘要，不要解释：` },
                    pdfPart,
                ],
            }],
        });
        const summary = (resp.text || '').trim();
        _log('pdf_ocr_success', { filename, summaryLen: summary.length, preview: summary.slice(0, 80) });
        return summary || null;
    } catch (e) {
        _log('pdf_ocr_error', { message: e.message, filename });
        return null;
    }
}

// ─── 火山引擎大模型 ASR（首选，速度快准确率高）──────────────────────────────

async function _transcribeWithVolcano(buffer) {
    const appKey    = process.env.VOLCANO_APP_KEY;
    const accessKey = process.env.VOLCANO_ACCESS_KEY;
    const apiUrl    = process.env.VOLCANO_API_URL
        || 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';

    if (!appKey || !accessKey) return null;

    const t0 = Date.now();
    const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
        const https = require('https');
        const body = JSON.stringify({
            user:    { uid: appKey },
            audio:   { data: buffer.toString('base64'), format: 'amr' },
            request: { model_name: 'bigmodel' },
        });
        const url = new URL(apiUrl);

        const transcript = await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: url.hostname,
                path:     url.pathname,
                method:   'POST',
                timeout:  12000,
                headers: {
                    'Content-Type':      'application/json',
                    'Content-Length':    Buffer.byteLength(body),
                    'X-Api-App-Key':     appKey,
                    'X-Api-Access-Key':  accessKey,
                    'X-Api-Resource-Id': 'volc.bigasr.auc_turbo',
                    'X-Api-Request-Id':  reqId,
                    'X-Api-Sequence':    '-1',
                },
            }, res => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    const statusCode = res.headers['x-api-status-code'];
                    if (statusCode === '20000000' || res.statusCode === 200) {
                        try {
                            const j = JSON.parse(data);
                            resolve(j?.result?.text?.trim() || '');
                        } catch { resolve(''); }
                    } else if (statusCode === '20000003') {
                        resolve('(静音)');
                    } else {
                        reject(new Error(`volcano status=${statusCode} msg=${res.headers['x-api-message']}`));
                    }
                });
            });
            req.on('error',   reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('volcano timeout')); });
            req.write(body);
            req.end();
        });

        if (transcript) {
            _log('stt_success', { engine: 'volcano', ms: Date.now()-t0, chars: transcript.length, preview: transcript.substring(0, 50) });
            return transcript;
        }
        _log('stt_empty', { engine: 'volcano', reason: '转写结果为空' });
        return null;
    } catch (e) {
        _log('stt_error', { engine: 'volcano', message: e.message, ms: Date.now()-t0 });
        return null;
    }
}

// ─── Gemini 语音转文字（备用 fallback）───────────────────────────────────────

async function _transcribeWithGemini(buffer) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;

    try {
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
            _log('stt_empty', { engine: 'gemini', reason: '转写结果为空' });
            return null;
        }
        _log('stt_success', { engine: 'gemini', chars: transcript.length, preview: transcript.substring(0, 50) });
        return transcript;
    } catch (e) {
        _log('stt_error', { engine: 'gemini', message: e.message });
        return null;
    }
}

// ─── 统一 STT 入口：火山首选 → Gemini 备用 ───────────────────────────────────

async function _transcribeAudio(buffer) {
    // 1. 火山大模型 ASR（速度快、中文准确率高）
    const volcResult = await _transcribeWithVolcano(buffer);
    if (volcResult) return volcResult;

    // 2. Gemini fallback
    _log('stt_fallback_to_gemini', { reason: '火山ASR未返回结果，尝试Gemini' });
    return await _transcribeWithGemini(buffer);
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
            const filename = msg.file?.filename || '未知文件';
            const ext = (filename.split('.').pop() || '').toLowerCase();
            if (ext === 'pdf') {
                try {
                    // 第一步：用 pdf-parse 提取文字层（文字型 PDF，速度快）
                    let rawText = '';
                    if (pdfParse) {
                        try {
                            const pdfData = await pdfParse(buffer);
                            rawText = (pdfData.text || '').trim();
                        } catch (parseErr) {
                            _log('pdf_parse_error', { message: parseErr.message, filename });
                        }
                    }

                    if (rawText) {
                        // 文字型 PDF：直接文本摘要
                        const summary = await _summarizeDocument(rawText, filename);
                        content = `[文件: ${filename} | AI摘要: ${summary}]`;
                        _log('pdf_extracted', { filename, chars: rawText.length, summaryLen: summary.length });
                    } else {
                        // 扫描件/图片 PDF：Gemini Vision OCR 兜底
                        _log('pdf_no_text_try_ocr', { filename, reason: '无文字层，尝试 Gemini Vision OCR' });
                        const ocrSummary = await _ocrPdfWithGemini(buffer, mediaUrl, filename);
                        if (ocrSummary) {
                            content = `[文件: ${filename} | AI摘要: ${ocrSummary}]`;
                            _log('pdf_ocr_done', { filename });
                        } else {
                            content = `[文件: ${filename}（扫描件，OCR 未能提取内容）]`;
                            _log('pdf_ocr_fallback', { filename });
                        }
                    }
                } catch (e) {
                    _log('pdf_handle_error', { message: e.message, filename });
                    content = `[文件: ${filename}（PDF处理失败）]`;
                }
            } else {
                // 非 PDF：存文件名，供 agent 了解有文件存在
                content = `[客户发来文件：${filename}]`;
            }

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

// ─── 拍照识餐：豆包 Vision (食材解构) + DeepSeek V4 Flash (代谢测算) ────────────

async function _analyzeMealWithDoubaoAndDeepseek(buffer, meta = {}) {
    const arkKey = process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY;
    const arkBase = process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
    const axios = require('axios');

    if (!arkKey) {
        _log('meal_analyze_no_key', { reason: '未配置 ARK_API_KEY/DOUBAO_API_KEY，降级至 Gemini 描述' });
        const desc = await _describeImage(buffer, null);
        return `[餐食: ${desc}]`;
    }

    try {
        const base64Img = buffer.toString('base64');

        // 步骤 1：调用多模态模型解构食材
        const visionModel = process.env.DOUBAO_VISION_MODEL || process.env.ARK_MODEL || 'deepseek-v4-flash-ga-260731';
        const visionResp = await axios.post(
            `${arkBase}/chat/completions`,
            {
                model: visionModel,
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: '你是资深中式食材解构师。请识别图片中的全部菜品与主食，只输出观察事实，以纯 JSON 格式输出：\n{\n  "dish_name": "主要菜品名称",\n  "cooking_method": "烹饪方式(如清蒸/少油炒/红烧/油炸)",\n  "ingredients": [\n    { "name": "食材名称", "weight_g": 预估熟重克数 }\n  ],\n  "notes": "口味特征(如清淡/多油/高钠/加糖)"\n}\n只输出纯 JSON，严禁任何额外文本或 Markdown 标记。',
                            },
                            {
                                type: 'image_url',
                                image_url: { url: `data:image/jpeg;base64,${base64Img}` },
                            },
                        ],
                    },
                ],
                temperature: 0.1,
            },
            {
                headers: {
                    'Authorization': `Bearer ${arkKey}`,
                    'Content-Type': 'application/json',
                },
                timeout: 25000,
            }
        );

        let visionJsonStr = visionResp.data?.choices?.[0]?.message?.content || '{}';
        visionJsonStr = visionJsonStr.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
        let mealFacts = {};
        try { mealFacts = JSON.parse(visionJsonStr); } catch (e) { mealFacts = { raw: visionJsonStr }; }
        _log('meal_vision_deconstructed', { dishName: mealFacts.dish_name });

        // 步骤 2：DeepSeek V4 Flash 严密测算代谢与生成医嘱
        const patientContext = meta.patientProfile || meta.memberName || '康复期患者';
        const calcResp = await axios.post(
            `${arkBase}/chat/completions`,
            {
                model: process.env.ARK_MODEL || 'deepseek-v4-flash-ga-260731',
                messages: [
                    {
                        role: 'system',
                        content: '你是一名资深临床营养与代谢专家。请依据《中国食物成分表》对输入的食材明细做严密换算，并结合患者情况输出医嘱。',
                    },
                    {
                        role: 'user',
                        content: `【食材实测事实】：\n${JSON.stringify(mealFacts, null, 2)}\n\n【患者档案画像】：\n${patientContext}\n\n请输出纯 JSON：\n{\n  "calories": 总热量kcal(整数),\n  "protein_g": 蛋白质g(保留1位小数),\n  "carbs_g": 碳水g(保留1位小数),\n  "fat_g": 脂肪g(保留1位小数),\n  "sodium_mg": 预估钠mg(整数),\n  "clinical_advice": "针对该患者处境的1句简短医嘱点睛",\n  "suggested_questions": ["针对这餐的追问1", "追问2"]\n}\n只输出纯 JSON。`,
                    },
                ],
                temperature: 0.2,
            },
            {
                headers: {
                    'Authorization': `Bearer ${arkKey}`,
                    'Content-Type': 'application/json',
                },
                timeout: 20000,
            }
        );

        let calcJsonStr = calcResp.data?.choices?.[0]?.message?.content || '{}';
        calcJsonStr = calcJsonStr.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
        let calcData = {};
        try { calcData = JSON.parse(calcJsonStr); } catch (e) { calcData = {}; }

        // 若提供了 memberId，自动将打卡数据沉淀至 mini_health.records
        if (meta.memberId) {
            try {
                const { saveRecord } = require('./supabase_store');
                await saveRecord({
                    memberId: meta.memberId,
                    recordType: 'meal',
                    metrics: {
                        dish_name: mealFacts.dish_name || '餐食记录',
                        ingredients: mealFacts.ingredients || [],
                        ...calcData,
                    },
                    sourceMsgId: meta.sourceMsgId || null,
                });
                _log('meal_record_saved', { memberId: meta.memberId, calories: calcData.calories });
            } catch (recErr) {
                _log('meal_record_save_warn', { error: recErr.message });
            }
        }

        const dishName = mealFacts.dish_name || '中餐记录';
        const cal = calcData.calories ? `${calcData.calories} kcal` : '已估算';
        const pro = calcData.protein_g ? `${calcData.protein_g}g` : '充沛';
        const advice = calcData.clinical_advice || '膳食均衡，有助康复';

        return `[餐食打卡: ${dishName} | 摄入热量: ${cal} | 优质蛋白: ${pro} | 营养点睛: ${advice}]`;

    } catch (err) {
        _log('meal_dual_engine_error', { error: err.message, reason: '双核识餐异常，降级至 Gemini 描述' });
        const desc = await _describeImage(buffer, null);
        return `[餐食图片: ${desc}]`;
    }
}

/**
 * 直接处理内存 Buffer 媒体（供 MiniHealth HTTP 网关调用）
 */
async function handleDirectMedia(params) {
    const { buffer, msgtype, filename = '', msgid = Date.now().toString(), meta = {} } = params;
    if (!buffer || buffer.length === 0) {
        return { content: `[${msgtype}: 文件为空]`, mediaUrl: null };
    }

    let mediaUrl = null;
    const extMap  = { image: 'jpg', voice: 'amr', video: 'mp4', meal: 'jpg', report: 'jpg' };
    const ctMap   = { image: 'image/jpeg', voice: 'audio/amr', video: 'video/mp4', file: 'application/octet-stream', meal: 'image/jpeg', report: 'image/jpeg' };
    const ext     = extMap[msgtype] || (filename.split('.').pop() || 'bin');
    const ct      = ctMap[msgtype]  || 'application/octet-stream';
    const dateStr = new Date().toISOString().slice(0, 10);
    const gcsName = `${dateStr}/${msgid}.${ext}`;

    try {
        mediaUrl = await _uploadToGCS(buffer, gcsName, ct);
        _log('direct_media_uploaded', { msgtype, sizeKB: Math.round(buffer.length / 1024), mediaUrl });
    } catch (uploadErr) {
        _log('direct_media_upload_warn', { error: uploadErr.message });
    }

    let content = '';

    if (msgtype === 'voice') {
        const transcript = await _transcribeAudio(buffer);
        content = transcript
            ? `[语音转文字]: ${transcript}`
            : '[客户发来语音消息，请回复引导其用文字说明需求]';

    } else if (msgtype === 'meal') {
        content = await _analyzeMealWithDoubaoAndDeepseek(buffer, { ...meta, msgId: msgid });

    } else if (msgtype === 'report' || msgtype === 'image') {
        const desc = await _describeImage(buffer, mediaUrl);
        content = desc.startsWith('[图片') ? desc : `[图片: ${desc}]`;

    } else if (msgtype === 'file') {
        const fileExt = (filename.split('.').pop() || '').toLowerCase();
        if (fileExt === 'pdf') {
            try {
                let rawText = '';
                if (pdfParse) {
                    try {
                        const pdfData = await pdfParse(buffer);
                        rawText = (pdfData.text || '').trim();
                    } catch (e) { /* ignore */ }
                }
                if (rawText) {
                    const summary = await _summarizeDocument(rawText, filename);
                    content = `[文件: ${filename} | AI摘要: ${summary}]`;
                } else {
                    const ocrSummary = await _ocrPdfWithGemini(buffer, mediaUrl, filename);
                    content = ocrSummary
                        ? `[文件: ${filename} | AI摘要: ${ocrSummary}]`
                        : `[文件: ${filename}（扫描件，OCR 未能提取内容）]`;
                }
            } catch (e) {
                content = `[文件: ${filename}（处理失败）]`;
            }
        } else {
            content = `[客户发来文件：${filename}]`;
        }
    } else {
        content = `[${msgtype}]`;
    }

    return { content, mediaUrl };
}

module.exports = {
    handleMedia,
    handleDirectMedia,
    _transcribeAudio,
    _describeImage,
    _analyzeMealWithDoubaoAndDeepseek,
};

