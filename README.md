# AgentScope Web UI

浏览器端管理界面，为 [AgentScope](https://github.com/modelscope/agentscope) 提供多租户 Web UI，支持 Agent 管理、对话、凭据、定时任务等全套功能。

---

## 功能概览

| 模块 | 说明 |
|---|---|
| **Chat** | 与 Agent 对话，流式输出，支持会话恢复；空状态展示预设问题引导 |
| **Sessions** | 查看历史会话，继续对话，重命名/删除 |
| **Agents** | 创建、编辑 Agent，绑定模型配置、MCP、Skill、预设问题 |
| **Credentials** | 管理 API Key（DashScope / Anthropic / OpenAI 等 8 家），查看模型列表，设置默认模型 |
| **MCP** | 注册 / 编辑 MCP Server（stdio / SSE / Streamable HTTP），支持认证（none/bearer/api_key/oauth），测试连接，启停 |
| **Skills** | 管理 Skill 库（按路径注册），支持 `npx skills add` 在线安装（admin only） |
| **Schedules** | 定时任务（Cron），Agent 自动定期执行，可立即运行 |
| **Logs** | 后端日志查看（App log / Service log） |
| **Settings** | 主题切换（light / dark / system）、Skill 路径管理、Redis 数据浏览器、后端重启 |
| **Users** | 用户管理（Admin 专属），绑定 Agent 权限 |

### 角色权限

| 角色 | 权限 |
|---|---|
| **admin** | 全部功能；多个 admin **共享同一套 MCP 库 / Skill 路径 / Skill 禁用集** |
| **user** | 仅 Chat + Sessions（只见绑定的 Agent 及自己的会话）；不能用 stdio MCP、不能安装 Skill |

---

## 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20.x | 前端构建 |
| Python | ≥ 3.11 | 后端 |
| Redis | ≥ 6.x | 数据存储 + 消息总线 |
| uv | 任意 | Python 包管理（setup.sh 自动安装） |

> `setup.sh` 会自动检测并安装缺失的依赖，**无需手动准备环境**。

---

## 快速启动

### 1. 初始化环境（首次，或换机器后）

```bash
bash setup.sh
```

setup.sh 会自动完成：检测 OS → 安装 Python 3.11+ / Node.js 20+ / Redis / uv → 创建 `.venv` → 安装后端 Python 依赖 → 安装前端 npm 依赖 → 生成 `.env` 模板。

> agentscope 安装策略：若 `../agentscope` 本地源码存在则 editable install，否则从 PyPI 安装 `>=2.0.3`。

### 2. 启动所有服务

```bash
bash start.sh
```

启动完成后输出：

```
┌──────────────────────────────────────────┐
│  Backend API  : http://localhost:8000    │
│  Frontend     : http://localhost:5173    │
│  API Docs     : http://localhost:8000/docs│
└──────────────────────────────────────────┘
```

### 3. 默认登录账号

```
用户名: admin
密码:   admin123  （可通过环境变量 ADMIN_PASSWORD 覆盖）
```

---

## 常用命令

```bash
bash setup.sh                        # 初始化环境（首次 / 换机器后）
bash start.sh                        # 启动（后端 + 前端）
bash stop.sh                         # 停止所有服务
bash logs.sh                         # 实时跟踪日志

npm run dev --prefix frontend        # 单独启动前端开发服务器
npm run build --prefix frontend      # 构建生产版本
```

---

## 项目结构

```
agentscope-webui/
│
├── backend/                        # Python 后端（FastAPI）
│   ├── main.py                     # 应用入口：注册全部 router + JWT 依赖覆盖 + 日志配置 + 启动迁移
│   ├── auth_router.py              # JWT 认证：POST /auth/login、GET /auth/me；webui_user_id 依赖覆盖（全局 JWT 鉴权）
│   ├── users_router.py             # 用户 CRUD（Admin only）：GET/POST/PATCH/DELETE /users/
│   ├── mcp_router.py               # MCP 库（注册/编辑/测试/启停）：/webui/mcp-lib/*
│   ├── skill_router.py             # Skill 库（扫描/启停/npx 安装）：/webui/skill-lib/*、/webui/skill-dirs
│   ├── session_router.py           # Session 归属 + workspace 注入（MCP+Skill+PermissionMode）
│   ├── schedule_router.py          # Schedule 创建代理（注入 model config）：/webui/schedule
│   ├── agent_config_router.py      # Agent 级配置（模型/MCP绑定/Skill绑定/预设问题）：/webui/agent-*
│   ├── model_router.py             # 用户/Agent 模型配置：/webui/me/default-model、/webui/agent-model/*
│   ├── redis_browser_router.py     # Redis 数据浏览器（Admin 只读）：/webui/redis/keys、/webui/redis/key
│   ├── webui_helpers.py            # 共享工具：Redis key helpers、_config_owner()、PRODUCTION_MODE 常量
│   └── pyproject.toml              # Python 依赖声明（文档用途，实际安装在项目根 .venv）
│
├── frontend/                       # React 前端（Vite + TypeScript）
│   ├── src/
│   │   ├── api/                    # 类型化 HTTP 客户端（axios 封装，自动注入 JWT + x-user-id）
│   │   │   ├── client.ts           # axios 实例 + 请求拦截器
│   │   │   ├── agents.ts           # Agent CRUD
│   │   │   ├── sessions.ts         # Session 管理
│   │   │   ├── credentials.ts      # Credential 管理
│   │   │   ├── schedules.ts        # 定时任务
│   │   │   ├── users.ts            # 用户管理
│   │   │   ├── auth.ts             # 登录 / logout
│   │   │   └── webui.ts            # Webui 专属接口（模型配置、MCP 库编辑/测试、Skill 安装、预设问题、Redis 浏览等）
│   │   │
│   │   ├── features/               # 按功能拆分的页面模块（每个子目录对应一个路由页面）
│   │   │   ├── auth/               # 登录页
│   │   │   ├── chat/               # 对话页：SSE 流式输出、消息渲染、会话恢复
│   │   │   ├── agents/             # Agent 创建 / 编辑 / 删除，绑定模型配置、MCP/Skill、预设问题
│   │   │   ├── credentials/        # API Key 管理，查看模型列表，设置默认模型
│   │   │   ├── sessions/           # 历史会话列表，继续对话，重命名 / 删除
│   │   │   ├── mcp/                # MCP Server 注册 / 编辑 / 测试 / 启停（stdio / SSE / Streamable HTTP）
│   │   │   ├── skills/             # Skill 库管理（按路径注册 + npx 安装）
│   │   │   ├── schedules/          # 定时任务（Cron），Agent 定期自动执行，可立即运行
│   │   │   ├── logs/               # 后端日志查看（App log / Service log）
│   │   │   ├── settings/           # 主题切换 / Skill 路径管理 / Redis 数据浏览器 / 后端重启
│   │   │   └── users/              # 用户管理（Admin 专属），绑定 Agent 权限
│   │   │
│   │   ├── layouts/                # 全局布局：侧边栏导航、用户菜单
│   │   ├── router/                 # React Router 配置 + PrivateRoute 登录守卫
│   │   ├── store/                  # Zustand 状态（JWT token、用户角色、已绑定 Agent）
│   │   ├── index.css               # 全局样式 + CSS 设计 token（颜色、字体、间距）
│   │   └── main.tsx                # React 应用挂载入口
│   │
│   ├── index.html                  # Vite HTML 模板（单页应用入口）
│   ├── vite.config.ts              # Vite 配置：/api 反向代理到 :8000，路径别名 @/
│   ├── tsconfig.json               # TypeScript 编译配置
│   ├── components.json             # shadcn/ui 组件配置
│   └── package.json                # Node 依赖声明
│
├── logs/                           # 运行时日志目录（整体被 .gitignore 忽略）
│   ├── backend/                    # 后端日志：backend.log（滚动）+ backend-console-YYYY-MM-DD.log
│   └── frontend/                   # 前端日志：frontend-YYYY-MM-DD.log
│
├── workspaces/                     # AgentScope 运行时 workspace 数据（被 .gitignore 忽略）
│                                   # 每个 Agent 一个目录，存储 MCP 配置、Skill 文件等
│
├── start.sh                        # 一键启动：检查 Redis → 启动后端 → 启动前端
├── stop.sh                         # 停止所有服务（按 PID + 端口双重清理）
├── logs.sh                         # 实时跟踪三个日志文件（tail -f）
│
├── .env                            # 环境变量（不提交）：SECRET_KEY、ADMIN_PASSWORD 等
├── README.md                       # 项目说明（面向人类开发者）
├── CLAUDE.md                       # Claude AI 开发指南（面向 AI 编程助手）
└── AGENT.md                        # Agent API 接口参考（面向调用 API 的 AI Agent）
```

---

## Redis 数据命名空间

> `owner` 含义：admin → 固定字符串 `"admin"`（多个 admin 共享）；非 admin → `user.id`（隔离）。Agent 级配置按 `agent_id` 命名，跨用户共享，由 RBAC 把关。

| 前缀 | 内容 |
|---|---|
| `agentscope:user:webui:*` | agentscope 原生数据（Agent、Session、Credential、Schedule、Workspace） |
| `webui:user:id:{user_id}` | 用户账号 JSON（username、role、bound_agent_ids、hashed_password） |
| `webui:user:name:{username}` | username → user_id 索引 |
| `webui:config:default-model:{user_id}` | 用户默认模型（按 user.id，不共享） |
| `webui:config:agent-model:{agent_id}` | 每个 Agent 的模型配置 |
| `webui:config:agent-mcps:{agent_id}` | Agent 绑定的 MCP 名列表 |
| `webui:config:agent-skills:{agent_id}` | Agent 绑定的 skill 路径列表 |
| `webui:config:agent-questions:{agent_id}` | Agent 预设问题（最多 5） |
| `webui:config:cred-models:{cred_id}` | Credential 的自定义模型名列表 |
| `webui:config:mcp-lib:{owner}` | MCP Server 库（admin 共享 / 非 admin 隔离） |
| `webui:config:skill-dirs:{owner}` | Skill 根目录列表（admin 共享 / 非 admin 隔离） |
| `webui:config:skill-disabled:{owner}` | 禁用的 skill 路径集（admin 共享 / 非 admin 隔离） |
| `webui:user-sessions:{user_id}` | 用户的 Session 归属记录 |

---

## 初次使用流程

1. 启动服务，以 `admin` 登录
2. **Credentials** → 添加 API Key（如 DashScope），展开后设置默认模型
3. **Agents** → 创建 Agent，编辑时选择 Credential + Model
4. **Chat** → 选中 Agent，发起对话
5. **Users** → 创建普通用户并绑定 Agent（可选）

---

## 架构与安全

- **多租户叠加 RBAC**：agentscope 原生用共享 `x-user-id` 命名空间，webui 在其上叠加自己的 JWT 用户体系 + RBAC（`webui:user:*`）。所有 agentscope 原生端点经 `dependency_overrides` 全局替换成 JWT 鉴权——必须带有效 webui JWT 才放行，客户端伪造的 `x-user-id` 不再可信。
- **Admin 共享配置**：MCP 库 / Skill 路径 / Skill 禁用集按 `owner` 命名，admin 共享固定 `owner="admin"`，非 admin 按 `user.id` 隔离。启动时 `migrate_admin_shared_namespace()` 幂等迁移旧 per-admin 数据到共享 key。
- **服务端密钥**：MCP 的 `auth_token` 存 Redis，GET 响应剥离，编辑留空则保留原值，重测按名加载——密钥不下发浏览器。
- **stdio MCP / Skill 安装仅 admin**：stdio 在后端主机执行命令有 RCE 风险；`npx skills add` 同理。远程 sse/streamable-http 传输全员可用。
- **后端默认绑 `127.0.0.1`**：外网暴露需设 `BACKEND_HOST=0.0.0.0` 且必须放反代后面。
- **SSE 直连后端**：流式输出绕过 Vite proxy（其 gzip 中间件会缓冲 SSE），前端 `useSSEStream.ts` 把 stream URL 转成后端直连地址。

---

## 技术栈

**前端**：Vite 6 · React 18 · TypeScript · Tailwind CSS（CDN）· TanStack Query v5 · Zustand · React Router v7 · React Hook Form + Zod · Lucide React

**后端**：FastAPI · Redis · agentscope · python-jose · passlib · httpx

**设计风格**：Apple 设计规范（SF Pro 字体栈，`#0066cc` 强调色，`#f5f5f7` 背景）

---

## 开发约束

贡献代码前请阅读以下约束：

- **不修改 agentscope 源码**：只调用 agentscope 开放 API（`agentscope.app` / `agentscope.mcp` / `agentscope.permission`）
- **开闭原则**：新功能 = 新 router 文件，在 `main.py` 注册；共享工具追加到 `webui_helpers.py`
- **Redis 规范**：key 字符串通过 `webui_helpers.py` 的 `_xxx_key()` 生成；连续操作用 `pipeline()`；禁用 `KEYS *`
- **错误日志**：所有错误需包含操作者、资源 id、HTTP status；禁止 `except Exception: pass`
- **生产安全**：设置 `PRODUCTION_MODE=true` 可限制 agent Bash tool 为只读模式并屏蔽 stdio MCP；详见 CLAUDE.md 编码规范章节

详细约束见 [CLAUDE.md](CLAUDE.md)。
