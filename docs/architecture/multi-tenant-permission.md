# 多租户权限体系架构（v2，as-built）

> 本文描述 AgentScope Web UI 当前的多租户权限模型与实现边界，作为接手开发者的参考文档。
> 状态：v2.x 已实现（含 v2.1–v2.4 增量）。最后更新 2026-07-05。

---

## 1. 设计目标

在一个共享的 AgentScope 后端上，提供多租户隔离 + 三层角色 + 按用户分配资源的 RBAC：
- 平台运营方（agentscope 租户）创建并配置所有租户。
- 租户管理员（tenant_admin）管理本租户成员、按用户分配 agent。
- 普通成员（user）只看到被分配的资源和自己产生的运行时数据。

**核心不变量**：所有 agentscope 原生 API 调用统一用 `x-user-id: webui` 共享命名空间，webui 在其之上做自己的 RBAC 层。`backend/main.py` 用依赖覆盖把 agentscope 的 `get_current_user_id` 全局替换成 JWT 鉴权——必须带有效 webui JWT 才放行，通过后服务端覆写为共享命名空间 `"webui"`，客户端伪造的头不再可信。

---

## 2. 三层角色模型

| 角色 | 归属租户 | 能力 |
|---|---|---|
| `admin` | `agentscope`（平台租户） | 全权：创建/配置所有租户、创建任意租户的用户、看所有数据。菜单全开。 |
| `tenant_admin` | 某普通租户 | 管理本租户成员、给 `user` 成员分配 agent 子集。看本租户资源池 + 本租户所有成员的运行时数据。继承租户全池，无需 per-user 分配。 |
| `user` | 某普通租户 | 只看被分配的 agent 子集 + 自己产生的运行时数据。看不到配置菜单（agents/skills/mcp）。 |

**平台租户** `PLATFORM_TENANT_ID = "agentscope"`：在 `auth_router._bootstrap_admin` 启动时创建。admin 是其成员。平台租户的成员可创建/配置其他租户，但不能给其他（普通）租户加用户——那是该租户 tenant_admin 的职责（`_assert_can_manage_tenant` 强制）。

**多租户成员资格**：一个用户可属于多个租户，每个租户一个角色。存于 Redis HASH `webui:user:memberships:{user_id}`（{tenant_id: role}）。`UserInDB.role` / `tenant_id` 是当前**活跃**上下文。切换租户：`POST /auth/switch-tenant` → 新 JWT（携带新 active tenant + 该租户里的 role）。

---

## 3. 资源 vs 运行时数据：两种归属模型

这是最容易出错的概念分界。系统里所有受权限控制的对象分两类：

### 3.1 配置资源（tenant-pool 模型）— agents / skills / mcps / credentials
由 admin 分配给租户（`tenant.assigned_*` 池），tenant_admin 可从中给 user 分配子集。**两级**：

```
admin 配置 → tenant.assigned_{agents,mcps,skills,credentials}      （租户池）
tenant_admin 分配 → webui:user:resources:{tenant_id}:{user_id}     （个人子集 HASH {agents,mcps,skills}）
```

读侧 scope（`webui_helpers._allowed_mcps` / `_allowed_skills` / `get_my_resources`）：
- `admin` 或无租户用户 → `None`（不限，看 admin 命名空间全部）
- `tenant_admin` → 租户全池 `tenant.assigned_*`
- `user` → 个人子集 `get_user_resources(tenant_id, user.id)`

注意 v2.3：skills/mcps 库**只存 admin 命名空间**（`_config_owner` 对 admin 返回 `"admin"`），非 admin 读时从 admin 命名空间取再按 scope 过滤。agents 不在后端 scope（agentscope 原生端点），由前端 `useScopedResources` hook 过滤。

### 3.2 运行时数据（creator-owned 模型）— session / schedule / chat / knowledge
归属**创建者**，不进租户池。可见性按创建者身份流转：
- `admin` → 全部
- `tenant_admin` → 本租户所有成员的并集（管理 oversight）
- `user` → 仅自己创建的

| 数据 | 归属 key | scope 端点 | tenant_admin 是否看成员并集？ |
|---|---|---|---|
| Session | `webui:user-sessions:{user_id}` SET（`{agent_id}:{session_id}`） | `GET /webui/my-session-ids/{agent_id}` | ✅ 是 |
| Schedule | `webui:user-schedules:{user_id}` SET | `GET /webui/my-schedule-ids` | ✅ 是 |
| Knowledge Base | `webui:config:knowledge-base:{owner}`（`_config_owner`：admin→`"admin"`，非 admin→`user.id`） | list 直接读 owner 命名空间 | ❌ 否（见 §10 已知边界） |
| Chat | 随 session 走（无独立归属） | — | — |

**写入时机**：session 创建后前端调 `POST /webui/session-track` 记录归属；schedule 创建后 `schedule_router.create_schedule` 自动 `sadd` 记录。KB 创建时按 `_config_owner` 落到对应命名空间。

**注意 KB 的偏差**：session/schedule 严格遵循"tenant_admin 看本租户成员并集"，但 KB 用 `_config_owner`（非 admin→`user.id`），所以 tenant_admin 只看到**自己**的 KB，看不到成员的。这是已知未对齐项（§10）。

`run_schedule_now` / `test_saved_mcp` 等 by-id 调用额外做 `_schedule_visible_to` / `_allowed_mcps` 校验（defense-in-depth，因为 list 已隐藏不可见项，但 by-id 调用需独立把关）。

---

## 4. 菜单可见性

`webui_helpers.resolve_menu_permissions(user)` 决定侧边栏：
- `admin` → `ALL_MENU_PERMS`（全部 11 项）
- `tenant_admin` → 本租户 `tenant.menu_permissions`
- `user` → 本租户 `tenant.menu_permissions` **减去** `{agents, skills, mcp}`（配置组）
- 无租户 legacy 用户 → `_DEFAULT_MENU_PERMS`（仅 workspace 组）

`ALL_MENU_PERMS = [chat, sessions, knowledge, schedules, agents, skills, mcp, credentials, logs, settings, users]`。
前端 `store/auth.ts` 的 `hasMenu(perm)`：admin bypass，否则查 `menuPermissions` 数组（来自 `/auth/me`，缓存在 localStorage）。AppLayout 按 group 渲染，group 内无可见项则整组隐藏——所以 `user` 看不到 Configuration 组。

> ⚠️ 菜单是后端 `/auth/me` 返回、前端缓存的。改了 `resolve_menu_permissions` 后，**已登录会话需重新登录或前端重 fetch `/auth/me`** 才生效。

`UsersTab` 的"添加用户"按钮额外做前端 role 门控（`admin`/`tenant_admin`），即使用户菜单含 `users` 项也看不到添加按钮。普通用户在 Users 页只看到自己那一条（`list_users` 对 member 返回 `[caller]`）。

---

## 5. 关键 Redis key 命名空间

所有 key 必须经 `webui_helpers._xxx_key()` 生成，禁止跨文件内联 `f"webui:..."`。

| 用途 | key 模式 | 生成函数 |
|---|---|---|
| 用户记录 | `webui:user:{user_id}` | — |
| 多租户成员资格 | `webui:user:memberships:{user_id}` (HASH) | `_user_memberships_key` |
| 用户→租户反查 | `webui:user:tenant:{user_id}` | `_user_tenant_key` |
| 个人资源子集 | `webui:user:resources:{tenant_id}:{user_id}` (JSON) | `_user_resources_key` |
| 个人 session 集 | `webui:user-sessions:{user_id}` (SET) | `_session_key` |
| 个人 schedule 集 | `webui:user-schedules:{user_id}` (SET) | `_schedule_key` |
| 租户记录 | `webui:tenant:{tenant_id}` (JSON) | `_tenant_key` |
| 租户成员集 | `webui:tenant:members:{tenant_id}` (SET) | `_tenant_members_key` |
| 租户 admin 集 | `webui:tenant:admins:{tenant_id}` (SET) | `_tenant_admins_key` |
| 全部租户集 | `webui:tenant:all` (SET) | `_tenant_all_key` |
| MCP 库（仅 admin） | `webui:config:mcp-lib:admin` | `_mcp_key` |
| skill-dirs（仅 admin） | `webui:config:skill-dirs:admin` | `_skill_dirs_key` |
| skill 禁用集（仅 admin） | `webui:config:skill-disabled:admin` | `_skill_disabled_key` |
| KB（owner-scoped） | `webui:config:knowledge-base:{owner}` | `_knowledge_base_key` |
| agent 级配置 | `webui:config:agent-{mcps,skills,questions,security,model}:{agent_id}` | `_agent_*_key` |
| 用户/agent 默认模型 | `webui:config:{default-model:{user_id},agent-model:{agent_id}}` | — |

`_config_owner(user)`：admin → `"admin"`，非 admin → `user.id`。MCP/skill 库 v2.3 后**始终读 admin 命名空间**，不再按 owner 分库。

---

## 6. 权限守卫层

| 守卫 | 定义于 | 用途 |
|---|---|---|
| `current_user` | `auth_router` | JWT 解码 → `UserInDB`（所有受保护端点） |
| `admin_required` | `auth_router` | 仅 admin（旧式，待迁移） |
| `require_platform_access` | `permission_guard` | 调用方必须是 agentscope 平台租户成员（创建/配置租户） |
| `require_feature(name)` | `permission_guard` | 按 active role/tenant 查菜单权限（如 `users`） |
| `_assert_can_manage_tenant(caller, tid)` | `tenant_router` | 管理租户成员：admin 任意 / 平台成员管平台 / tenant_admin 管本租户 |
| `require_agent_access` | `agent_config_router` | 三层：admin / tenant_admin 池内 / member 已分配 / legacy bound |
| `effective_permission_mode(agent_id)` | `webui_helpers` | per-agent 安全等级 → agentscope PermissionMode（PRODUCTION_MODE 下 standard→workspace clamp，显式 open 仍生效） |

**legacy 兜底**（v2.4）：`get_user_member_role` 只读 memberships HASH。迁移前老用户（有 `tenant_id` 无 HASH 记录）会命中 403。两处修复：
1. `_assert_can_manage_tenant`：HASH 缺记录但 `caller.tenant_id == tenant_id` 且 `caller.role in (tenant_admin, admin)` 时，信任活跃上下文 + `link_user_to_tenant` 回填。
2. `login`：legacy 用户登录时回填 membership。

---

## 7. 各角色能力矩阵

| 能力 | admin | tenant_admin | user |
|---|---|---|---|
| 创建租户 / 配置租户资源池 / 菜单 | ✅（任意租户） | ❌ | ❌ |
| 创建用户 | ✅（任意租户+role） | ✅（仅本租户，role∈{tenant_admin,user}；建 user 须分 agent 子集） | ❌ |
| 给成员分配 agent 子集 | ❌（admin 在租户层配池，不分个人） | ✅（`MemberResourcesDialog`，仅对 role=user 成员） | ❌ |
| 切换租户 | ✅ | ✅（多成员资格时） | ✅ |
| 看 Configuration 菜单（agents/skills/mcp） | ✅ | ✅（若租户 menu 含） | ❌ |
| 看 Users 菜单 + 添加用户按钮 | ✅ | ✅ | 看菜单（自看）/ 无添加按钮 |
| MCP/Skill 库 写（注册/启停/编辑/安装） | ✅ | ❌（只读池） | ❌（只读子集） |
| stdio MCP 注册 | ✅（PRODUCTION_MODE 禁） | ❌ | ❌ |
| 看 sessions/schedules | 全部 | 本租户成员并集 | 仅自己 |
| KB | admin 命名空间 | 自己命名空间 | 自己命名空间 |
| agent 安全等级 PUT | ✅ | ❌ | ❌ |

---

## 8. 数据流：发消息（chat）全链路

```
前端 PATCH session（写 chat_model_config）
  → POST /webui/session-workspace（注入 agent 绑定的 MCP+Skill，透传 JWT）
    → effective_permission_mode(agent_id) PATCH session 写 PermissionMode
  → POST /chat/（触发 agentscope，JWT 鉴权）
  → SSE 直连后端 /api/sessions/.../stream（绕过 Vite proxy，否则 gzip 缓冲 SSE）
```
- session 必须有 `chat_model_config`，否则后端 200 但静默失败、stream 为空。
- `session-workspace` 从 admin 命名空间取 MCP（非 admin 也能拿到 admin 池里的、agent 绑定的 MCP）；PRODUCTION_MODE 下过滤 stdio MCP。
- 内部 httpx 调用（`/workspace/*`、`/sessions/*`）必须透传 `Authorization` 头，否则 401。

---

## 9. v2.x 演进时间线

- **v2.0**（2026-07-04）：三层模型核心。admin 归 agentscope 平台租户；memberships HASH；两级资源；租户切换。
- **v2.1**（2026-07-05）：用户创建流程。admin 创建用户不分资源；tenant_admin 建 user 须内联分 agent 子集。普通 tenant_admin 加只读 "Tenant" tab。
- **v2.2**（2026-07-05）：per-user 资源配置收窄到 **agents only**（mcps/skills 由租户池统管，UI 不再单独配；保存时保留已有 mcps/skills）。tenant_admin 不需 per-user 分配。i18n 严格类型修复。
- **v2.3**（2026-07-05）：skills/mcps 库改为 **admin-curated**，租户成员只读看池。后端 `get_mcp_lib`/`get_skill_lib`/`get_skill_dirs` 始终读 admin 命名空间 + 按 scope 过滤。**撤销 v1 决策 #7**（远程 MCP 全员可用 → 库管理 admin-only）。
- **v2.4**（2026-07-05）：
  - **schedule 改 creator-owned**（同 session/chat/knowledge），新增 `_schedule_key` + `/webui/my-schedule-ids` + `run-now` scope 校验；前端 list 按 scope 过滤。
  - **修 MemberResourcesDialog 保存无反应**：加 `onError` 错误提示；根因 legacy tenant_admin 403 → `_assert_can_manage_tenant` 兜底 + `login` 回填 membership。
  - **member 菜单裁剪**：`resolve_menu_permissions` 对 role=user 剥离 `{agents,skills,mcp}`；添加用户按钮 role 门控。

---

## 10. 已知边界 / 待办

- tenant_admin 保存某 agent 时，若其 mcp/skill 绑定超出租户池，`set_agent_mcps` 400（scoped picker 看不到越界项无法移除）。需后端 `set_agent_*` 改成"保留越界已有项、只校验增量"。
- `admin_required` → `require_feature` 批量迁移（mcp/skill/schedule/redis_browser router 仍 admin-only）。
- KB list 的数据 scope：当前 owner-scoped（tenant_admin 只看自己的 KB），未对齐 session/schedule 的"租户成员并集"模型。
- 组织结构 Phase 4（`Tenant.org_structure` 字段已预留，未接线）。
- PRODUCTION_MODE 下 `standard` → `workspace` clamp；显式 `open`(bypass) 仍生效（admin 对该 agent 的显式信任）；stdio MCP 注入仍被过滤。
- 网络层隔离（防 agent curl 外网）需基础设施层（Docker network policy / iptables）配置。

---

## 11. 相关文件速查

| 层 | 文件 |
|---|---|
| 入口 + 依赖覆盖 + 启动迁移 | `backend/main.py` |
| 认证 / memberships / switch-tenant / me / login 回填 | `backend/auth_router.py` |
| 共享工具：key helpers、`_config_owner`、`resolve_menu_permissions`、`_allowed_mcps/skills`、`effective_permission_mode`、`get/set_user_resources`、`_schedule_key` | `backend/webui_helpers.py` |
| 权限守卫 | `backend/permission_guard.py` |
| 租户 CRUD / 成员 / per-user 资源 / `_assert_can_manage_tenant` | `backend/tenant_router.py` |
| 用户 CRUD（数据 scope） | `backend/users_router.py` |
| agent 三层访问 + 绑定校验 | `backend/agent_config_router.py` |
| session 归属 + workspace 注入 | `backend/session_router.py` |
| schedule 创建者归属 + scope | `backend/schedule_router.py` |
| MCP 库（admin 命名空间 + scope 过滤） | `backend/mcp_router.py` |
| Skill 库（admin 命名空间 + scope 过滤） | `backend/skill_router.py` |
| KB（owner-scoped） | `backend/knowledge_base_router.py` |
| 前端 auth store（menu/hasMenu/switchTenant） | `frontend/src/store/auth.ts` |
| 前端 scope hook | `frontend/src/hooks/useScopedResources.ts` |
| 侧边栏分组 + 租户切换器 | `frontend/src/layouts/AppLayout.tsx` |
| 用户管理 + 添加按钮门控 | `frontend/src/features/users/UsersTab.tsx` |
| 成员资源分配对话框（onError） | `frontend/src/features/users/MemberResourcesDialog.tsx` |
| schedule 列表 scope 过滤 | `frontend/src/api/schedules.ts` + `frontend/src/features/schedules/SchedulesPage.tsx` |
