# GPU Bring-up 统一门户 (kpi-portal) — v1.0.0

聚合 GPU 芯片 Bring-up 三大子系统的核心 KPI，单页看板 + 点击跳转各系统。部署地址：**http://10.49.5.188:8090/**

- **前端**：`public/index.html` 单页(深色主题，30s 自动刷新)
- **后端**：`server.js` — Express，端口 **3005**，PM2 `kpi-portal` 托管
- **Nginx**：端口 **8090**，静态页 + `/api/` 反代到 `127.0.0.1:3005`
- **版本**：v1.0.0

---

## 1. 系统架构

```
┌─────────────────────────────────────────────────────────┐
│              GPU Bring-up 统一门户 :8090                │
│   登录(复用硬件平台账号) → 看板 + 三张系统跳转卡         │
└──────────┬──────────────────────┬──────────────────────┘
           │ 后端 :3005 直连        │ 后端代理本地系统
           ▼                      ▼
   ┌──────────────┐      ┌─────────────────────┐
   │    JIRA       │      │ gpu-tracker :3000   │
   │ (Bug + 用例)  │      │ 日报数据(手动录入)  │
   └──────────────┘      └─────────────────────┘
                          ┌─────────────────────┐
                          │ hardware :3002      │
                          │ 预约/平台公开 API   │
                          └─────────────────────┘
```

**数据源模型(关键设计)**：三大子系统数据来源不同（JIRA vs 手动录入），项目命名空间也不同。**不做统一全局项目切换**，每个 KPI 区块用自己来源的独立下拉，互不影响。

| 区块 | 系统(端口) | 数据来源 | 项目维度 |
|------|-----------|----------|----------|
| JIRA Bug 诊断 | 8088 Bug 子系统 | 来自 JIRA | JIRA 项目 GPU1 / MPW2 / BR188 / BR200 |
| Bringup Daily Task | 8088 日报子系统 | 手动录入 | gpu-tracker 日报项目 gpu-bringup / project-2 / taihu |
| 测试用例 | 8089 | 来自 JIRA | Test 项目 + Test Plan（级联 `?tcProject=` / `?tcPlan=`） |
| 硬件资源管理 | 3002 | 手动录入 | 硬件项目 BR209 / BR288X / BR288Y |

**测试用例模型**：Test Plan = `issuetype="Test Plan"` 的 JIRA issue（BR200 有 23 个，如 BR200-99/123/130…），用例 = Sub-task 经 `parent=<PlanKey>` 挂到计划下。全球只有约 8 个项目有 Test Plan（BR200/BR100/BR166/BRHW200/BRNPI104/MPW2/BR110VAL/TPL），项目下拉据此筛选，避免列出全部 130 个 JIRA 项目。

---

## 2. 登录 & 权限

- 门户无自己的用户库，复用 **Hardware 平台用户表**（:3002 `users` 表，明文账号）。
- `POST /api/auth/login {name, password}` → 代理到 `POST 127.0.0.1:3002/api/users/login`。
- 登录成功 → 服务端内存 `sessions` map + httpOnly cookie `kpi_token`（Path=/, SameSite=Lax, 24h）。
- 角色沿用 `admin` / `owner`（域负责人）；门户本身**只读**，两者均可查看 KPI，角色仅影响徽章显示（管理员 / 域负责人）。
- 同一账号体系：gpu-tracker(8088) 登录也回退 Hardware 用户库——改 Hardware `users` 表同时影响门户与 8088 登录。8089 jira-testcase 用独立登录，不受影响。
- **已知限制**：会话在内存中，PM2 重启后所有人需重新登录。

默认账号（Hardware 平台既有）：`admin/admin123`（管理员）、各域账号 `xxx/xxx123`（owner，如 board/board123）。

---

## 3. 后端 API

所有聚合接口设置 `Cache-Control: no-store`。

| 接口 | 说明 |
|------|------|
| `GET /api/health` | 公开探活：`{ok, jiraConfigured}` |
| `POST /api/auth/login` / `GET /api/auth/me` / `POST /api/auth/logout` | 认证流（复用硬件账号） |
| `GET /api/projects` | 硬件项目列表 `{projects:[...]}` |
| `GET /api/jira-projects` | JIRA 项目 + 对应 Bug 数（GPU1/MPW2/BR188/BR200） |
| `GET /api/daily-projects` | gpu-tracker 日报项目 |
| `GET /api/testcase-projects` | 有 Test Plan 的 JIRA 项目（含 planCount） |
| `GET /api/testcase-plans?project=X` | 该项目下的 Test Plan 列表 |
| `GET /api/kpis` | **聚合调用**（参数见下） |

`/api/kpis` 参数（均可选，服务端做 sanitize）：

- `project` → 硬件区块（dashboard/stats + active-summary 过滤）
- `jiraProject` → Bug 区块（JQL `project=X AND issuetype=Bug`；缺省聚合 GPU1/MPW2/BR188/BR200）
- `dailyProject` → 日报区块（poll `:3000/api/data?project=X`）
- `tcProject` / `tcPlan` → 测试用例区块（默认 BR200；**选计划 = BFS 收集该计划 + 全部 outward "Test Plan" 关联子计划**（visited 防环、深度≤4、数量≤60），再 `parent in (...)` 汇总子任务；未选 = 统计整个项目 Sub-tasks）

返回 `{generatedAt, user, gpu, testcase, hardware, daily}`，每区块 `{ok:true,data}` 或 `{ok:false,error}`。四区块 `Promise.all` 并行、逐一 catch——单源故障不拖垮整页。

---

## 4. KPI 口径

- **GPU Bug**：总 / 未关闭 / 已关闭 / 今日新增 / 本周关闭 / 逾期(>14天未关闭)。状态映射 `mapStatus()` 与 gpu-tracker `routes/jira.js` 一致（closed/done/resolved/rejected/implement/triage/open 分级）。
- **Test case**：总用例 / 已完成(Done/Validated/Closed) / 进行中 / 待处理 / 已豁免(WAIVED)。分类见 `normalizeTestCase()`，**大小写不敏感**。
- **Hardware**：当前阶段(BU/FE/FST/PVT 时间线) / 平台总数 / 在用 / 空闲 / 活跃团队 / 活跃预约。
- **Daily**：域数量、手动 Bug 总/未关闭、每日进度条数、BU 准出通过率（`ecPass/ecTotal`，状态比较**大小写不敏感** Pass/pass）。

---

## 5. 部署

```bash
# 前端（nginx 静态）
sudo cp /home/br188/kpi-portal/public/index.html /var/www/kpi-portal/
sudo chmod 644 /var/www/kpi-portal/index.html
sudo chown www-data:www-data /var/www/kpi-portal/index.html

# 后端（重启会清内存会话 → 全部重新登录）
cd /home/br188/kpi-portal && pm2 restart kpi-portal --update-env

# 新依赖
cd /home/br188/kpi-portal && npm install --no-audit --no-fund

# nginx 站点配置变更时
sudo cp nginx-kpi-portal.conf /etc/nginx/sites-available/kpi-portal
sudo ln -sf /etc/nginx/sites-available/kpi-portal /etc/nginx/sites-enabled/kpi-portal
sudo nginx -t && sudo nginx -s reload    # 注意：本机 nginx 非 systemd 管理，用 nginx -s reload
```

- JIRA 连接信息（`JIRA_PAT` / `JIRA_BASE_URL`）在 `~/skills/.env`，服务启动时加载；换 token 只改 .env 即可。
- 门户/页面里的跳转地址（10.49.5.188 各端口）写死在 `public/index.html`，机房 IP 变更时需同步更新。

---

## 6. 验证

对**运行中的部署**（localhost）用 HTTP cookie 会话实测：

- 未登录 `/api/kpis` → 401；admin 登录 → 四区块 `{ok:true}`
- `/api/jira-projects` 含 BR200；`/api/daily-projects` 含 gpu-bringup；`/api/projects` 含 BR288Y
- `/api/kpis?jiraProject=BR200` → `gpu.data.total==7`；无参数 → 总数 120
- `/api/kpis?tcProject=BR200&tcPlan=BR200-99` → total==23；`&tcPlan=BR200-123`（父计划）→ total==378、planCount==22（BFS 子计划聚合）
- `/api/kpis?project=BR288X` → `hardware.data.selectedProject=="BR288X"`（BR288Y 与 BR288X 都是 15 平台，用 selectedProject 区分）
- 浏览器实测：登录 → 切各下拉 → 只刷新对应区块；控制台无 JS 错误

---

## 7. 目录结构

```
server.js              后端聚合服务 (Express, :3005)
ecosystem.config.js     PM2 配置
nginx-kpi-portal.conf   nginx 站点配置 (:8090)
public/index.html       门户前端单页（深色主题, 30s 自动刷新）
package.json            依赖 (express / cookie-parser / dotenv)
```

---

## 8. 版本历史

### v1.0.0 (2026-08-31)
- **徽章三分支**：`admin`→管理员、owner 且在 `REAL_DOMAIN_OWNERS`（16 个真域负责人登录名，与 gpu-tracker `DOMAIN_OWNER_USER_KEY` 同名单）→域负责人、其余 owner（如 biren 只读账号）→普通用户（绿色徽章）。
- **JIRA Bug 项目列表修正**：废弃已不存在的 BR200 旧 key（BR288X 重命名遗留别名）→ 使用真实 key GPU1 / MPW2 / BR188 / BR288X / BR288Y，下拉含「全部聚合」。
- **系统卡 / 区块更名**：「硬件资源预约」→「硬件资源管理」、「打开预约平台」→「打开管理平台」；JIRA Bug 区块指标「域数量」→「Exit Criteria」。
- **测试用例区块级联双下拉**：Test 项目 → Test Plan（`?tcProject=` / `?tcPlan=`），含子计划 BFS 聚合与「全部计划」。
- nginx 出口 `Cache-Control: no-cache, no-store`（根治旧前端被浏览器缓存）。

### v0.5.0 (2026-08-10)
- 首个提交到版本管理的完整版本。
- 四区块 KPI 聚合：JIRA Bug（GPU1/MPW2/BR188/BR200）、Bringup Daily、测试用例（Test项目→Test Plan 级联）、硬件资源管理。
- 三级 Test Plan 关联聚合（BFS outward 链接，解决 BR200-123 父计划 0 直接子任务问题）。
- 登录复用 Hardware 用户库 + 会话 cookie（内存）。
- 30s 自动刷新、深色单页、独立的 source-scoped 项目下拉（不做全局项目切换）。

---

## 9. 协同源码仓库

本门户聚合的三个子系统源码，GitLab 仓库如下：

| 子系统（端口） | GitLab E01718 | GitLab pel-val |
|------|---------------|----------------|
| 8088 日报状态 / Bug 诊断（gpu-tracker） | https://gitlab.birentech.com/E01718/gpu-tracker | https://gitlab.birentech.com/pel-val/validation/jira-diagnosis-platform |
| 8089 JIRA 用例管理 | https://gitlab.birentech.com/E01718/jira-test-case-management | https://gitlab.birentech.com/pel-val/validation/jira-test-case-management |
| 3002 硬件资源管理 | https://gitlab.birentech.com/E01718/hardware-reservation-platform | https://gitlab.birentech.com/pel-val/validation/hardware-reservation-platform |