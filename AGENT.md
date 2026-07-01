# AgentScope Web UI — Agent 开发指南

本文件面向通过 AgentScope API 与本系统交互的 AI Agent，描述可调用的接口、鉴权方式和核心数据结构。

---

## 项目结构概览

```
agentscope-webui/
├── backend/                          # Python 后端（FastAPI，监听 :8000）
│   ├── main.py                       # 应用入口，注册全部路由 + 启动迁移
│   ├── auth_router.py                # /auth/*  JWT 认证 + get_current_user_id 依赖覆盖
│   ├── users_router.py               # /users/* 用户管理（Admin only）
│   ├── webui_router.py               # /webui/* Webui 专属接口
│   └── redis_browser_router.py       # /webui/redis/* Redis 数据浏览器（Admin 只读）
│
└── frontend/                         # React 前端（Vite，监听 :5173）
    └── src/
        ├── api/                      # HTTP 客户端封装
        └── features/                 # 各功能页面（chat / agents / credentials 等）
```

后端提供全部 REST API 和 SSE 流；前端是纯静态 SPA，所有数据均通过调用后端接口获取。

---

## 服务地址

| 环境 | 地址 |
|---|---|
| 本地开发 | `http://localhost:8000` |
| API 文档 | `http://localhost:8000/docs`（OpenAPI Swagger） |

> 后端默认绑 `127.0.0.1`（loopback）。外网暴露需设 `BACKEND_HOST=0.0.0.0` 且必须放反代后面。

---

## 鉴权

**所有接口都需要 JWT Bearer Token**——包括 agentscope 原生接口（`/agent/`、`/sessions/`、`/credential/`、`/chat/`、`/workspace/`、`/schedule/` 等）。

```
Authorization: Bearer <token>
```

> ⚠️ 历史上 agentscope 原生接口仅靠 `x-user-id` 头识别用户，可伪造。本项目在 `backend/main.py` 用 `app.dependency_overrides[get_current_user_id] = auth_router.webui_user_id` **全局替换**成 JWT 鉴权：必须带有效 webui JWT 才放行，通过后服务端覆写为共享命名空间 `"webui"`。客户端伪造的 `x-user-id` 不再可信。`client.ts` 仍发 `x-user-id: webui` 只是为兼容，真正鉴权靠 JWT。

获取 token：

```bash
curl -X POST http://localhost:8000/auth/login \
  -d "username=admin&password=admin123" \
  -H "Content-Type: application/x-www-form-urlencoded"
# → {"access_token":"...", "role":"admin", "user_id":"..."}
```

后续所有请求带 `Authorization: Bearer <access_token>`。

---

## 核心接口速查

> 以下所有端点都需要 `Authorization: Bearer <token>` 头（见上文鉴权）。

### Agent 管理

```
GET    /agent/              # 列出所有 Agent
POST   /agent/              # 创建 Agent
PATCH  /agent/{agent_id}    # 更新 Agent
DELETE /agent/{agent_id}    # 删除 Agent
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
GET    /sessions/                          # 列出 sessions（需 ?agent_id=）
POST   /sessions/                          # 创建 session
PATCH  /sessions/{session_id}?agent_id=    # 更新 session（含 chat_model_config）
DELETE /sessions/{session_id}?agent_id=    # 删除 session
GET    /sessions/{session_id}/messages     # 获取消息历史
GET    /sessions/{session_id}/stream       # SSE 事件流（长连接）
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
POST /chat/
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
Header: Authorization: Bearer <token>
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
GET    /credential/              # 列出凭据
POST   /credential/              # 创建凭据
DELETE /credential/{id}          # 删除凭据
GET    /credential/schemas       # 所有 provider 的字段 schema
GET    /model/?provider=dashscope  # 该 provider 的模型列表
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
# 模型配置
GET  /webui/me/default-model          # 当前用户的默认模型
PUT  /webui/me/default-model          # 设置默认模型（body: ChatModelConfig）
DELETE /webui/me/default-model        # 清除默认模型
GET  /webui/agent-model/{agent_id}    # Agent 的模型配置
PUT  /webui/agent-model/{agent_id}    # 设置 Agent 的模型配置
DELETE /webui/agent-model/{agent_id}  # 清除 Agent 的模型配置
GET/POST/DELETE /webui/cred-models/{cred_id}     # Credential 的自定义模型名列表
GET/POST/DELETE /webui/cred-models/{cred_id}/{model_name}  # 删除单个

# Agent 绑定（按 agent_id 共享，require_agent_access 把关：admin 直通 / 非 admin 须绑定）
GET/PUT /webui/agent-mcps/{agent_id}          # Agent 绑定的 MCP 名列表（string[]）
GET/PUT /webui/agent-skills/{agent_id}        # Agent 绑定的 skill 路径列表（string[]）
GET  /webui/agent-skills-full/{agent_id}      # 解析成 {name,path,is_enabled}（非 admin 也能用）
GET/PUT /webui/agent-questions/{agent_id}     # Agent 预设问题（string[]，最多 5，服务端 trim+cap）

# MCP 库（按 owner：admin 共享 "admin" / 非 admin 按 user.id）
GET  /webui/mcp-lib                  # 列表（auth_token 被剥离）
POST /webui/mcp-lib                  # 注册（stdio 仅 admin）
PUT  /webui/mcp-lib/{name}           # 编辑（name 不可变；auth_token 留空则保留原值）
PATCH /webui/mcp-lib/{name}          # 启停（body: {is_enabled}）
DELETE /webui/mcp-lib/{name}
POST /webui/mcp-lib/test             # 临时测试（body: McpDef，含表单 token）
POST /webui/mcp-lib/test/{name}      # 按名重测（加载服务端已存 token）

# Skill 库（skill-dirs/skill-disabled 按 owner 共享）
GET/POST/DELETE /webui/skill-dirs    # Skill 根目录（每子目录含 SKILL.md 即一个 skill）
GET  /webui/skill-lib                # 扫描结果（{name,path,is_enabled}）
POST /webui/skill-lib/toggle         # 启停 skill（body: {path,is_enabled}）
POST /webui/skill-lib/install        # npx skills add 安装（admin only，target_dir 须是已注册 skill-dir）

# Session 注入（内部透传 JWT 调 agentscope /workspace/*）
POST /webui/session-workspace        # 注入 agent 的 MCP+Skill 到 session workspace（幂等）
POST /webui/session-skill            # 单 skill 注入活跃 session（body: {agent_id,session_id,skill_path}）

# Session 归属
POST /webui/session-track            # 记录归属（body: {session_id, agent_id}）
GET  /webui/my-session-ids/{agent_id}  # 当前用户在该 agent 下的 session ID 列表

# Schedule
POST /webui/schedule                 # 创建定时任务（自动注入 agent 的 model config）
POST /webui/schedule/{schedule_id}/run  # 立即运行

# 运维（Admin only）
POST /webui/restart                  # 重启后端
GET  /webui/redis/keys               # Redis key 列表（cursor 分页）
GET  /webui/redis/key                # 单 key 数据（分页）
```

#### McpDef 结构

```json
{
  "name": "tao-loan",
  "transport": "stdio | sse | streamable-http",
  "command": "npx",
  "args": ["-y", "@some/mcp"],
  "url": "",
  "is_stateful": true,
  "is_enabled": true,
  "auth_type": "none | bearer | api_key | oauth",
  "auth_token": "sk-…",
  "auth_header_name": "X-API-Key"
}
```

- `name` 必须匹配 `[a-zA-Z0-9_-]+`（嵌入 LLM 工具名 `mcp__{name}__{tool}`，非 ASCII 不允许）
- `auth_token` 是服务端密钥：`GET /webui/mcp-lib` 响应里被剥离；编辑时留空保留原值；重测走 `/mcp-lib/test/{name}`
- `auth_type`：`none`/`bearer`/`oauth` → `Authorization: Bearer <token>`；`api_key` → `<auth_header_name|X-API-Key>: <token>`
- stdio 注册/测试仅 admin（在 backend 主机执行命令）；远程传输全员可用

---

## 正确的 Chat 调用流程

```
1. POST /sessions/                        →  创建 session（带 chat_model_config）
2. POST /webui/session-track              →  记录 session 归属
3. PATCH /sessions/{id}?agent_id=         →  注入 chat_model_config（确保 session 激活）
4. POST /webui/session-workspace          →  注入 agent 绑定的 MCP+Skill 到 workspace
5. POST /chat/                            →  触发 chat（使用 Msg 格式）
6. GET  /sessions/.../stream              →  直连 SSE 读取事件（累积 TEXT_BLOCK_DELTA.delta）
```

**不要**在 `POST /chat/` 之前连接 SSE——session 未激活时 stream 端点立即关闭。
**不要**跳过第 4 步——否则 agent 调用不到绑定的 MCP/Skill 工具。

---

## 常见错误

| 状态码 | 原因 | 修复 |
|---|---|---|
| 401 | 缺 JWT 或 JWT 失效 | 所有请求带 `Authorization: Bearer <token>`（包括 agentscope 原生端点） |
| 422 on /chat/ | `input` 格式错误（发了字符串而不是 Msg 对象） | 使用 Msg 格式，见上 |
| 422 on /sessions/.../stream | JWT 缺失或无效 | 加 `Authorization: Bearer <token>` |
| 409 on /chat/ | Session 正在处理中 | 等待当前 reply 结束再发 |
| 403 on /webui/agent-* | 非 admin 访问未绑定给自己的 agent | 让 admin 把 agent 绑定给该用户 |
| 403 on stdio MCP 注册/测试 | stdio 在后端主机执行命令，仅 admin | 改用 sse / streamable-http 远程传输 |
| Stream 为空（只有 `:`） | Session 没有 `chat_model_config` | PATCH session 写入模型配置 |
| Stream 为空（没有 TEXT_BLOCK_DELTA） | model config 的 credential_id 无效，或 agent 绑定的 MCP/Skill 未注入 | 检查凭据有效；调 `POST /webui/session-workspace` 注入 |
| MCP "Not authenticated" | 旧 MCP 条目无 auth 字段（迁移自旧版） | PUT `/webui/mcp-lib/{name}` 补 auth_type + auth_token |
