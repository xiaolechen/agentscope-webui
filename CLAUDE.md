# AgentScope Web UI — Claude 开发指南

本文件面向在此项目上工作的 AI 助手（Claude）。

---

## 项目结构

```
agentscope-webui/
│
├── backend/                        # Python 后端（FastAPI）
│   ├── main.py                     # 应用入口：注册路由、配置日志、workspace 路径（绝对路径，指向项目根）
│   ├── auth_router.py              # JWT 认证：sha256_crypt 密码哈希（bcrypt 4.x 有兼容问题）
│   ├── users_router.py             # 用户 CRUD，Admin only，操作 Redis webui:user:* 命名空间
│   ├── webui_router.py             # Webui 专属数据层：模型配置、MCP 库、Skill 库、Schedule 代理
│   └── pyproject.toml              # 依赖声明（文档用途，实际安装在 .venv/）
│
├── frontend/                       # React 前端（Vite + TypeScript）
│   ├── src/
│   │   ├── api/                    # axios 封装层（client.ts 自动注入 JWT + x-user-id: webui）
│   │   │   ├── client.ts           # ← 修改 Header 逻辑的唯一入口
│   │   │   └── webui.ts            # Webui 专属接口（模型配置、MCP/Skill 库）
│   │   ├── features/               # 页面模块（每个子目录 = 一个路由页面）
│   │   │   └── chat/
│   │   │       ├── ChatPage.tsx    # 发送逻辑：PATCH session → POST /chat/ → SSE start()
│   │   │       └── useSSEStream.ts # SSE 核心：fetch 直连后端（绕过 Vite proxy）
│   │   ├── store/auth.ts           # Zustand：token、role、boundAgentIds
│   │   └── index.css               # CSS 设计 token（颜色、字体、间距变量）
│   ├── vite.config.ts              # /api 代理到 :8000（注意：SSE 不走这个代理）
│   └── package.json                # Node 依赖
│
├── logs/                           # 运行时日志（.gitignore 整体忽略，start.sh 启动时自动创建）
├── workspaces/                     # AgentScope 运行时数据（.gitignore 忽略，不要手动编辑）
│
├── start.sh                        # 一键启动：python backend/main.py + npm run dev --prefix frontend
├── stop.sh                         # 停止服务（PID + 端口双重清理）
└── logs.sh                         # tail -f 三个日志文件
```

---

## 项目背景

这是 AgentScope 的浏览器管理界面，**不是** agentscope 官方示例 web_ui，是独立重写的多租户版本。核心差异：

- 有自己的用户体系（JWT 认证，Redis 存储，`webui:user:*` 命名空间）
- 所有 agentscope API 调用统一用 `x-user-id: webui`（共享命名空间）
- SSE 流式输出**绕过 Vite proxy** 直连后端（Vite compress 中间件会缓冲 SSE）

---

## 关键技术决策（不要轻易改动）

### 1. SSE 直连后端
`src/features/chat/useSSEStream.ts` 中的 `getBackendOrigin()` 会把 `/api/sessions/.../stream` 转换成后端公网 URL，绕过 Vite proxy。

**原因**：Vite dev server 的 gzip 中间件缓冲了 SSE 响应体，导致事件无法实时到达客户端。

**不要**把流式请求改回走 `/api/` proxy。

### 2. Chat 发消息顺序
```
PATCH session（注入 model config） → POST /chat/（触发）→ start()（连流）
```

**原因**：agentscope 的 stream 端点在 session 未激活时立即关闭连接（只返回 `:` keepalive）。必须先触发 chat，再连流。

### 3. Session 必须有 chat_model_config
每次发消息前都会 PATCH session 写入模型配置（`sessionsApi.update(sid, agentId, { chat_model_config })`），确保后端能处理请求。

**原因**：没有 model config 的 session，后端接受 chat trigger（200）但静默失败，stream 为空。

### 4. x-user-id 是固定值
`src/api/client.ts` 的拦截器固定发送 `x-user-id: webui`。

**原因**：所有资源（Agent、Session、Credential）在 agentscope 里共享同一个命名空间，webui 自己的 RBAC 层在上面做权限控制。

---

## Python 环境

**使用项目根目录下的 `.venv`（由 `setup.sh` 创建）。**

```bash
# 首次或换机器后初始化（安装所有依赖）
bash setup.sh

# 运行后端（从项目根目录）
.venv/bin/python backend/main.py

# 安装新的 Python 包（需要时）
uv pip install <package> --system-certs --python .venv/bin/python
```

`pyproject.toml` 的依赖声明在 `backend/pyproject.toml`，是文档用途。agentscope 优先从 `../agentscope` 本地源 editable install，若不存在则从 PyPI 安装 `>=2.0.3`。

---

## 前端开发

```bash
# 从项目根目录
npm run dev --prefix frontend    # 开发服务器（HMR）
npm run build --prefix frontend  # 生产构建（TypeScript 检查 + Vite）
```

构建必须通过才能认为代码正确。有 TypeScript 错误要修掉，不要用 `// @ts-ignore` 绕过。

---

## 后端路由结构

```
/auth/*        # JWT 登录（auth_router.py）
/users/*       # 用户 CRUD，Admin only（users_router.py）
/webui/*       # Webui 数据层（webui_router.py）
  /webui/me/default-model      # 用户默认模型
  /webui/agent-model/{id}      # Agent 模型配置
  /webui/cred-models/{id}      # Credential 自定义模型
  /webui/mcp-lib               # MCP 库（Redis 存储）
  /webui/skill-lib             # Skill 库（Redis 存储）
  /webui/schedule              # Schedule 创建代理（自动注入 model config）
  /webui/session-track         # Session 归属记录
  /webui/my-session-ids/{id}   # 用户可见的 Session ID 列表
/agent/*       # agentscope 原生 Agent API
/sessions/*    # agentscope 原生 Session API
/credential/*  # agentscope 原生 Credential API
/schedule/*    # agentscope 原生 Schedule API
/chat/         # agentscope 原生 Chat trigger
/logs/*        # 日志查看（自定义）
```

---

## 常见陷阱

| 陷阱 | 说明 |
|---|---|
| Workspace `.mcp` 文件 | 修改 `default_mcps` 后，需手动删除 `workspaces/*/` 下的 `.mcp` 文件，否则旧配置仍生效 |
| 新 session 响应慢 | 通常是 workspace 初始化 MCP 导致。确认 `backend/main.py` 的 `default_mcps = []` |
| SSE 无输出 | 检查：1) Session 有 model config？2) `x-user-id` header 发送了？3) SSE URL 直连后端（非 proxy）？ |
| 422 on stream | 大概率是 `x-user-id` header 缺失，stream 端点必填 |
| 模型调用 409 | Session 正在处理中，用户重复发消息。前端应在 `sseState.streaming = true` 时禁用发送 |

---

## 文件说明

```
backend/main.py              # 后端入口，引用 agentscope create_app + 注册三个 router
backend/auth_router.py       # 用户认证，sha256_crypt 哈希（bcrypt 4.x 有兼容性问题）
backend/users_router.py      # 用户 CRUD
backend/webui_router.py      # Webui 专属 Redis 数据层

frontend/src/api/client.ts    # axios 实例，拦截器注入 Authorization + x-user-id
frontend/src/api/webui.ts     # webui 专属接口（模型配置、MCP/Skill 库等）
frontend/src/features/chat/useSSEStream.ts  # SSE 核心（直连后端，fetch + ReadableStream）
frontend/src/features/chat/ChatPage.tsx     # Chat 主页（含发送逻辑、模型检查、resume 功能）
frontend/src/store/auth.ts    # Zustand auth store（token、role、boundAgentIds）
```
