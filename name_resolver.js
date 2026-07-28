/**
 * NameResolver - 将企微外部联系人 userID 解析为真实姓名
 * 带内存缓存，避免频繁调用 API
 */
const axios = require('axios');

const TOKEN_CACHE_TTL_MS  = 100 * 60 * 1000; // Token 缓存 100 分钟
const NAME_CACHE_TTL_MS   = 60  * 60 * 1000; // 姓名缓存 1 小时
const NAME_FAIL_CACHE_MS  = 5   * 60 * 1000; // 查询失败后缓存 5 分钟

class NameResolver {
    constructor() {
        this._token      = null;
        this._tokenExp   = 0;
        this._nameCache  = new Map(); // userId -> { displayName, wechatName, remark, expireAt }
    }

    // ──────────────────────────────────────────────
    // 内部：获取（带缓存的）Access Token
    // ──────────────────────────────────────────────
    async _getToken() {
        if (this._token && Date.now() < this._tokenExp) return this._token;

        const corpId = process.env.WX_CORP_ID;
        const secret = process.env.WX_AGENT_SECRET;
        if (!corpId || !secret) throw new Error('缺少 WX_CORP_ID 或 WX_AGENT_SECRET');

        const { data } = await axios.get(
            `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${secret}`
        );
        if (!data.access_token) throw new Error(`Token 获取失败: ${data.errmsg}`);

        this._token    = data.access_token;
        this._tokenExp = Date.now() + TOKEN_CACHE_TTL_MS;
        return this._token;
    }

    // ──────────────────────────────────────────────
    // 对外接口：解析一个 userID
    // 返回 { displayName, wechatName, remark, isEmployee }
    // ──────────────────────────────────────────────
    async resolve(userId) {
        if (!userId) return { displayName: 'unknown', wechatName: '', remark: '', isEmployee: false };

        // 命中缓存
        const cached = this._nameCache.get(userId);
        if (cached && Date.now() < cached.expireAt) return cached;

        // 企微内部员工 ID 不以 wm/wo 开头，尝试调用 user/get 获取姓名
        if (!userId.startsWith('wm') && !userId.startsWith('wo')) {
            try {
                const token = await this._getToken();
                const { data } = await axios.get(
                    `https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=${token}&userid=${userId}`
                );
                if (data.errcode === 0) {
                    const result = {
                        displayName: data.name || userId,
                        wechatName:  data.name || userId,
                        remark:      '',
                        isEmployee:  true,
                        expireAt:    Date.now() + NAME_CACHE_TTL_MS,
                    };
                    this._nameCache.set(userId, result);
                    return result;
                }
            } catch (e) { /* 权限不足时静默回退 */ }
            // 权限不足或查询失败，直接用 userId
            const result = { displayName: userId, wechatName: userId, remark: '', isEmployee: true };
            this._nameCache.set(userId, { ...result, expireAt: Date.now() + NAME_CACHE_TTL_MS });
            return result;
        }

        // 调用外部联系人 API
        try {
            const token = await this._getToken();
            const { data } = await axios.get(
                `https://qyapi.weixin.qq.com/cgi-bin/externalcontact/get?access_token=${token}&external_userid=${userId}`
            );

            if (data.errcode === 0) {
                const contact = data.external_contact;
                const remark  = data.follow_user?.[0]?.remark || '';
                const result  = {
                    displayName: remark || contact.name,
                    wechatName:  contact.name,
                    remark,
                    isEmployee:  false,
                    expireAt:    Date.now() + NAME_CACHE_TTL_MS,
                };
                this._nameCache.set(userId, result);
                return result;
            }

            // 查询失败（如 60020 IP 拦截）- 短暂缓存，用 userId 兜底
            const fallback = { displayName: userId, wechatName: '', remark: '', isEmployee: false, errorCode: data.errcode };
            this._nameCache.set(userId, { ...fallback, expireAt: Date.now() + NAME_FAIL_CACHE_MS });
            log('WARNING', 'name_resolve_fail', { userId, errcode: data.errcode, errmsg: data.errmsg });
            return fallback;

        } catch (err) {
            log('ERROR', 'name_resolve_exception', { userId, message: err.message });
            return { displayName: userId, wechatName: '', remark: '', isEmployee: false };
        }
    }
}

// 小工具：统一结构化日志
function log(severity, type, extra = {}) {
    console.log(JSON.stringify({ severity, type, ...extra, ts: new Date().toISOString() }));
}

module.exports = NameResolver;
