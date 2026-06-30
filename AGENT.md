# AgentScope Web UI — Agent 开发指南

本文件面向通过 AgentScope API 与本系统交互的 AI Agent，描述可调用的接口、鉴权方式和核心数据结构。

---

## 项目结构概览

```
agentscope-webui/
├── backend/            # Python 后端（FastAPI，监听 :8000）
│   ├── main.py         # 应用入口，注册全部路由
│   ├── auth_router.py  # /auth/*  JWT 认证
│   ├── users_router.py # /users/* 用户管理
│   └── webui_router.py # /webui/* Webui 专属接口
│
└── frontend/           # React 前端（Vite，监听 :5173）
    └── src/
        ├── api/        # HTTP 客户端封装
        └── features/   # 各功能页面（chat / agents / credentials 等）
```

后端提供全部 REST API 和 SSE 流；前端是纯静态 SPA，所有数据均通过调用后端接口获取。

---

## 服务地址

| 环境 | 地址 |
|---|---|
| 本地开发 | `http://localhost:8000` |
| 沙箱公网 | `https://cdfc69-sandbox-sessionbf2a6217b4684053a9-8000.agent.alibaba-inc.com` |
| API 文档 | `http://localhost:8000/docs`（OpenAPI Swagger） |

---

## 鉴权

所有 agentscope 原生接口（`/agent/`、`/sessions/`、`/credential/` 等）使用 Header 认证：

```
x-user-id: webui
```

Webui 专属接口（`/webui/*`、`/auth/*`、`/users/*`）使用 JWT Bearer Token：

```
Authorization: Bearer <token>
```

获取 token：

```bash
curl -X POST http://localhost:8000/auth/login \
  -d "username=admin&password=admin123" \
  -H "Content-Type: application/x-www-form-urlencoded"
# → {"access_token":"...", "role":"admin", "user_id":"..."}
```

---

## 核心接口速查

### Agent 管理

```
GET    /agent/              x-user-id: webui  # 列出所有 Agent
POST   /agent/              x-user-id: webui  # 创建 Agent
PATCH  /agent/{agent_id}    x-user-id: webui  # 更新 Agent
DELETE /agent/{agent_id}    x-user-id: webui  # 删除 Agent
```

创建请求体：
```json
{
  "name": "my-agent",
  "system_prompt": "You are a helpful assistant."
}
```

### Session 管理

```
GET    /sessions/                          x-user-id: webui  # 列出 sessions（需 ?agent_id=）
POST   /sessions/                          x-user-id: webui  # 创建 session
PATCH  /sessions/{session_id}?agent_id=   x-user-id: webui  # 更新 session（含 chat_model_config）
DELETE /sessions/{session_id}?agent_id=   x-user-id: webui  # 删除 session
GET    /sessions/{session_id}/messages    x-user-id: webui  # 获取消息历史
GET    /sessions/{session_id}/stream      x-user-id: webui  # SSE 事件流（长连接）
```

Sessions 列表返回格式（每条包装在 `session` 字段下）：
```json
{
  "sessions": [
    {
      "session": { "id": "...", "agent_id": "...", "config": { "name": "..." }, ... },
      "is_running": false
    }
  ]
}
```

### Chat 触发

```
POST /chat/   x-user-id: webui
```

请求体格式（**必须**使用 `Msg` 格式，不是字符串）：
```json
{
  "agent_id": "8e98ad615aa0424493860daa59a7837c",
  "session_id": "abc123",
  "input": {
    "id": "<uuid>",
    "role": "user",
    "name": "user",
    "content": [
      { "type": "text", "text": "Hello", "id": "<uuid>" }
    ]
  }
}
```

返回：`{"status": "started", "session_id": "..."}`（异步触发，实际输出通过 SSE 获取）

### SSE 事件流

```
GET /sessions/{session_id}/stream?agent_id={agent_id}
Header: x-user-id: webui
```

**重要**：不能通过任何 HTTP 反向代理（如 nginx、Vite proxy）访问此端点——代理会缓冲响应体。请直连后端。

事件类型：

| type | 说明 | 关键字段 |
|---|---|---|
| `REPLY_START` | 一轮回复开始 | `reply_id` |
| `TEXT_BLOCK_DELTA` | 流式文本增量 | `delta`（拼接累积即为完整文本） |
| `TEXT_BLOCK_END` | 文本块结束 | - |
| `TOOL_CALL_START` | 工具调用开始 | `name` |
| `TOOL_CALL_END` | 工具调用结束 | - |
| `REQUIRE_USER_CONFIRM` | 等待用户确认权限 | `tool_calls` |
| `REPLY_END` | 一轮回复结束（流关闭信号） | - |
| `EXCEED_MAX_ITERS` | 超过最大迭代次数 | - |

### Credential 管理

```
GET    /credential/           x-user-id: webui  # 列出凭据
POST   /credential/           x-user-id: webui  # 创建凭据
DELETE /credential/{id}       x-user-id: webui  # 删除凭据
GET    /credential/schemas                       # 所有 provider 的字段 schema
GET    /model/?provider=dashscope                # 该 provider 的模型列表
```

创建凭据（`type` 是 discriminator，必填）：
```json
{
  "data": {
    "type": "dashscope_credential",
    "api_key": "sk-..."
  }
}
```

支持的 type：`dashscope_credential` / `anthropic_credential` / `openai_credential` / `deepseek_credential` / `gemini_credential` / `xai_credential` / `moonshot_credential` / `ollama_credential`

### ChatModelConfig 结构

session 创建或 PATCH 时使用：
```json
{
  "type": "dashscope_chat",
  "credential_id": "92021be0e033418c92bd09044d575dc7",
  "model": "qwen3.7-plus",
  "parameters": {}
}
```

`type` 与 credential type 对应：`dashscope_chat` / `anthropic_chat` / `openai_chat` / `deepseek_chat` / `gemini_chat` / `xai_chat` / `moonshot_chat` / `ollama_chat`

### Webui 专属接口（需 JWT）

```
GET  /webui/agent-model/{agent_id}    # 获取 Agent 的模型配置
PUT  /webui/agent-model/{agent_id}    # 设置 Agent 的模型配置（body: ChatModelConfig）

GET  /webui/me/default-model          # 当前用户的默认模型
PUT  /webui/me/default-model          # 设置默认模型

GET  /webui/mcp-lib                   # 当前用户的 MCP Server 列表
GET  /webui/skill-lib                 # 当前用户的 Skill 列表

POST /webui/schedule                  # 创建定时任务（自动注入 agent 的 model config）
POST /webui/session-track             # 记录 session 归属（body: {session_id, agent_id}）
GET  /webui/my-session-ids/{agent_id} # 当前用户在该 agent 下的 session ID 列表
```

---

## 正确的 Chat 调用流程

```
1. POST /sessions/           →  创建 session（带 chat_model_config）
2. POST /webui/session-track →  记录 session 归属
3. POST /chat/               →  触发 chat（使用 Msg 格式）
4. GET /sessions/.../stream  →  直连 SSE 读取事件（累积 TEXT_BLOCK_DELTA.delta）
```

**不要**在 `POST /chat/` 之前连接 SSE——session 未激活时 stream 端点立即关闭。

---

## 常见错误

| 状态码 | 原因 | 修复 |
|---|---|---|
| 422 on /chat/ | `input` 格式错误（发了字符串而不是 Msg 对象） | 使用 Msg 格式，见上 |
| 422 on /sessions/.../stream | 缺少 `x-user-id` header | 加上 header |
| 409 on /chat/ | Session 正在处理中 | 等待当前 reply 结束再发 |
| Stream 为空（只有 `:`） | Session 没有 `chat_model_config` | PATCH session 写入模型配置 |
| Stream 为空（没有 TEXT_BLOCK_DELTA） | model config 的 credential_id 无效 | 检查凭据是否存在且有效 |
