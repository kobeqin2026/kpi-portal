// GPU Bring-up 统一门户聚合后端
// 聚合三大系统的关键 KPI:
//   1) GPU Daily Tracker / JIRA bug diag -> 直连 JIRA 查询 Bug (GPU1, MPW2, BR188, BR288X, BR288Y)
//   2) JIRA Test Case Manager            -> 直连 JIRA 查询 BR200 Sub-task
//   3) Hardware Reservation Allocation   -> 拉取本机 :3002 公开 API (按 project 过滤)
//
// 登录复用 Hardware 平台用户库 (POST /api/users/login), 角色: admin / owner (域负责人)
// 服务端口: 3005 (nginx 8090 代理本服务, 并托管 public/ 静态页面)
'use strict';

var express = require('express');
var path = require('path');
var http = require('http');
var https = require('https');
var url = require('url');
var crypto = require('crypto');
var cookieParser = require('cookie-parser');

require('dotenv').config({ path: '/home/br188/skills/.env' });

var PORT = process.env.PORT || 3005;
// JIRA 地址/令牌均从环境注入(默认值仅为占位, 不含内网信息; 生产通过 ~/skills/.env 的 JIRA_BASE_URL 提供)
var JIRA_BASE = (process.env['JIRA_BASE_URL'] || 'https://jira.example.com').replace(/\/+$/, '');
var JIRA_PAT = process.env['JIRA_PAT'] || '';
var BUG_PROJECTS = ['GPU1', 'MPW2', 'BR188', 'BR288X', 'BR288Y'];
var TESTCASE_PROJECT = 'BR200';
var HW_BASE = 'http://127.0.0.1:3002';
var app = express();

app.use(express.json());
app.use(cookieParser());

// ---------------------------------------------------------------------------
// 登录会话 (内存). 用户库复用 Hardware 平台. 已知限制: pm2 重启后会话丢失.
// ---------------------------------------------------------------------------
var sessions = {}; // token -> { name, role, display_name }

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

// 取 token: 优先 cookie, 其次 Authorization: Bearer
function getToken(req) {
  if (req.cookies && req.cookies.kpi_token) return req.cookies.kpi_token;
  var h = req.headers['authorization'] || '';
  if (h.indexOf('Bearer ') === 0) return h.slice(7);
  return null;
}

function auth(req, res, next) {
  var user = getToken(req) && sessions[getToken(req)];
  if (!user) return res.status(401).json({ success: false, error: '未登录或登录已过期' });
  req.user = user;
  next();
}

function jsonBodyPost(theUrl, data, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var parsed = url.parse(theUrl);
    var mod = parsed.protocol === 'http:' ? http : https;
    var body = JSON.stringify(data || {});
    var req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'application/json'
      }
    }, function (res) {
      var buf = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { buf += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
    });
    req.setTimeout(timeoutMs || 10000, function () { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end(body);
  });
}

function httpGetJson(theUrl, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var parsed = url.parse(theUrl);
    var mod = parsed.protocol === 'http:' ? http : https;
    var req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.path,
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    }, function (res) {
      var body = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('HTTP ' + res.statusCode));
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('JSON parse error')); }
      });
    });
    req.setTimeout(timeoutMs || 10000, function () { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// JIRA helpers
// ---------------------------------------------------------------------------
function jiraRequest(httpPath, timeoutMs) {
  return new Promise(function (resolve, reject) {
    if (!JIRA_PAT) { return reject(new Error('JIRA_PAT 未配置')); }
    var parsed = url.parse(JIRA_BASE);
    var mod = parsed.protocol === 'http:' ? http : https;
    var opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: httpPath,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + JIRA_PAT,
        'Accept': 'application/json'
      },
      rejectUnauthorized: false
    };
    var req = mod.request(opts, function (res) {
      var body = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('JIRA HTTP ' + res.statusCode + ': ' + body.substring(0, 200)));
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('JIRA JSON parse error')); }
      });
    });
    req.setTimeout(timeoutMs || 30000, function () { req.destroy(new Error('JIRA timeout')); });
    req.on('error', reject);
    req.end();
  });
}

async function searchAllIssues(jql, fields, maxResults) {
  var all = [];
  var startAt = 0;
  var page = maxResults || 100;
  var fieldStr = fields.join(',');
  for (;;) {
    var q = '/rest/api/2/search?jql=' + encodeURIComponent(jql) +
      '&fields=' + encodeURIComponent(fieldStr) +
      '&startAt=' + startAt + '&maxResults=' + page;
    var data = await jiraRequest(q);
    if (data && data.issues && data.issues.length) { all = all.concat(data.issues); }
    var total = (data && data.total) || 0;
    startAt += (data && data.issues ? data.issues.length : 0);
    if (startAt >= total) break;
  }
  return all;
}

function mapStatus(status) {
  if (!status) return 'open';
  var name = (status.name || '').toLowerCase();
  if (~name.indexOf('closed') || ~name.indexOf('done') || ~name.indexOf('resolved')) return 'closed';
  if (~name.indexOf('reject') || ~name.indexOf('wont')) return 'rejected';
  if (~name.indexOf('implement')) return 'implement';
  if (~name.indexOf('triage') || ~name.indexOf('开发') || ~name.indexOf('in progress') ||
      ~name.indexOf('review') || ~name.indexOf('test') || ~name.indexOf('verify') || ~name.indexOf('qa')) return 'triage';
  return 'open';
}

function normalizeTestCase(status) {
  if (!status) return 'todo';
  var name = (status.name || '').toLowerCase();
  if (~name.indexOf('waive') || ~name.indexOf('wont')) return 'waived';
  if (~name.indexOf('close') || ~name.indexOf('done') || ~name.indexOf('resolve') || ~name.indexOf('valid')) return 'done';
  if (~name.indexOf('progress') || ~name.indexOf('开发') || ~name.indexOf('test') || ~name.indexOf('review')) return 'inprogress';
  return 'todo';
}

// ---------------------------------------------------------------------------
// 各系统 KPI
// ---------------------------------------------------------------------------
function daysAgo(dateStr) {
  var d = new Date(dateStr);
  if (isNaN(d.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}

async function gpuKpis(jiraProject) {
  if (!JIRA_PAT) throw new Error('JIRA_PAT 未配置');
  var jql = jiraProject
    ? ('project = ' + jiraProject + ' AND issuetype = Bug')
    : ('project in (' + BUG_PROJECTS.join(', ') + ') AND issuetype = Bug');
  var issues = await searchAllIssues(jql, ['status', 'created', 'updated', 'resolutiondate', 'assignee']);
  var total = issues.length, open = 0, closed = 0, rejected = 0, todayNew = 0, weekClosed = 0, overdue = 0;
  var resolutionDays = [];
  var now = new Date();
  var today = now.toISOString().split('T')[0];
  var weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString().split('T')[0];
  issues.forEach(function (issue) {
    var status = mapStatus(issue.fields.status);
    var created = (issue.fields.created || '').split('T')[0];
    var updated = (issue.fields.updated || '').split('T')[0];
    var createdDays = daysAgo(issue.fields.created);
    if (status === 'closed') {
      closed++;
      if (issue.fields.resolutiondate) resolutionDays.push(daysAgo(issue.fields.resolutiondate));
    } else if (status === 'rejected') { rejected++; }
    else { open++; if (createdDays > 14) overdue++; }
    if (created === today) todayNew++;
    if (status === 'closed' && updated >= weekAgo) weekClosed++;
  });
  var avgResolutionDays = resolutionDays.length
    ? Math.round(resolutionDays.reduce(function (a, b) { return a + b; }, 0) / resolutionDays.length)
    : 0;
  return { total: total, open: open, closed: closed, rejected: rejected, todayNew: todayNew, weekClosed: weekClosed, overdue: overdue, avgResolutionDays: avgResolutionDays, projects: jiraProject || BUG_PROJECTS.join(', '), selectedJiraProject: jiraProject || null };
}

async function testcaseKpis(project, planKey) {
  if (!JIRA_PAT) throw new Error('JIRA_PAT 未配置');
  var p = project || TESTCASE_PROJECT;
  var planKeys = planKey ? await collectPlanTree(planKey) : null;
  var jql;
  if (planKey && planKeys && planKeys.length) {
    // 计划本身 + outward 关联的 Test Plan 子计划: 汇总它们的全部子任务
    jql = 'project = ' + p + ' AND issuetype = Sub-task AND parent in (' + planKeys.join(', ') + ')';
  } else if (planKey) {
    jql = 'project = ' + p + ' AND issuetype = Sub-task AND parent = ' + planKey;
  } else {
    jql = 'project = ' + p + ' AND issuetype = Sub-task';
  }
  var issues = await searchAllIssues(jql, ['status']);
  var total = issues.length, done = 0, inprogress = 0, todo = 0, waived = 0;
  issues.forEach(function (issue) {
    var c = normalizeTestCase(issue.fields.status);
    if (c === 'done') done++;
    else if (c === 'inprogress') inprogress++;
    else if (c === 'waived') waived++;
    else todo++;
  });
  return { total: total, done: done, inprogress: inprogress, todo: todo, waived: waived, completed: done,
    selectedProject: p, selectedPlan: planKey || null,
    planCount: planKey ? (planKeys ? planKeys.length : 1) : null };
}

// 收集某 Test Plan 及其 outward 关联的 Test Plan 子计划 (层级 BFS: visited 防环, 深度≤4, 数量≤60)
async function collectPlanTree(rootKey) {
  var collected = [rootKey];
  var visited = {}; visited[rootKey] = true;
  var level = [rootKey];
  for (var d = 0; d < 4 && level.length; d++) {
    if (collected.length >= 60) break;
    var results = await Promise.all(level.map(function (k) {
      return jiraRequest('/rest/api/2/issue/' + encodeURIComponent(k) + '?fields=issuelinks')
        .then(function (data) { return (data && data.fields && data.fields.issuelinks) || []; })
        .catch(function () { return []; });
    }));
    var next = [];
    results.forEach(function (links) {
      links.forEach(function (l) {
        if (l.outwardIssue) {
          var k = l.outwardIssue.key;
          var t = (l.outwardIssue.fields && l.outwardIssue.fields.issuetype && l.outwardIssue.fields.issuetype.name) || '';
          if (t.indexOf('Test Plan') !== -1 && !visited[k]) {
            visited[k] = true; collected.push(k); next.push(k);
          }
        }
      });
    });
    level = next;
  }
  return collected;
}

async function hardwareKpis(project) {
  var pw = project ? '?project=' + encodeURIComponent(project) : '';
  var pwOut = project ? ('?project=' + encodeURIComponent(project)) : '';
  var stats = await httpGetJson(HW_BASE + '/api/dashboard/stats' + pw);
  var stages = await httpGetJson(HW_BASE + '/api/stages');
  var active = await httpGetJson(HW_BASE + '/api/reservations/active-summary' + pwOut);
  var projects = [];
  try {
    var plist = await httpGetJson(HW_BASE + '/api/projects');
    projects = (plist && plist.projects) || [];
  } catch (e) { /* 忽略, 项目列表非关键 */ }
  return {
    selectedProject: project || null,
    projects: projects,
    currentStage: stats.currentStage,
    totalPlatforms: stats.totalPlatforms,
    inUse: stats.inUse, idle: stats.idle, maintenance: stats.maintenance, backup: stats.backup,
    activeTeams: stats.activeTeams, activeReservations: stats.activeReservations,
    activeAllocTeams: stats.activeAllocTeams, totalTeams: stats.totalTeams,
    stages: (stages.stages || []).map(function (s) {
      return { id: s.id, name: s.name, start_week: s.start_week, end_week: s.end_week, color: s.color };
    }),
    activeReservationCount: Array.isArray(active) ? active.length : 0
  };
}

// ---------------------------------------------------------------------------
// Bringup Daily Task (gpu-tracker 手动录入子系统) KPI + JIRA 项目计数
// ---------------------------------------------------------------------------
async function dailyTaskKpis(project) {
  var p = project || 'gpu-bringup';
  var data = await httpGetJson('http://127.0.0.1:3000/api/data?project=' + encodeURIComponent(p));
  var domains = data.domains || [];
  var bugs = data.bugs || [];
  var progress = data.dailyProgress || [];
  var ec = data.buExitCriteria || [];
  var ecPass = 0, ecFail = 0, ecOther = 0;
  ec.forEach(function (e) {
    var s = (e.status || '').toLowerCase();
    if (s === 'pass') ecPass++; else if (s === 'fail') ecFail++; else ecOther++;
  });
  var openBugs = bugs.filter(function (b) {
    var s = (b.status || '').toLowerCase();
    return !(~s.indexOf('closed') || ~s.indexOf('rejected'));
  }).length;
  return {
    selectedProject: p,
    domains: domains.length,
    totalBugs: bugs.length,
    openBugs: openBugs,
    progressCount: progress.length,
    ecPass: ecPass, ecFail: ecFail, ecOther: ecOther, ecTotal: ec.length,
    ecRate: ec.length ? Math.round(ecPass / ec.length * 100) : 0,
    lastUpdated: data.lastUpdated || ''
  };
}

async function jiraProjectCounts() {
  var out = [];
  for (var i = 0; i < BUG_PROJECTS.length; i++) {
    var p = BUG_PROJECTS[i];
    var n = 0;
    try {
      var data = await jiraRequest('/rest/api/2/search?jql=' + encodeURIComponent('project = ' + p + ' AND issuetype = Bug') + '&maxResults=0');
      n = (data && data.total) || 0;
    } catch (e) { n = -1; }
    out.push({ key: p, bugs: n });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Test Case (8089): 测试项目 + 测试计划(Test Plan 类型) + 各计划 Sub-task KPI
// ---------------------------------------------------------------------------
async function testcaseProjects() {
  var issues = await searchAllIssues('issuetype = "Test Plan"', ['project', 'key']);
  var m = {};
  issues.forEach(function (i) {
    var pr = (i.fields.project) || {};
    var k = pr.key || '?';
    if (!m[k]) m[k] = { key: k, name: pr.name || k, planCount: 0 };
    m[k].planCount++;
  });
  return Object.keys(m).sort().map(function (k) { return m[k]; });
}

async function testcasePlans(project) {
  var jql = 'project = ' + project + ' AND issuetype = "Test Plan" ORDER BY created ASC';
  var issues = await searchAllIssues(jql, ['summary', 'status', 'created']);
  return issues.map(function (i) {
    return {
      key: i.key,
      summary: i.fields.summary || '',
      status: (i.fields.status && i.fields.status.name) || '',
      created: i.fields.created
    };
  });
}

// ---------------------------------------------------------------------------
// routes (auth)
// ---------------------------------------------------------------------------
app.get('/api/health', function (req, res) {
  res.json({ ok: true, name: 'kpi-portal', jiraConfigured: !!JIRA_PAT });
});

// 登录: 复用 Hardware 用户库
app.post('/api/auth/login', async function (req, res) {
  var name = req.body && req.body.name;
  var password = req.body && req.body.password;
  if (!name || !password) return res.status(400).json({ success: false, error: '用户名和密码不能为空' });
  try {
    var out = await jsonBodyPost(HW_BASE + '/api/users/login', { name: name, password: password });
    if (!out || !out.user) return res.status(401).json({ success: false, error: '用户名或密码错误' });
    var token = makeToken();
    sessions[token] = { name: out.user.name, role: out.user.role, display_name: out.user.display_name };
    res.cookie('kpi_token', token, { httpOnly: true, maxAge: 24 * 3600 * 1000, sameSite: 'lax' });
    res.json({ success: true, user: sessions[token] });
  } catch (e) {
    res.status(401).json({ success: false, error: '登录失败，请稍后重试' });
  }
});

// 当前登录用户
app.get('/api/auth/me', function (req, res) {
  var user = getToken(req) && sessions[getToken(req)];
  if (!user) return res.status(401).json({ success: false, error: '未登录' });
  res.json({ success: true, user: user });
});

// 登出
app.post('/api/auth/logout', function (req, res) {
  var token = getToken(req);
  if (token) delete sessions[token];
  res.clearCookie('kpi_token');
  res.json({ success: true });
});

// 项目列表 (硬件平台)
app.get('/api/projects', auth, async function (req, res) {
  try {
    var out = await httpGetJson(HW_BASE + '/api/projects');
    res.json({ projects: (out && out.projects) || [] });
  } catch (e) {
    res.json({ projects: [] });
  }
});

// JIRA 项目及其 Bug 数 (供 JIRA Bug 区块下拉)
app.get('/api/jira-projects', auth, async function (req, res) {
  try {
    var list = await jiraProjectCounts();
    res.json({ projects: list });
  } catch (e) {
    res.json({ projects: BUG_PROJECTS.map(function (p) { return { key: p, bugs: -1 }; }) });
  }
});

// gpu-tracker 项目 (供 Bringup Daily Task 区块下拉)
app.get('/api/daily-projects', auth, async function (req, res) {
  try {
    var out = await httpGetJson('http://127.0.0.1:3000/api/projects');
    res.json({ projects: (out || []).map(function (p) { return { id: p.id, name: p.name }; }) });
  } catch (e) {
    res.json({ projects: [] });
  }
});

// 有 "Test Plan" 的项目 (供测试用例区块"项目"下拉, 避免列出全部130个项目)
app.get('/api/testcase-projects', auth, async function (req, res) {
  try {
    var list = await testcaseProjects();
    res.json({ projects: list });
  } catch (e) {
    res.json({ projects: [] });
  }
});

// 指定项目下的 Test Plan (供测试用例区块"Test Plan"下拉)
app.get('/api/testcase-plans', auth, async function (req, res) {
  var project = (req.query.project || '').replace(/[^A-Za-z0-9_\-\s]/g, '').trim();
  if (!project) return res.json({ plans: [] });
  try {
    var plans = await testcasePlans(project);
    res.json({ plans: plans });
  } catch (e) {
    res.json({ plans: [] });
  }
});

// 聚合 KPI (需登录)
//   ?project=       硬件项目 (3002)
//   ?jiraProject=   JIRA 项目 (JIRA Bug 区块, 8088)
//   ?dailyProject=  gpu-tracker 项目 (Bringup Daily Task 区块, 8088 手录)
//   ?tcProject=     Test 项目 (测试用例区块, 8089)
//   ?tcPlan=        Test Plan key (测试用例区块, 8089)
app.get('/api/kpis', auth, async function (req, res) {
  var project = (req.query.project || '').replace(/[^A-Za-z0-9_\-\s]/g, '').trim();
  var jiraProject = (req.query.jiraProject || '').replace(/[^A-Za-z0-9_\-\s]/g, '').trim();
  var dailyProject = (req.query.dailyProject || '').replace(/[^A-Za-z0-9_\-\s]/g, '').trim();
  var tcProject = (req.query.tcProject || '').replace(/[^A-Za-z0-9_\-\s]/g, '').trim();
  var tcPlan = (req.query.tcPlan || '').replace(/[^A-Za-z0-9_\-\s]/g, '').trim();
  var out = { generatedAt: new Date().toISOString(), user: req.user };
  var gpuP = gpuKpis(jiraProject || undefined).then(function (d) { return { ok: true, data: d }; }).catch(function (e) { return { ok: false, error: e.message }; });
  var tcP = testcaseKpis(tcProject || undefined, tcPlan || undefined).then(function (d) { return { ok: true, data: d }; }).catch(function (e) { return { ok: false, error: e.message }; });
  var hwP = hardwareKpis(project || undefined).then(function (d) { return { ok: true, data: d }; }).catch(function (e) { return { ok: false, error: e.message }; });
  var dtP = dailyTaskKpis(dailyProject || undefined).then(function (d) { return { ok: true, data: d }; }).catch(function (e) { return { ok: false, error: e.message }; });
  var results = await Promise.all([gpuP, tcP, hwP, dtP]);
  out.gpu = results[0];
  out.testcase = results[1];
  out.hardware = results[2];
  out.daily = results[3];
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.json(out);
});

// 静态门户页面
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', function (req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, function () {
  console.log('kpi-portal listening on port ' + PORT);
  console.log('JIRA configured: ' + !!JIRA_PAT);
});