# CUA Console — Ingest API 接口文档

**版本**: v1  
**基础地址**: `https://<your-tunnel>.trycloudflare.com` 或 `http://<tailscale-ip>:8080`  
**后端直连**: `http://<tailscale-ip>:8765`

> 📌 **本副本已包含企微存档服务（wechat-archiver）集成说明**，  
> 新增字段：`meta.recipient`、`meta.employee`、`meta.channel`、`history`。  
> CUA 侧需要按照文末「**变更请求**」小节支持动态 recipient 路由。

---

## 概述

Ingest API 是 CUA Console 的**消息输入层**，负责接收来自各渠道的消息，
转发给 Agent（豆包/自定义 Agent）处理，再由 CUA 自动发送回复。

```
外部渠道 → POST /api/ingest → Agent 处理 → CUA 在 Mac 上操作界面 → 消息发出
```

支持任意来源，通过 `source` 字段区分渠道，`meta` 携带来源元数据。

---

## 端点列表

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/ingest` | **主接入端点**，接收任意来源消息 |
| `POST` | `/api/ingest/mock/{case_name}` | 触发预设测试案例 |
| `GET` | `/api/ingest/cases` | 列出所有可用测试案例 |
| `GET` | `/api/status` | 查询服务状态 |

---

## POST /api/ingest

接收外部消息并启动完整处理流程（Agent 回复 → CUA 发送）。

### 请求

**Headers**
```
Content-Type: application/json
```

**Body**

```json
{
  "content":    "string（必填）消息内容",
  "source":     "string（必填）来源标识，见下方来源类型表",
  "session_id": "string（可选）会话ID，默认 default",
  "meta":       "object（可选）来源元数据，见下方字段说明"
}
```

**`source` 来源类型**

| 值 | 说明 |
|----|------|
| `wecom` | 企业微信 |
| `wechat` | 个人微信 |
| `webhook` | 通用外部 Webhook |
| `system` | 系统触发（自动跟进等） |
| `ui` | 控制台手动输入 |

**`meta` 字段说明**（可自由扩展）

| 字段 | 类型 | 说明 |
|------|------|------|
| `from_name` | string | 发件人名称（如 "oscar"）|
| `company` | string | 发件人所在公司 |
| `channel` | string | 子渠道标识（如 `"wecom_archive"`）|
| `user_id` | string | 用户唯一 ID（企微 external_userid）|
| `priority` | string | 优先级 `high/normal/low` |
| `trigger` | string | 触发原因（系统消息用）|
| `recipient` | string | ⭐ **[新增]** CUA 应回复给谁（取代 .env 固定值），见文末变更请求 |
| `app` | string | ⭐ **[新增]** 回复所用 App（如 `"企业微信"`），见文末变更请求 |
| `employee` | string | ⭐ **[新增]** 对话员工账号名（如 `"张小帆"`），CUA 可据此切换账号 |

### 请求示例

**企业微信客户咨询（通用示例）**
```bash
curl -X POST https://your-tunnel.trycloudflare.com/api/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "content": "你好，我想了解你们产品的定价",
    "source": "wecom",
    "meta": {
      "from_name": "张三",
      "company": "XX科技",
      "user_id": "wecom_u_12345"
    }
  }'
```

**⭐ 企微存档服务实际发出的请求格式（wechat-archiver 生产环境）**
```bash
curl -X POST https://your-tunnel.trycloudflare.com/api/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "content": "你们服务几点开始？",
    "source": "wecom",
    "session_id": "wm9xuHYgAA6TFURBHCp83TkkPgYatcmQ",
    "meta": {
      "from_name": "oscar",
      "user_id": "wm9xuHYgAA6TFURBHCp83TkkPgYatcmQ",
      "recipient": "oscar",
      "app": "企业微信",
      "employee": "张小帆",
      "channel": "wecom_archive"
    },
    "history": [
      { "role": "user",      "content": "你们是做什么的" },
      { "role": "assistant", "content": "我们是..." }
    ]
  }'
```

> 说明：
> - `session_id` = 外部联系人的企微 ID（`wm...` 开头），每个客户唯一，保持对话独立
> - `meta.recipient` = 客户微信名称，CUA 需要打开这个人的对话窗口回复
> - `meta.employee` = 哪个员工账号正在对话（供 CUA 切换账号）
> - `history` = 从 Supabase `wechat_archiver.messages` 查询的最近 20 条对话记录

**个人微信**
```bash
curl -X POST https://your-tunnel.trycloudflare.com/api/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "content": "有代理合作政策吗？",
    "source": "wechat",
    "meta": {
      "from_name": "王五",
      "channel": "朋友圈引流"
    }
  }'
```

**系统自动触发**
```bash
curl -X POST https://your-tunnel.trycloudflare.com/api/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "content": "请对客户张三做一个24小时跟进回复",
    "source": "system",
    "meta": {
      "trigger": "auto_followup",
      "user_id": "wecom_u_12345",
      "priority": "high"
    }
  }'
```

---

### 响应

返回 **Server-Sent Events（SSE）** 流，`Content-Type: text/event-stream`。

每条事件格式：
```
data: {json_object}\n\n
```

**事件类型总览**

| `type` | 阶段 | 说明 |
|--------|------|------|
| `task_start` | 开始 | 任务创建，包含 task_id |
| `phase` | 切换 | 阶段变化（thinking / executing）|
| `text` | thinking | Agent 生成回复的文字片段（流式） |
| `agent_reply_ready` | thinking→executing | Agent 回复完成，含完整 reply 和 delivery 指令 |
| `tool_call` | executing | CUA 调用了某个工具 |
| `tool_result` | executing | 工具调用返回结果 |
| `task_done` | 结束 | 任务完成，消息已发送 |
| `task_failed` | 结束 | 任务失败，含 error 原因 |
| `error` | 任意 | 局部错误（不一定终止任务）|
| `stream_end` | 结束 | SSE 流关闭标记 |

**事件详细结构**

```jsonc
// task_start
{ "type": "task_start", "task_id": "abc12345", "source": "wecom", "content": "你好..." }

// phase
{ "type": "phase", "phase": "thinking", "task_id": "abc12345" }

// text（Agent 流式输出片段）
{ "type": "text", "content": "您好！我们有针对", "task_id": "abc12345", "phase": "thinking" }

// agent_reply_ready
{
  "type": "agent_reply_ready",
  "task_id": "abc12345",
  "reply": "您好！我们有针对中小企业的...",
  "delivery": {
    "app": "企业微信",
    "recipient": "oscar",
    "action": "type_and_send"
  }
}

// tool_call（CUA 执行阶段）
{
  "type": "tool_call",
  "name": "type_text",
  "args": { "text": "您好！...", "element_index": 31 },
  "task_id": "abc12345",
  "phase": "executing"
}

// task_done（成功）
{
  "type": "task_done",
  "task_id": "abc12345",
  "reply": "您好！我们有针对中小企业的...",
  "recipient": "oscar"
}

// task_failed（失败）
{ "type": "task_failed", "task_id": "abc12345", "error": "cua-driver 未连接" }
```

---

## POST /api/ingest/mock/{case_name}

触发预设测试案例，无需传 Body。

**可用案例**

| case_name | source | 场景描述 |
|-----------|--------|----------|
| `wecom_price` | wecom | 企业微信客户询价（张三 / XX科技）|
| `wecom_complaint` | wecom | 企业微信客户投诉（李四 / YY贸易）|
| `wechat_inquiry` | wechat | 个人微信代理合作意向（王五）|
| `system_followup` | system | 系统触发客户跟进（高优先级）|

**示例**
```bash
curl -X POST https://your-tunnel.trycloudflare.com/api/ingest/mock/wecom_complaint
```

---

## GET /api/ingest/cases

列出所有可用测试案例。

**响应**
```json
{
  "cases": [
    {
      "name": "wecom_price",
      "source": "wecom",
      "preview": "你好，我想了解一下你们的产品价格...",
      "meta": { "from_name": "张三", "company": "XX科技", "channel": "企业微信" }
    }
  ]
}
```

---

## GET /api/status

查询服务整体状态。

**响应**
```json
{
  "driver_available": true,
  "model": "gemini-3.6-flash",
  "tools_count": 49,
  "history_length": 0,
  "agent_provider": "doubao"
}
```

---

## 多渠道集成示例

### Python — 接收企业微信 Webhook 后转发

```python
import httpx, json

async def handle_wecom_message(payload: dict):
    """企业微信 Webhook → CUA Console"""
    async with httpx.AsyncClient(timeout=120) as client:
        async with client.stream(
            "POST",
            "https://your-tunnel.trycloudflare.com/api/ingest",
            json={
                "content": payload["text"]["content"],
                "source": "wecom",
                "meta": {
                    "from_name": payload["from"]["name"],
                    "user_id": payload["from"]["userId"],
                }
            }
        ) as resp:
            async for line in resp.aiter_lines():
                if not line.startswith("data:"): continue
                event = json.loads(line[5:])
                if event["type"] == "task_done":
                    print(f"✅ 消息已发给 {event['recipient']}: {event['reply'][:30]}")
                elif event["type"] == "task_failed":
                    print(f"❌ 失败: {event['error']}")
```

### curl — 最简单的触发方式

```bash
# 发一条消息并等待完成
curl -X POST https://your-tunnel.trycloudflare.com/api/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "content": "你们服务几点开始？",
    "source": "wechat",
    "meta": {"from_name": "客户B"}
  }'
```

---

## 注意事项

**SSE 超时设置**  
完整流程（Agent + CUA）通常 15~60 秒，HTTP 客户端超时建议设置 120s+。

**并发限制**  
当前使用单锁，同一时间只处理一个任务。
多任务支持需移除 `dispatch_lock` 并确保 CUA 操作不互相干扰。

**CUA 依赖本地屏幕**  
`driver_available: false` 时 Agent 回复仍会生成，但 CUA 交付会失败。  
调用前建议先检查 `/api/status`。

**Delivery 目标目前为固定值**  
`recipient` 和 `app` 由 `.env` 统一配置（`DOUBAO_DEFAULT_RECIPIENT`、`DOUBAO_DEFAULT_APP`）。  
未来 Agent 将在响应中动态指定发送目标。

---

## ⭐ 变更请求（wechat-archiver 集成所需）

**背景**：企微存档服务（wechat-archiver）部署在 Google Cloud Run，自动捕获企微会话存档消息并调用本接口。  
由于每条消息的发送方（客户）不同，**需要 CUA 侧支持动态 recipient 路由**，否则只能回复给固定联系人。

**请求修改**：将 `delivery.recipient` 的来源改为优先读取 `meta.recipient`，fallback 到 `.env` 固定值。

```python
# 伪代码示意（CUA 侧修改）
recipient = request.meta.get('recipient') or os.getenv('DOUBAO_DEFAULT_RECIPIENT')
app       = request.meta.get('app')       or os.getenv('DOUBAO_DEFAULT_APP')
```

**新增 `meta` 字段说明**

| 字段 | 类型 | 来源 | 说明 |
|------|------|------|------|
| `meta.recipient` | string | wechat-archiver | 消息发送方的微信名，CUA 应回复给此人 |
| `meta.app` | string | wechat-archiver | 固定为 `"企业微信"` |
| `meta.employee` | string | wechat-archiver | 对话员工账号名（如 `"张小帆"`） |
| `meta.channel` | string | wechat-archiver | 固定为 `"wecom_archive"` |

**`session_id` 约定**

wechat-archiver 使用 `外部联系人 external_userid`（格式 `wm...`）作为 `session_id`，  
同一客户的所有对话使用同一 `session_id`，便于 CUA 侧维护独立会话上下文。

**`history` 字段**

wechat-archiver 从 Supabase `wechat_archiver.messages` 表查询最近 20 条文本消息，  
格式为 `[{"role": "user"|"assistant", "content": "..."}]`，已按时间升序排列（最新在末尾）。  
Agent 可直接使用此字段作为对话上下文，无需 CUA 侧维护历史。
