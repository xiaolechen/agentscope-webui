# AgentScope Web UI — Claude 开发指南

本文件面向在此项目上工作的 AI 助手（Claude）。

---

## 项目结构

```
agentscope-webui/
│
├── backend/                        # Python 后端（FastAPI）
│   ├── main.py                     # 应用入口：注册路由、配置日志、workspace 路径、JWT 依赖覆盖、启动迁移
│   ├── auth_router.py              # JWT 认证：sha256_crypt 密码哈希；webui_user_id 依赖覆盖；login 回填 legacy membership；/auth/me、/auth/switch-tenant
│   ├── permission_guard.py         # 权限守卫：require_platform_access、require_feature（按 active role/tenant 查菜单权限）
│   ├── tenant_router.py            # 租户 CRUD / 成员管理 / per-user 资源分配；/webui/tenants/*；_assert_can_manage_tenant
│   ├── users_router.py             # 用户 CRUD（数据 scope：admin 全量 / tenant_admin 本租户 / member 自己）
│   ├── mcp_router.py               # MCP 库（admin 命名空间 + scope 过滤；写操作 admin-only）；/webui/mcp-lib/*
│   ├── skill_router.py             # Skill 库（admin 命名空间 + scope 过滤；写操作 admin-only）；/webui/skill-lib/*、/webui/skill-dirs
│   ├── session_router.py           # Session 归属（creator-owned）+ workspace 注入（MCP+Skill+PermissionMode）
│   ├── schedule_router.py          # Schedule 创建代理（creator-owned 归属 + scope）；/webui/schedule、/webui/my-schedule-ids
│   ├── agent_config_router.py      # Agent 级配置（模型/MCP绑定/Skill绑定/预设问题）；require_agent_access 三层
│   ├── model_router.py             # 用户/Agent 模型配置；/webui/me/default-model、/webui/agent-model/*
│   ├── knowledge_base_router.py    # KB（owner-scoped，creator-owned）；/webui/knowledge-base/*
│   ├── redis_browser_router.py     # Redis 数据浏览器（Admin 只读）；/webui/redis/keys、/webui/redis/key
│   ├── webui_helpers.py            # 共享工具：Redis key helpers、_config_owner()、resolve_menu_permissions()、_allowed_mcps/_allowed_skills、user_can_access_agent()、effective_permission_mode()、PRODUCTION_MODE
│   └── pyproject.toml              # 依赖声明（文档用途，实际安装在 .venv/）
│
├── frontend/                       # React 前端（Vite + TypeScript）
│   ├── src/
│   │   ├── api/                    # axios 封装层（client.ts 自动注入 JWT + x-user-id: webui）
│   │   │   ├── client.ts           # ← 修改 Header 逻辑的唯一入口
│   │   │   ├── tenants.ts          # 租户/成员/per-user 资源接口
│   │   │   └── webui.ts            # Webui 专属接口（模型配置、MCP 库编辑/测试、Skill 安装、预设问题、Redis 浏览）
│   │   ├── features/               # 页面模块（每个子目录 = 一个路由页面）
│   │   │   └── chat/
│   │   │       ├── ChatPage.tsx    # 发送逻辑：PATCH session → session-workspace → POST /chat/ → SSE start()；空状态展示预设问题
│   │   │       └── useSSEStream.ts # SSE 核心：fetch 直连后端（绕过 Vite proxy）
│   │   ├── hooks/useScopedResources.ts  # 资源 scope hook（agents 前端过滤，因 agentscope 原生端点不 scope）
│   │   ├── store/auth.ts           # Zustand：token、role、tenantId、memberships、menuPermissions、hasMenu()、switchTenant()
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
- 三层 RBAC：`admin`（平台租户 `agentscope`）/ `tenant_admin`（普通租户）/ `user`（成员）
- 所有 agentscope API 调用统一用 `x-user-id: webui`（共享命名空间），webui 在其上叠加自己的 RBAC
- SSE 流式输出**绕过 Vite proxy** 直连后端（Vite compress 中间件会缓冲 SSE）

> **完整权限架构**见 [`docs/architecture/multi-tenant-permission.md`](docs/architecture/multi-tenant-permission.md)（三层模型、两种归属模型、菜单可见性、Redis key 命名空间、能力矩阵、v2.x 演进）。本文件只列开发要点。

---

## 多租户权限模型（要点）

**两种归属模型**（最容易出错的概念分界）：

| 模型 | 对象 | 归属 |
|---|---|---|
| **配置资源**（tenant-pool） | agents / skills / mcps / credentials | admin 配租户池 `tenant.assigned_*` → tenant_admin 给 user 分个人子集 `webui:user:resources:{tenant}:{user}` |
| **运行时数据**（creator-owned） | session / schedule / chat / knowledge | 归创建者；admin 看全部、tenant_admin 看本租户成员并集、user 看自己 |

**成员资格**：一个用户可属多个租户，每租户一个角色，存 `webui:user:memberships:{user_id}` HASH（{tenant_id: role}）。`UserInDB.role`/`tenant_id` 是活跃上下文。切换租户 `POST /auth/switch-tenant` → 新 JWT。

**菜单可见性**：`resolve_menu_permissions(user)` — admin 全开；tenant_admin = 租户 `menu_permissions`；**user 剥离 `{agents,skills,mcp}`（看不到 Configuration 组）**；无租户 legacy = workspace 默认集。前端 `hasMenu()` 据 `/auth/me` 返回的 `menu_permissions`（localStorage 缓存）渲染。

**MCP/Skill 库**（v2.3）：库是 **admin-curated**——只存 `"admin"` 命名空间，写操作（注册/编辑/启停/删除/安装/未保存测试）**全部 admin-only**；非 admin 读时从 admin 命名空间取再按 `_allowed_mcps`/`_allowed_skills` scope 过滤（tenant_admin=租户池、member=个人子集）。

**Agent 访问**：`user_can_access_agent(user, agent_id)`（`webui_helpers.py`）是唯一真值源——admin 直通、tenant_admin 看租户池、member 看个人子集、legacy 看 `bound_agent_ids`。`require_agent_access` 和 `track_session` 共用，**不要**再单独查 `bound_agent_ids`（它只在创建时写一次，per-user 重新分配后不会更新）。

**Legacy 兜底**：`get_user_member_role` 只读 memberships HASH。迁移前老用户（有 `tenant_id` 无 HASH 记录）由 `_assert_can_manage_tenant` 兜底 + `login` 回填 membership。

---

## 关键技术决策（不要轻易改动）

### 1. SSE 直连后端
`src/features/chat/useSSEStream.ts` 中的 `getBackendOrigin()` 会把 `/api/sessions/.../stream` 转换成后端公网 URL，绕过 Vite proxy。

**原因**：Vite dev server 的 gzip 中间件缓冲了 SSE 响应体，导致事件无法实时到达客户端。

**不要**把流式请求改回走 `/api/` proxy。

### 2. Chat 发消息顺序
```
PATCH session（注入 model config） → POST /webui/session-workspace（注入 MCP+Skill） → POST /chat/（触发）→ start()（连流）
```

**原因**：agentscope 的 stream 端点在 session 未激活时立即关闭连接（只返回 `:` keepalive）。必须先触发 chat，再连流。session-workspace 把 agent 绑定的 MCP/Skill 注入到 workspace，否则 agent 调用不到工具。

### 3. Session 必须有 chat_model_config
每次发消息前都会 PATCH session 写入模型配置（`sessionsApi.update(sid, agentId, { chat_model_config })`），确保后端能处理请求。

**原因**：没有 model config 的 session，后端接受 chat trigger（200）但静默失败，stream 为空。

### 4. x-user-id 是固定值，但 agentscope 端点已 JWT 鉴权
`src/api/client.ts` 的拦截器固定发送 `x-user-id: webui`，**且所有请求都带 `Authorization: Bearer <JWT>`**。

**原因**：所有资源（Agent、Session、Credential）在 agentscope 里共享同一个命名空间，webui 自己的 RBAC 层在上面做权限控制。

**关键**：agentscope 原生的 `get_current_user_id`（`agentscope/app/deps.py`）只检查 `X-User-ID` 头非空——任何人都能伪造。`backend/main.py` 用 `app.dependency_overrides[get_current_user_id] = auth_router.webui_user_id` **全局替换成 JWT 鉴权**：必须带有效 webui JWT 才放行，通过后服务端覆写为共享命名空间 `"webui"`（客户端伪造的头不再可信）。这保护了 `/credential/*`、`/sessions/*`、`/chat/`、`/workspace/*`、`/schedule/*`、`/agent/*`、`/knowledge-base/*`。新增 agentscope 端点默认也受保护。

后端默认绑 `127.0.0.1`（`BACKEND_HOST` 环境变量，默认 loopback）；需要外网暴露时设 `BACKEND_HOST=0.0.0.0` 且必须放反代后面。

### 5. 配置命名空间与 `_config_owner`
`webui_helpers.py` 的 `_config_owner(user)` 对 admin 返回固定字符串 `"admin"`，对非 admin 返回 `user.id`。用于 **KB** 等 owner-scoped 配置（`webui:config:knowledge-base:{owner}`）。

**注意（v2.3 后）**：MCP 库 / skill-dirs / skill-disabled **不再按 owner 分库**——它们始终存 `"admin"` 命名空间，非 admin 读时按 scope 过滤（见上文"多租户权限模型"）。`_config_owner` 对这三组 key 仅在 admin 写路径上返回 `"admin"`，实际等价。Agent 级配置（`agent-mcps`/`agent-skills`/`agent-questions`）按 `agent_id` 命名，跨用户共享，由 `require_agent_access` 把关。

`backend/main.py` 启动时调 `migrate_admin_shared_namespace()` 幂等迁移：把每个 admin 旧的 per-user key 合并进 `admin` 共享 key 后删除。安全可重复运行。

### 6. 内部调用透传 JWT
`apply_session_workspace` / `inject_session_skill` 用 `httpx` 调 agentscope 原生 `/workspace/*` 端点。这些端点已 JWT 鉴权（决策 4），所以必须把请求的 `Authorization` 头透传过去，否则返 401。两个函数都从 `request: Request` 取 `Authorization` 加到 `headers`。

**不要**在内部 httpx 调用里省略 Authorization 头。

### 7. MCP 认证是服务端密钥 + 库 admin-only
`McpDef` 的 `auth_token` 是服务端密钥（存 Redis 明文，与 credential 同级）。`GET /webui/mcp-lib`、`POST /webui/mcp-lib`、`PUT /webui/mcp-lib/{name}` 响应里 **`auth_token` 被剥离**（永远不下发浏览器）。编辑时若 `auth_token` 留空，保留原值；重测走 `POST /webui/mcp-lib/test/{name}` 按名加载已存 token。

**库管理 admin-only（v2.3）**：MCP/Skill 库的注册/编辑/启停/删除/安装/未保存测试全部 `admin_required`。非 admin 只读看自己 scope 内的池。stdio MCP 仍仅 admin（PRODUCTION_MODE 下完全禁止 stdio 注入）。

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
/auth/*        # JWT 登录 + 租户切换（auth_router.py）
  /auth/login                    # 登录（form-encoded；回填 legacy membership）
  /auth/switch-tenant            # 切换活跃租户（?target_tenant_id=，返新 JWT）
  /auth/me                       # 当前用户 + memberships + active_tenant_id + menu_permissions
/users/*        # 用户 CRUD（数据 scope：admin 全量 / tenant_admin 本租户 / member 自己）
/webui/tenants/*  # 租户管理（tenant_router.py）
  /webui/tenants                 # 租户 CRUD（require_platform_access：仅 agentscope 平台成员）
  /webui/tenants/my-tenant       # 自己的租户（任意成员可读，供非 admin 过滤 agent picker）
  /webui/tenants/my-resources    # 当前有效资源集（admin/tenant_admin=租户池；member=个人子集）
  /webui/tenants/{id}/members           # 成员列表 / 添加 / 删除 / 改角色（_assert_can_manage_tenant）
  /webui/tenants/{id}/members/{uid}/resources  # GET/PUT per-user 资源子集（须 ⊆ 租户池）
/webui/*       # Webui 数据层（mcp/skill/session/schedule/agent_config/model/kb router）
  /webui/me/default-model          # 用户默认模型（按 user.id）
  /webui/agent-model/{id}          # Agent 模型配置（按 agent_id）
  /webui/agent-mcps/{id}           # Agent 绑定的 MCP 名列表
  /webui/agent-skills/{id}         # Agent 绑定的 skill 路径列表
  /webui/agent-skills-full/{id}    # 同上，但解析成 {name,path,is_enabled}（非 admin 也能用，不依赖调用方 skill-dirs）
  /webui/agent-questions/{id}      # Agent 预设问题（string[]，最多 5）
  /webui/agent-security/{id}       # Agent 安全等级（GET 任何人；PUT admin only）
  /webui/cred-models/{id}          # Credential 自定义模型名
  /webui/test-model                # POST 模型连通性测试（body: {credential_id, model_name}）
  /webui/mcp-lib                   # MCP 库（admin 命名空间 + scope 过滤；写操作 admin-only；auth_token 剥离）
  /webui/mcp-lib/{name}            # PUT 编辑（admin；name 不可变）/ PATCH 启停（admin）/ DELETE（admin）
  /webui/mcp-lib/test              # POST 临时测试（admin，带表单里的 token）
  /webui/mcp-lib/test/{name}       # POST 按名重测（admin/member 可测自己池内；加载服务端 token）
  /webui/skill-dirs                # Skill 根目录（admin 命名空间；POST/DELETE admin-only）
  /webui/skill-lib                 # Skill 库扫描结果（admin 命名空间 + scope 过滤）
  /webui/skill-lib/toggle          # 启停 skill（admin-only）
  /webui/skill-lib/install         # npx skills add 安装（admin only，目标须是已注册 skill-dir）
  /webui/session-workspace         # 注入 agent 的 MCP+Skill 到 session workspace（透传 JWT）
  /webui/session-skill             # 单 skill 注入/移除活跃 session（透传 JWT）
  /webui/session-track             # Session 归属记录（user_can_access_agent 校验）
  /webui/my-session-ids/{id}       # 用户可见的 Session ID 列表（admin=all/tenant_admin=租户并集/member=自己）
  /webui/schedule                  # Schedule 创建代理（自动注入 model config + 记录 creator 归属）
  /webui/my-schedule-ids           # 用户可见的 Schedule ID 列表（同 session scope 规则）
  /webui/schedule/{id}/run         # 立即运行（_schedule_visible_to 校验）
  /webui/knowledge-base/*          # KB（owner-scoped，creator-owned）
  /webui/restart                   # 重启后端（Admin only）
/webui/redis/*   # Redis 数据浏览器（Admin 只读，redis_browser_router.py）
  /webui/redis/keys                # key 列表（cursor 分页）
  /webui/redis/key                 # 单 key 数据（分页）
/agent/*       # agentscope 原生 Agent API（JWT 鉴权）
/sessions/*    # agentscope 原生 Session API（JWT 鉴权）
/credential/*  # agentscope 原生 Credential API（JWT 鉴权）
/schedule/*    # agentscope 原生 Schedule API（JWT 鉴权）
/workspace/*   # agentscope 原生 Workspace API（JWT 鉴权）
/chat/         # agentscope 原生 Chat trigger（JWT 鉴权）
/logs/*        # 日志查看（自定义）
```

---

## 编码规范

### AgentScope API 边界
- 禁止修改 agentscope 源码（含 `../agentscope/` editable install）
- 只使用公开 API：`agentscope.app` / `agentscope.mcp` / `agentscope.permission`
- 例外：`agentscope.app.deps.get_current_user_id`（依赖覆盖的必要内部引用，已标注，不作先例）
- Agent 生命周期（创建/Session/Chat）通过 REST API（httpx）管理，不直接 import agentscope agent 类

### 开闭原则（新增不修改）
- 新业务功能 → 新 router 文件，在 `main.py` 添加 `import` + `include_router`
- 跨 router 共享工具 → 追加到 `webui_helpers.py`（key helper、HTTP helper、常量）
- 同一 router 只放同一业务域（MCP/Skill/Session/Agent/Model 各自独立）

### Redis 规范（性能关键）
- 连接：统一用 `auth_router._r()`，禁止在任何 router 文件中 `new redis.Redis()`
- Key 字符串：所有 key 必须通过 `webui_helpers.py` 的 `_xxx_key()` 函数生成；新 key 模式须先添加对应 helper 函数，禁止跨文件内联 `f"webui:config:..."` 字面量
- Pipeline：连续 2+ 个 Redis 命令必须合并为 `pipeline()`
- 批量扫描：用 `scan_iter(match=...)`，禁用 `KEYS *`

### 错误日志规范
- `WARNING`：预期错误（403/404/rate-limit/JWT 失效/权限拒绝）
- `ERROR`：非预期错误（Redis 异常/httpx 网络失败）
- 必含字段：操作者（user/admin）、资源 id、HTTP status、响应体前 200 字节
- 禁止：`except Exception: pass`（至少加 `logger.debug` 或 `raise`）

### 不可变性
- 禁止就地修改 Pydantic model 字段（如 `user.role = "admin"`）
- 必须使用 `model.model_copy(update={...})`

### 安全等级约束

**Per-agent 安全等级**（`webui:config:agent-security:{agent_id}`，admin 写/任何授权用户读）：

| 等级 Key | PermissionMode | 限制说明 |
|---|---|---|
| `strict` | `explore` | 只读命令；禁止 `ip a`/`curl`/`rm`/写文件/脚本执行 |
| `workspace` | `accept_edits` | workspace 目录内读写；路径遍历拒绝（默认） |
| `standard` | `default` | 危险操作 ASK（无人值守时拒绝） |
| `open` | `bypass` | 无约束；仅受信任/开发环境 |

- 默认等级：`workspace`（agent 未配置时）
- `PRODUCTION_MODE=true` 时：`standard` 被 clamp 到 `workspace`；**显式 `open`(bypass) 仍生效**——这是 admin 对该 agent 的显式信任授权（如 llm-wiki-agent 必须写 KB 路径，而 agentscope 未暴露把 KB 路径注册为允许工作目录的 API，`workspace` 模式下写 KB 路径会 ASK 导致停泊崩溃）。`open` 由 admin 专享（PUT `/webui/agent-security` admin-only），所以尊重它是 admin 的信任决策而非默认。stdio MCP 注入仍被过滤。
- 逻辑在 `webui_helpers.py:effective_permission_mode(agent_id)` 中集中实现
- `session_router.py:apply_session_workspace` 每次发消息前调用此函数 PATCH session
- 网络层隔离（防止 agent curl 外网）需在基础设施层配置（Docker network policy 或 iptables）

### 多租户扩展点
- 权限模型三层：`admin`（平台租户 `agentscope`）/ `tenant_admin`（普通租户）/ `user`（成员）。详见 [`docs/architecture/multi-tenant-permission.md`](docs/architecture/multi-tenant-permission.md)。
- `_config_owner(user)`（`webui_helpers.py`）：admin → `"admin"`，其余 → `user.id`。用于 KB 等 owner-scoped 配置。**不要**用它给 MCP/skill 分库（v2.3 后库统一在 admin 命名空间）。
- 资源 scope 读真值源：`_allowed_mcps`/`_allowed_skills`（库列表用）、`get_user_resources`（个人子集）、`user_can_access_agent`（agent 访问）。新增 scope 检查优先复用这些，勿另查 `bound_agent_ids`（陈旧）。
- 数据 scope（creator-owned）：session/schedule 用 `my-session-ids`/`my-schedule-ids` 端点返回 ID 集，前端过滤；by-id 调用（run/delete/test）须独立 `_xxx_visible_to` 校验。
- 菜单：`resolve_menu_permissions(user)` 是后端真值源；前端 `hasMenu()` 据此渲染。新增菜单项须同时加到 `ALL_MENU_PERMS` 和 `Tenant.menu_permissions`。
- 新权限级别实现为新 FastAPI `Depends` 函数（如 `require_feature`、`require_platform_access`），不修改 `current_user`/`admin_required`。
- 若需组织/部门级权限，在 `_config_owner` 或 `get_user_member_role` 层加新分支。

### 日志分析（每日建议）
```bash
# 高频警告类型（安全事件趋势）
grep "WARNING" logs/backend/backend.log | grep -oP "(?<=WARNING  \w{1,30}: )\S+" | sort | uniq -c | sort -rn
# 最近 ERROR
grep "ERROR" logs/backend/backend.log | tail -50
# 登录失败 IP（暴力破解侦测）
grep "login failed" logs/backend/backend.log | grep -oP "ip=\S+" | sort | uniq -c | sort -rn
# 慢接口（>500ms）
grep "request:" logs/backend/backend.log | awk '$6 > 500' | sort -k6 -rn | head -20
```

---

## 常见陷阱

| 陷阱 | 说明 |
|---|---|
| Workspace `.mcp` 文件 | 修改 `default_mcps` 后，需手动删除 `workspaces/*/` 下的 `.mcp` 文件，否则旧配置仍生效 |
| 新 session 响应慢 | 通常是 workspace 初始化 MCP 导致。确认 `backend/main.py` 的 `default_mcps = []` |
| SSE 无输出 | 检查：1) Session 有 model config？2) `x-user-id` header 发送了？3) SSE URL 直连后端（非 proxy）？4) agent 的 MCP/Skill 已通过 session-workspace 注入？ |
| 422 on stream | 大概率是 JWT 缺失（`Authorization: Bearer`），stream 端点现在 JWT 鉴权（依赖 override） |
| 401 on /workspace/* | 内部 httpx 调用没透传 Authorization 头。`apply_session_workspace`/`inject_session_skill` 必须从 request 取 JWT 转发 |
| 模型调用 409 | Session 正在处理中，用户重复发消息。前端应在 `sseState.streaming = true` 时禁用发送 |
| 非 admin `/` 唤不起 skill | 对话页 skill picker 须用 `getAgentSkillsFull`（按绑定路径解析），不能用 `getSkillLib`（依赖调用方 skill-dirs，非 admin 为空） |
| MCP "Not authenticated" | 旧 MCP 条目无 auth 字段（迁移自旧版）。进 MCP 页编辑，补 auth_type + auth_token |
| admin 看不到彼此 MCP/Skill | 已通过共享命名空间解决（owner=`"admin"`）。若仍为空，检查 `migrate_admin_shared_namespace()` 是否执行、旧 per-user key 是否已合并删除 |
| MemberResourcesDialog 保存无反应 | 旧版 save mutation 无 `onError`，4xx 静默失败。已加错误提示；若仍 403，多半是 legacy tenant_admin 无 membership 记录——`login` 回填 + `_assert_can_manage_tenant` 兜底已修 |
| 租户 admin 看不到成员的 KB | KB 是 owner-scoped（`_config_owner`=user.id），tenant_admin 只看自己的——已知与 session/schedule 的"成员并集"模型不一致（见架构文档 §10） |
| 菜单改了不生效 | `resolve_menu_permissions` 改后，已登录会话需重新登录或前端重 fetch `/auth/me`（menuPermissions 缓存在 localStorage） |
| agent 重分配后 member 403 | `track_session`/`require_agent_access` 必须用 `user_can_access_agent`，不能查陈旧的 `bound_agent_ids` |

---

## 文件说明

```
backend/main.py                  # 后端入口：注册全部 router + JWT 依赖覆盖 + 日志配置 + 启动迁移
backend/auth_router.py           # 用户认证，sha256_crypt 哈希；webui_user_id 依赖覆盖；login 回填 legacy membership；/auth/me、/auth/switch-tenant
backend/permission_guard.py      # 权限守卫：require_platform_access、require_feature
backend/tenant_router.py         # 租户 CRUD / 成员管理 / per-user 资源；_assert_can_manage_tenant（legacy 兜底）
backend/users_router.py          # 用户 CRUD（数据 scope：admin 全量 / tenant_admin 本租户 / member 自己）
backend/mcp_router.py            # MCP 库（admin 命名空间 + scope 过滤；写操作 admin-only；PRODUCTION_MODE 拒绝 stdio）
backend/skill_router.py          # Skill 库（admin 命名空间 + scope 过滤；写操作 admin-only）
backend/session_router.py        # Session 归属（creator-owned）+ workspace 注入（MCP+Skill+PermissionMode）
backend/schedule_router.py       # Schedule 创建代理（creator-owned 归属 + my-schedule-ids scope）
backend/agent_config_router.py   # Agent 级配置（require_agent_access 三层、MCP/Skill 绑定校验、预设问题、安全等级）
backend/model_router.py          # 用户/Agent 模型配置；POST /webui/test-model 模型连通性测试
backend/knowledge_base_router.py # KB（owner-scoped，creator-owned）
backend/redis_browser_router.py  # Redis 数据浏览器（Admin 只读）
backend/webui_helpers.py         # 共享工具：Redis key helpers、_config_owner()、resolve_menu_permissions()、_allowed_mcps/_allowed_skills、user_can_access_agent()、effective_permission_mode()、PRODUCTION_MODE

frontend/src/api/client.ts    # axios 实例，拦截器注入 Authorization + x-user-id
frontend/src/api/tenants.ts   # 租户/成员/per-user 资源接口
frontend/src/api/webui.ts     # webui 专属接口（模型配置、MCP 库编辑/测试、Skill 安装、预设问题、Redis 浏览等）
frontend/src/hooks/useScopedResources.ts  # 资源 scope hook（agents 前端过滤）
frontend/src/features/chat/useSSEStream.ts  # SSE 核心（直连后端，fetch + ReadableStream）
frontend/src/features/chat/ChatPage.tsx     # Chat 主页（发送逻辑、模型检查、resume、预设问题 chips、skill picker）
frontend/src/features/agents/AgentsPage.tsx # Agent CRUD + 配置（含预设问题编辑、MCP/Skill 绑定）
frontend/src/features/mcp/McpPage.tsx       # MCP 库（注册/编辑/测试/启停，写操作 admin-only）
frontend/src/features/skills/SkillsPage.tsx # Skill 库（写操作 admin-only，非 admin 只读徽章）
frontend/src/features/users/UsersTab.tsx    # 用户管理（添加按钮 role 门控）
frontend/src/features/users/MemberResourcesDialog.tsx  # tenant_admin 给 member 分配 agent 子集（onError 错误提示）
frontend/src/features/users/TenantViewTab.tsx          # 租户 admin 只读查看本租户资源
frontend/src/features/users/TenantDetailDialog.tsx     # 平台 admin 编辑租户配置
frontend/src/layouts/AppLayout.tsx          # 侧边栏分组 + TenantSwitcher
frontend/src/store/auth.ts    # Zustand auth store（token、role、tenantId、memberships、menuPermissions、hasMenu、switchTenant）
```
