# AgentScope Web UI

浏览器端管理界面，为 [AgentScope](https://github.com/modelscope/agentscope) 提供多租户 Web UI，支持 Agent 管理、对话、凭据、定时任务等全套功能。

---

## 功能概览

| 模块 | 说明 |
|---|---|
| **Chat** | 与 Agent 对话，流式输出，支持会话恢复 |
| **Sessions** | 查看历史会话，继续对话，重命名/删除 |
| **Agents** | 创建、编辑 Agent，绑定模型配置 |
| **Credentials** | 管理 API Key（DashScope / Anthropic / OpenAI 等 8 家），查看模型列表，设置默认模型 |
| **MCP** | 注册 MCP Server（stdio / SSE / Streamable HTTP） |
| **Skills** | 管理 Skill 库（按路径注册） |
| **Schedules** | 定时任务（Cron），Agent 自动定期执行 |
| **Logs** | 后端日志查看（App log / Service log） |
| **Settings** | 主题切换（light / dark / system） |
| **Users** | 用户管理（Admin 专属），绑定 Agent 权限 |

### 角色权限

| 角色 | 权限 |
|---|---|
| **admin** | 全部功能 |
| **user** | 仅 Chat + Sessions（只见绑定的 Agent 及自己的会话） |

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

### 4. 默认登录账号

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
│   ├── main.py                     # 应用入口：注册 AgentScope app + 三个路由 + 日志配置
│   ├── auth_router.py              # JWT 认证：POST /auth/login、GET /auth/me
│   ├── users_router.py             # 用户 CRUD（Admin only）：GET/POST/PATCH/DELETE /users/
│   ├── webui_router.py             # Webui 专属数据层：模型配置、MCP 库、Skill 库、定时任务代理
│   └── pyproject.toml              # Python 依赖声明（文档用途，实际安装在 agentscope-app/.venv）
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
│   │   │   └── webui.ts            # Webui 专属接口（模型配置、MCP/Skill 库等）
│   │   │
│   │   ├── features/               # 按功能拆分的页面模块（每个子目录对应一个路由页面）
│   │   │   ├── auth/               # 登录页
│   │   │   ├── chat/               # 对话页：SSE 流式输出、消息渲染、会话恢复
│   │   │   ├── agents/             # Agent 创建 / 编辑 / 删除，绑定模型配置
│   │   │   ├── credentials/        # API Key 管理，查看模型列表，设置默认模型
│   │   │   ├── sessions/           # 历史会话列表，继续对话，重命名 / 删除
│   │   │   ├── mcp/                # MCP Server 注册（stdio / SSE / Streamable HTTP）
│   │   │   ├── skills/             # Skill 库管理（按路径注册）
│   │   │   ├── schedules/          # 定时任务（Cron），Agent 定期自动执行
│   │   │   ├── logs/               # 后端日志查看（App log / Service log）
│   │   │   ├── settings/           # 主题切换（light / dark / system）
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

| 前缀 | 内容 |
|---|---|
| `agentscope:user:webui:*` | agentscope 原生数据（Agent、Session、Credential、Schedule） |
| `webui:user:*` | 用户账号（username、role、bound_agent_ids） |
| `webui:config:agent-model:{agent_id}` | 每个 Agent 的模型配置 |
| `webui:config:default-model:{user_id}` | 用户默认模型 |
| `webui:config:cred-models:{cred_id}` | Credential 的自定义模型名列表 |
| `webui:config:mcp-lib:{user_id}` | 用户的 MCP Server 库 |
| `webui:config:skill-lib:{user_id}` | 用户的 Skill 库 |
| `webui:user-sessions:{user_id}` | 用户的 Session 归属记录 |

---

## 初次使用流程

1. 启动服务，以 `admin` 登录
2. **Credentials** → 添加 API Key（如 DashScope），展开后设置默认模型
3. **Agents** → 创建 Agent，编辑时选择 Credential + Model
4. **Chat** → 选中 Agent，发起对话
5. **Users** → 创建普通用户并绑定 Agent（可选）

---

## 技术栈

**前端**：Vite 6 · React 18 · TypeScript · Tailwind CSS（CDN）· TanStack Query v5 · Zustand · React Router v7 · React Hook Form + Zod · Lucide React

**后端**：FastAPI · Redis · agentscope · python-jose · passlib · httpx

**设计风格**：Apple 设计规范（SF Pro 字体栈，`#0066cc` 强调色，`#f5f5f7` 背景）
