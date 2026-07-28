/**
 * 诊断 v5：全部用 CHATDATA_SECRET 的 token 调用 msgaudit 接口
 */
require('dotenv').config();
const axios = require('axios');

const CORP_ID         = process.env.WX_CORP_ID;
const AGENT_SECRET    = process.env.WX_AGENT_SECRET;
const CHATDATA_SECRET = process.env.WECOM_CHATDATA_SECRET;
const XIAOHAN_USERID  = 'JianKangXiaoHan';
const XIAOCHU_USERID  = 'JianKangXiaoChu';
const OSCAR_EXT_ID    = 'wm9xuHYgAA6TFURBHCp83TkkPgYatcmQ';

async function getToken(secret, label) {
    const { data } = await axios.get(
        `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${CORP_ID}&corpsecret=${secret}`
    );
    if (!data.access_token) throw new Error(`${label} token 失败: ${data.errmsg}`);
    console.log(`✅ ${label} token 获取成功`);
    return data.access_token;
}

async function main() {
    console.log('\n====== 存档范围诊断 v5 ======\n');
    const chatToken  = await getToken(CHATDATA_SECRET, '会话存档');
    const agentToken = await getToken(AGENT_SECRET,    '应用');

    // 1. get_permit_user_list（用会话存档 token）
    for (const type of [1, 2]) {
        const label = type === 1 ? '已确认存档员工' : '范围内未激活员工';
        const { data } = await axios.post(
            `https://qyapi.weixin.qq.com/cgi-bin/msgaudit/get_permit_user_list?access_token=${chatToken}`,
            { type }
        );
        if (data.errcode === 0) {
            console.log(`\n[type=${type}] ${label}: ${JSON.stringify(data.ids)}`);
        } else {
            console.log(`\n[type=${type}] ${label}: ❌ errcode=${data.errcode} ${data.errmsg}`);
        }
    }

    // 2. 小涵 ↔ oscar（用会话存档 token）
    console.log('\n--- 小涵 ↔ oscar ---');
    const { data: a1 } = await axios.post(
        `https://qyapi.weixin.qq.com/cgi-bin/msgaudit/check_single_agree?access_token=${chatToken}`,
        { info: [{ userid: XIAOHAN_USERID, exteranalopenid: OSCAR_EXT_ID }] }
    );
    console.log('chatToken 结果:', JSON.stringify(a1));

    // 3. 小楚 ↔ oscar（用会话存档 token）
    console.log('\n--- 小楚 ↔ oscar ---');
    const { data: a2 } = await axios.post(
        `https://qyapi.weixin.qq.com/cgi-bin/msgaudit/check_single_agree?access_token=${chatToken}`,
        { info: [{ userid: XIAOCHU_USERID, exteranalopenid: OSCAR_EXT_ID }] }
    );
    console.log('chatToken 结果:', JSON.stringify(a2));

    // 4. 用应用 token 再试一次（看看是否也能拿到 Disagree）
    console.log('\n--- 小涵 ↔ oscar (应用 token) ---');
    const { data: a3 } = await axios.post(
        `https://qyapi.weixin.qq.com/cgi-bin/msgaudit/check_single_agree?access_token=${agentToken}`,
        { info: [{ userid: XIAOHAN_USERID, exteranalopenid: OSCAR_EXT_ID }] }
    );
    console.log('agentToken 结果:', JSON.stringify(a3));

    console.log('\n====== 诊断完成 ======\n');
}

main().catch(e => {
    console.error('诊断异常:', e.response?.data || e.message);
    process.exit(1);
});
