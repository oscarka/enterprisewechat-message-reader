/**
 * SeqStore - 将拉取进度 (seq) 持久化到 Google Cloud Storage
 * Cloud Run 重启后可从上次断点继续，不会重复处理
 */
const { Storage } = require('@google-cloud/storage');

const DEFAULT_SEQ   = parseInt(process.env.START_SEQ   || '6047', 10);
const BUCKET_NAME   = process.env.STATE_BUCKET || 'wechat-archiver-state';
const SEQ_FILE_NAME = 'archiver_seq.json';

function log(severity, type, extra = {}) {
    console.log(JSON.stringify({ severity, type, ...extra, ts: new Date().toISOString() }));
}

class SeqStore {
    constructor() {
        this._storage    = new Storage();
        this._bucket     = this._storage.bucket(BUCKET_NAME);
        this._file       = this._bucket.file(SEQ_FILE_NAME);
        this._localSeq   = DEFAULT_SEQ; // 内存兜底
    }

    // 启动时加载 seq（优先 GCS，失败则用 DEFAULT_SEQ）
    async load() {
        try {
            const [exists] = await this._file.exists();
            if (!exists) {
                log('INFO', 'seq_store', { message: `GCS 无进度文件，从默认 seq=${DEFAULT_SEQ} 开始` });
                return DEFAULT_SEQ;
            }
            const [content] = await this._file.download();
            const data = JSON.parse(content.toString());
            this._localSeq = data.seq || DEFAULT_SEQ;
            log('INFO', 'seq_store', { message: `从 GCS 恢复 seq=${this._localSeq}`, updatedAt: data.updated_at });
            return this._localSeq;
        } catch (err) {
            log('WARNING', 'seq_store', { message: `GCS 读取失败，使用默认 seq=${DEFAULT_SEQ}`, error: err.message });
            return DEFAULT_SEQ;
        }
    }

    // 每批消息处理完后保存 seq（同步写本地 + 异步写 GCS）
    async save(seq) {
        this._localSeq = seq;
        try {
            await this._file.save(
                JSON.stringify({ seq, updated_at: new Date().toISOString() }),
                { contentType: 'application/json' }
            );
        } catch (err) {
            // GCS 写失败不致命，下次重启最多从 localSeq 或 DEFAULT_SEQ 恢复
            log('WARNING', 'seq_store', { message: `GCS 写入失败: ${err.message}` });
        }
    }

    // 当前内存中的 seq（用于日志）
    get current() { return this._localSeq; }
}

module.exports = SeqStore;
