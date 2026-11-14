// EQuake 发报台本地服务器
// 用法: node server.js [--no-open]
// EQuake 订阅地址: http://127.0.0.1:端口/json
// 诊断: 浏览器打开 http://127.0.0.1:端口/log 查看全部请求记录
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = __dirname;
let current = null; // 当前已送达 EQuake 的报文(单条对象), null 表示无
let QUEUE = [];     // 定时投递队列: [{payload, at(ms), delay(sec), idx}]
const LOGS = [];
const MAX_LOG = 400;
const SENT = [];  // 本次服务器运行以来「已实际送达 EQuake」的报文流水, 用于页面继续加报/取消本次地震
const MAX_SENT = 300;
const CANCELED = new Set(); // 已被「取消本次地震」处理的 eventID：从列表移除, 且送达的取消报不再回写进列表
const EPOCH = {};          // 每个 eventID 的「震源时刻」(真实发震毫秒)，用于后续报「继着上一次波」而不重置；reStamp/填了震波已发出秒数 时刷新
const CLIENT = { hits: 0, last: '', lastMs: 0, lastUa: '', lastPath: '' };
const BROWSER_UA_RE = /mozilla|chrome|chromium|safari|firefox|edg(e|\/)|opera|webkit/i;
// EQuake 请求本地源时把 UA 伪装成 MSIE 9.0（会被上面的浏览器正则误判），单独认出来
const EQ_UA_RE = /MSIE\s*9\.0/;
function isClientReq(ua){ return !BROWSER_UA_RE.test(ua) || EQ_UA_RE.test(ua); }

function nowStr(){
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function log(req, status, size, note){
  const ua = req.headers['user-agent'] || '-';
  const hdrs = 'proto=' + req.httpVersion +
    ' accept=' + (req.headers['accept'] || '-') +
    ' enc=' + (req.headers['accept-encoding'] || '-') +
    ' conn=' + (req.headers['connection'] || '-') +
    ' host=' + (req.headers['host'] || '-');
  const rec = {
    t: nowStr(),
    method: req.method,
    url: req.url,
    status: status,
    size: size,
    ua: ua,
    note: note || '',
    hdrs: hdrs
  };
  LOGS.push(rec);
  if(LOGS.length > MAX_LOG) LOGS.shift();
  // 统计非浏览器客户端(EQuake 等)的取数行为
  const pathOnly = (req.url || '/').split('?')[0];
  if(isClientReq(ua) && pathOnly !== '/health' && pathOnly !== '/log'){
    CLIENT.hits++;
    CLIENT.last = rec.t;
    CLIENT.lastMs = Date.now();
    CLIENT.lastUa = ua;
    CLIENT.lastPath = req.url;
  }
  console.log('[' + rec.t + '] ' + rec.method + ' ' + rec.url + ' -> ' + status + ' ' + size + 'B UA=' + ua + (rec.note ? ' (' + rec.note + ')' : ''));
}
function logText(onlyClient, limit){
  let list = LOGS;
  if(onlyClient){
    list = list.filter(r => !/mozilla|chrome|safari|firefox|edg/i.test(r.ua));
  }
  if(limit > 0) list = list.slice(-limit);
  if(!list.length) return 'no matching requests yet.\n';
  return list.map(r =>
    '[' + r.t + '] ' + r.method + ' ' + r.url + ' -> ' + r.status + ' ' + r.size + 'B' + (r.note ? ' ' + r.note : '') +
    '\n    UA  : ' + r.ua +
    '\n    ' + r.hdrs
  ).join('\n') + '\n';
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function sendJson(req, res, obj, note) {
  const body = JSON.stringify(obj);
  setCors(res);
  // 显式 Content-Length, 避免 chunked 传输(部分老客户端解析 chunked 会出问题)
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache'
  });
  if(req.method === 'HEAD') res.end(); else res.end(body);
  log(req, 200, Buffer.byteLength(body), note);
}

function sendText(req, res, text) {
  setCors(res);
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  });
  if(req.method === 'HEAD') res.end(); else res.end(text);
  log(req, 200, Buffer.byteLength(text), 'log dump');
}

function serveFile(req, res, name, type) {
  const p = path.join(ROOT, name);
  fs.readFile(p, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      log(req, 404, 0, 'file missing: ' + name);
      return;
    }
    setCors(res);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store' });
    if(req.method === 'HEAD') res.end(); else res.end(data);
    log(req, 200, data.length, name);
  });
}

function readBody(req, cb) {
  let chunks = [], size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > 1024 * 1024) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => cb(Buffer.concat(chunks).toString('utf8')));
}

// ---- 多报定时投递 ----
// 每项可写 {payload:{...}, delaySec:5} 或直接是报文对象(用对象里的 delaySec/delay)
// delaySec = 距上一报的延迟秒数, 0 表示与上一报同时
function num(v){ const n = parseFloat(v); return isFinite(n) ? n : 0; }
function setPlan(items, immediate){
  const base = Date.now();
  let t = base;
  const out = [];
  items.forEach((it, i) => {
    let payload = it, d = 0;
    if(it && typeof it === 'object'){
      if(it.payload && typeof it.payload === 'object'){ payload = it.payload; d = num(it.delaySec) || num(it.delay); }
      else d = num(it.delaySec) || num(it.delay);
    }
    d = Math.max(0, immediate ? 0 : d);
    const at = t;
    t = at + d * 1000;
    out.push({ payload: payload, at: at, delay: d, idx: i + 1 });
  });
  QUEUE = out;
  const base0 = base;
  out.forEach(q => {
    if(!q.payload || typeof q.payload !== 'object') return;
    // 重新发布（非取消报）撤销之前的「取消本次地震」状态，让该事件重新出现在列表
    if(!q.payload.isCancel){ const e = String(q.payload.eventID || ''); if(e) CANCELED.delete(e); }
    markPlanned(q.payload, base0);
  });
}
// ---- 发震时刻改写（地震波从震中重新发出）----
// 报文里带 reStamp=true 时, 在「实际送达 EQuake 的那一刻」把 shockTime 改写成送达时刻,
// 这样 EQuake 拿到的地震波是从震中刚发出的, 而不是已经跑了一段。
// 前后时间格式: yyyy/MM/dd HH:mm:ss（UTC+9, 允许 JMA 24+ 时制）
// 报文时刻串的时区偏移（小时）：与页面「时区」下拉一致，默认 UTC+9。
// 【必须对齐 EQuake】EQuake 内部时间基准是 JST(UTC+9)，它按 JST 解读报文里的时刻串；
// 若按 UTC+8 写，EQuake 会认为地震发生在 1 小时前、超出 EEW 报警窗口而不显示。（可 POST /tz 改）
let TZ_OFF_H = 9;
function tsToMs(s){
  if(typeof s !== 'string') return null;
  const m = s.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,3}):(\d{2}):(\d{2})/);
  if(!m) return null;
  let h = parseInt(m[4], 10);
  const day = Math.floor(h / 24); h = h % 24; // 25:25:00 -> 次日 01:25:00
  // 串是 UTC+TZ_OFF_H 的墙上时间，真实时刻要减偏移才能和 msToTs 互为反函数
  return Date.UTC(+m[1], +m[2] - 1, +m[3], h, +m[5], +m[6]) + day * 86400000 - TZ_OFF_H * 3600000;
}
function msToTs(ms){
  const d = new Date(ms + TZ_OFF_H * 3600000); // 改成 UTC 读法即得 UTC+TZ_OFF_H 墙上时间
  const p = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '/' + p(d.getUTCMonth() + 1) + '/' + p(d.getUTCDate()) +
         ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}
// 报文是否携带「显式重新发出」意图：勾了 reStamp，或填了「震波已发出(秒)」头程
function hasWave(p){
  return !!(p && p.waveElapsed !== undefined && p.waveElapsed !== null && p.waveElapsed !== '' && isFinite(parseFloat(p.waveElapsed)));
}
// 送达时决定 shockTime：
//  - 显式重新发出(reStamp 或填了震波已发出秒数)：shockTime = 送达时刻 − 头程秒数（波从「已扩出头程」处出发）
//  - 否则「继着上一次地震波」：沿用该 eventID 已建立的震源时刻 EPOCH，不重置，波接着上一报继续向外扩
function restamp(p, ms){
  if(!p || typeof p !== 'object') return p;
  const ev = String(p.eventID || '');
  const reAnchor = p.reStamp === true || hasWave(p);
  if(reAnchor){
    const off = hasWave(p) ? Math.max(0, parseFloat(p.waveElapsed)) : 0; // 头程秒数
    const shockMs = ms - off * 1000;
    if(ev) EPOCH[ev] = shockMs;                  // 刷新该事件的震源时刻
    const out = Object.assign({}, p);
    out.shockTime = msToTs(shockMs);
    out.reportTime = msToTs(ms);                  // 发报时刻 = 实际送达时刻
    return out;
  }
  // 继着上一次波：不重置（先定下 shockMs，后面才好用它去纠正 reportTime）
  let shockMs;
  if(ev && EPOCH[ev] !== undefined) shockMs = EPOCH[ev];
  else {
    const s = tsToMs(p.shockTime);
    if(s === null) return p;                      // 既没 epoch 又没合法发震时刻：原样返回
    shockMs = s;
    if(ev) EPOCH[ev] = s;
  }
  // 发报时刻不能早于发震时刻（EQuake 会直接丢弃整条报，表现就是「发出去了但一直没显示」）
  const rtMs = tsToMs(p.reportTime);
  if(rtMs !== null && rtMs < shockMs) p = Object.assign({}, p, { reportTime: msToTs(shockMs) });
  const out = Object.assign({}, p);
  out.shockTime = msToTs(shockMs);
  // reportTime 保留表单填写的发报时刻（续报时一般就是当时填的 now）
  return out;
}
// 自定义源的响应体必须直接是裸 JSON 数组，不能预先包 <eewCustom>：
// EQuake 收到后会自己再套一层 <eewCustom>，我们预先包裹就会变成
// <eewCustom>"<eewCustom>[]</eewCustom>"</eewCustom>（字符串嵌套）导致解析失败丢报，
// 表现就是「/publish 成功、但地震一直不显示」。
// 另外形如 20261005153512+0|<eewCustom>...!&@^#* 的时间戳前缀和 !&@^#* 尾标记，
// 是 EQuake 写 replay 文件时自己加的封装，也不属于传输格式。
// EQuake 只认官方字段；official 是发报台 UI 自己用的标记（用于「正式报」标签），
// 送达前剥掉，避免把非官方键混进 EQuake 收到的报文。格式仍是裸 JSON 数组，不包裹。
function stripOfficial(p){
  if(p && typeof p === 'object' && 'official' in p){
    const o = Object.assign({}, p);
    delete o.official;
    return o;
  }
  return p;
}
function wrapEQ(arr){
  if(!Array.isArray(arr)) return stripOfficial(arr);
  return arr.map(stripOfficial);
}

// ---- EQuake「P/S 波显示」设置（正式报模式）----
// 依据：EQuake 主程序里「隐藏推算震源P/S波」等设置项，存于 %APPDATA%\EQuake\config\Settings.ini。
//  full = 完全不画波前（正式报/确定报效果）：隐藏推算震源 P/S 波 + 关检测网格 + 关震源推算
//  wave = 只隐藏推算震源 P/S 波
//  show = 恢复默认（显示波前）
// 注意：Settings.ini 含 GBK 中文字节，一律用 latin1 逐字节读写，只替换 ASCII 键行，避免破坏中文。
const PS_KEYS = ['IsHidePSWaveOfEstimatedEpicenter', 'IsDisplayGridOnDetection', 'IsEpiCenterCalculationEnabled'];
const PS_MODES = {
  show: { IsHidePSWaveOfEstimatedEpicenter: 'false', IsDisplayGridOnDetection: 'true',  IsEpiCenterCalculationEnabled: 'true' },
  wave: { IsHidePSWaveOfEstimatedEpicenter: 'true'  },
  full: { IsHidePSWaveOfEstimatedEpicenter: 'true',  IsDisplayGridOnDetection: 'false', IsEpiCenterCalculationEnabled: 'false' }
};
function psIniPath(){
  const base = process.env.APPDATA ||
    (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : '');
  return base ? path.join(base, 'EQuake', 'config', 'Settings.ini') : '';
}
function psRead(){
  const p = psIniPath();
  if(!p) return { ok: false, error: '找不到 APPDATA 路径', path: '' };
  if(!fs.existsSync(p)) return { ok: false, error: '找不到 EQuake 配置文件 Settings.ini（请先启动过一次 EQuake）', path: p };
  const raw = fs.readFileSync(p, 'latin1');
  const keys = {};
  raw.split(/\r?\n/).forEach(function(line){
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=(.*)$/);
    if(m && PS_KEYS.indexOf(m[1]) >= 0) keys[m[1]] = m[2].trim();
  });
  let mode = 'show';
  const hide = String(keys.IsHidePSWaveOfEstimatedEpicenter || '').toLowerCase() === 'true';
  const grid = String(keys.IsDisplayGridOnDetection || '').toLowerCase() === 'true';
  const epi  = String(keys.IsEpiCenterCalculationEnabled || '').toLowerCase() === 'true';
  if(hide && !grid && !epi) mode = 'full';
  else if(hide) mode = 'wave';
  return { ok: true, path: p, found: true, keys: keys, mode: mode,
           backup: fs.existsSync(p + '.bak'), eol: raw.indexOf('\r\n') >= 0 ? '\r\n' : '\n' };
}
function psApply(mode){
  const targets = PS_MODES[mode];
  if(!targets) throw new Error('未知的 P/S 波模式：' + mode);
  const r = psRead();
  if(!r.ok) throw new Error(r.error);
  const raw = fs.readFileSync(r.path, 'latin1');
  const eol = raw.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const seen = {};
  const out = lines.map(function(line){
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=/);
    if(m && Object.prototype.hasOwnProperty.call(targets, m[1])){
      seen[m[1]] = true;
      return m[1] + '=' + targets[m[1]];
    }
    return line;
  });
  // 缺的键插到 [Settings] 段的末尾（下一个 [section] 之前）
  let at = out.length - 1;
  for(let i = out.length - 1; i >= 0; i--){ if(/^\s*\[Settings\]\s*$/i.test(out[i])){ at = i + 1; break; } }
  Object.keys(targets).forEach(function(k){
    if(!seen[k]){ out.splice(at, 0, k + '=' + targets[k]); at++; seen[k] = true; }
  });
  // 首次改动前备份原文件（与仓库里 _pswave.ps1 一致，之后不再覆盖备份）
  let backupMade = false;
  if(!fs.existsSync(r.path + '.bak')){ fs.writeFileSync(r.path + '.bak', raw, 'latin1'); backupMade = true; }
  fs.writeFileSync(r.path, out.join(eol), 'latin1');
  const after = psRead();
  return { ok: true, mode: after.mode, keys: after.keys, path: r.path,
           backup: fs.existsSync(r.path + '.bak'), backupMade: backupMade,
           needRestart: true };
}

// ---- 持续同步（每秒刷新）----
// 开关打开后，EQuake 每次来取数（每秒一次）都把 reportTime 与 shockTime 一起刷成「当前时刻」，
// 表现就是：这条报永远是「刚刚发生、刚刚发布」，地震波每秒都从震中重新出发（不会越扩越远）。
// （不开的时候，时刻在投递那一秒定死，之后不再变。）
let LIVE_ON = false;
// 【已移除】每秒持续同步：原先会在 EQuake 每次取数时把 shockTime/reportTime 刷成当前时刻，
// 导致地震波每秒被重置回震中、永远扩不出去。现在取数一律原样返回投递那一刻定死的报。
function liveTouch(p){ return p; }
function liveList(arr){ return arr; }
// 已送达流水：页面据此列出「本次服务器已发出的地震」并提供加报/取消入口
function markSent(payload, ms){
  const p = payload || {};
  const ev = String(p.eventID || ''), rn = p.reportNum;
  // 已被「取消本次地震」处理的事件：送达的取消报不再回写进「本次已发出」列表
  if(p.isCancel && CANCELED.has(ev)) return null;
  // 同 eventID + 同报数已登记过（发布即登记）→ 只补送达状态，不重复计数
  if(ev){
    for(let i = SENT.length - 1; i >= 0; i--){
      if(SENT[i].eventID === ev && (SENT[i].reportNum === rn || SENT[i].reportNum === undefined)){
        SENT[i].arrived = true; SENT[i].at = ms; SENT[i].atText = msToTs(ms);
        // 送达时用的是改写后的发震时刻(即该事件的震源 epoch)，覆盖发布时登记的原始值，供加报「继着上一次波」
        if(p.shockTime) SENT[i].shockTime = p.shockTime;
        if(p.reportTime) SENT[i].reportTime = p.reportTime;
        return SENT[i];
      }
    }
  }
  const rec = {
    at: ms,
    atText: msToTs(ms),
    eventID: p.eventID || '',
    placeName: p.placeName || '',
    latitude: p.latitude, longitude: p.longitude,
    depth: p.depth,     magnitude: p.magnitude,
    reportNum: p.reportNum,
    maxIntensity: p.maxIntensity || '', maxLgInt: p.maxLgInt || '',
    shockTime: p.shockTime || '', reportTime: p.reportTime || '',
    sourceName: p.sourceName || '',
    isCancel: !!p.isCancel, isFinal: !!p.isFinal,
    isPLUM: !!p.isPLUM, isCSIS: !!p.isCSIS,
    official: !!p.official   // 仅 UI 标签用，送达 EQuake 的报文已由 wrapEQ 剥掉
  };
  rec.arrived = true;
  SENT.push(rec);
  if(SENT.length > MAX_SENT) SENT.shift();
  return rec;
}
// 发布那一刻就登记事件（哪怕 EQuake 还没来取），这样「本次已发出」栏一发布就有内容
function markPlanned(p, ms){
  if(!p || typeof p !== 'object') return;
  const ev = String(p.eventID || '');
  if(!ev) return;
  const rec = markSent(p, ms);
  rec.arrived = false;
  rec.planned = true;
}
function sentState(){
  return SENT.filter(r => !CANCELED.has(String(r.eventID || ''))).map(r => ({
    arrived: !!r.arrived, planned: !!r.planned,
    atMs: r.at, atText: r.atText, eventID: r.eventID, placeName: r.placeName,
    latitude: r.latitude, longitude: r.longitude, depth: r.depth,
    magnitude: r.magnitude, reportNum: r.reportNum,
    maxIntensity: r.maxIntensity, maxLgInt: r.maxLgInt,
    shockTime: r.shockTime || '', reportTime: r.reportTime || '',
    sourceName: r.sourceName,
    isCancel: r.isCancel, isFinal: r.isFinal, isPLUM: r.isPLUM, isCSIS: r.isCSIS,
    official: !!r.official
  })).reverse(); // 最新在最前
}
// 轮询时取出一条已到期的报 (EQuake 每秒拉一次, 精度约 1 秒)
function duePayload(){
  const now = Date.now();
  while(QUEUE.length && QUEUE[0].at < now - 600000) QUEUE.shift(); // 过期太久直接丢弃, 避免堆积
  if(QUEUE.length && QUEUE[0].at <= now){
    const hit = QUEUE.shift();
    current = restamp(hit.payload, now);
    markSent(current, now);
    // 剩余队列按「本次实际投递时刻 + 各自延迟」重新排队：
    // 延迟语义是 A 报送达后 N 秒发 B 报, 而不是从发布那一刻起算
    let t = now;
    for(const q of QUEUE){ t += q.delay * 1000; q.at = t; }
  }
  return liveList(current === null ? [] : [current]);   // 持续同步开着时，每次取数都刷成当前时刻
}
function queueState(){
  const now = Date.now();
  return QUEUE.map(q => ({
    i: q.idx,
    eventID: (q.payload && q.payload.eventID) || '',
    delaySec: q.delay,
    etaSec: Math.max(0, Math.round((q.at - now) / 1000)),
    atMs: q.at,
    atText: msToTs(q.at),
    willRestamp: !!(q.payload && q.payload.reStamp)
  }));
}

// 浏览器才回编辑页, 其余(EQuake 等客户端)一律给 JSON
function wantsUi(req) {
  const acc = req.headers['accept'] || '';
  const ua = req.headers['user-agent'] || '';
  if(/application\/json/i.test(acc)) return false;
  return BROWSER_UA_RE.test(ua);
}
const UI_PATHS = new Set(['/', '/index.html', '/ui']);

// 请求级兜底：任何未捕获的异常都只让这一次请求失败，绝不让整个服务器进程退出
// （以前一次投递抛错就整个 node 退出，EQuake 端表现成「发布成功了但地震一直不显示」）
function guard(req, res, fn){
  try { fn(); }
  catch(e){
    try{
      console.log('[' + new Date().toISOString() + '] REQUEST ERROR ' + (req.method || '') + ' ' + (req.url || '') + ' -> ' + (e && e.message || e));
      if(!res.writableEnded){
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('request error: ' + (e && e.message || e));
      }
    }catch(_){}
  }
}

function onReq(req, res) {
  const u = (req.url || '/').split('?')[0];
  if (req.method === 'OPTIONS') {
    setCors(res);
    res.writeHead(204);
    res.end();
    log(req, 204, 0, 'preflight');
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (u === '/health') {
      sendJson(req, res, {
        ok: true,
        count: current === null ? 0 : (Array.isArray(current) ? current.length : 1),
        queued: QUEUE.length,
        sentCount: SENT.length,
        clientHits: CLIENT.hits,
        clientLast: CLIENT.last,
        clientSinceSec: CLIENT.lastMs ? Math.max(0, Math.round((Date.now() - CLIENT.lastMs) / 1000)) : -1,
        clientUa: CLIENT.lastUa,
        clientPath: CLIENT.lastPath,
        tz: TZ_OFF_H,
        live: LIVE_ON
      });
      return;
    }
    if (u === '/live') { sendJson(req, res, { ok: true, live: false, removed: true }); return; }
    if (u === '/tz') { sendJson(req, res, { ok: true, off: TZ_OFF_H }); return; }
    // 查询 EQuake 当前「P/S 波显示」设置（正式报模式开关用）
    if (u === '/pswave') {
      let r;
      try { r = psRead(); }
      catch (e) { r = { ok: false, error: String(e.message || e) }; }
      sendJson(req, res, r, 'pswave status');
      return;
    }
    if (u === '/queue') { sendJson(req, res, { ok: true, queued: queueState(), sent: current ? 1 : 0 }); return; }
    if (u === '/sent') {
      const items = sentState();
      sendJson(req, res, { ok: true, items: items, pending: items.filter(x => !x.arrived).length }, 'sent log');
      return;
    }
    if (u === '/state') { sendJson(req, res, { ok: true, current: liveList(current === null ? [] : (Array.isArray(current) ? current : [current])) }); return; }
    if (u === '/log') {
      const qs = new URLSearchParams((req.url || '').split('?')[1] || '');
      sendText(req, res, logText(qs.get('client') === '1', parseInt(qs.get('n') || '0', 10) || 0));
      return;
    }
    if (UI_PATHS.has(u)) {
      if (wantsUi(req)) { serveFile(req, res, 'index.html', 'text/html; charset=utf-8'); }
      else { sendJson(req, res, wrapEQ(liveList(current === null ? [] : current)), 'root as json (non-browser UA)'); }
      return;
    }
    // 其他任何路径都按数据端点容错处理, 避免路径填错导致 EQuake 拿不到数据 (同样走定时投递)
    // 整个投递过程包一层 try：以前只要投递时抛一个错，整个 node 进程就会退出、
    // EQuake 那边表现成「/publish 明明成功、但地震一直不显示」。现在只让这一次请求失败。
    let payload;
    try { payload = duePayload(); }
    catch (e) { payload = current === null ? [] : [current]; log(req, 500, 0, 'duePayload error: ' + e.message); }
    sendJson(req, res, wrapEQ(payload), 'fallback data');
    return;
  }
  if (req.method === 'POST') {
    if (u === '/publish') {
      const qs = new URLSearchParams((req.url || '').split('?')[1] || '');
      const immediate = qs.get('immediate') === '1';
      readBody(req, raw => {
        try {
          const obj = JSON.parse(raw);
          let items = null;
          if (Array.isArray(obj)) items = obj;
          else if (obj && Array.isArray(obj.plan)) items = obj.plan;
          else if (obj && typeof obj === 'object') items = [obj];
          if (!items || !items.length) throw new Error('empty payload');
          setPlan(items, immediate);
          sendJson(req, res, { ok: true, count: QUEUE.length, schedule: queueState(), immediate: !!immediate }, 'planned');
        } catch (e) {
          sendJson(req, res, { ok: false, error: String(e.message || e) }, 'publish rejected');
        }
      });
      return;
    }
    // 时区（UTC+8 / UTC+9）：与页面下拉保持一致，否则解析会差 1 小时
    if (u === '/tz') {
      readBody(req, raw => {
        try {
          const o = raw ? JSON.parse(raw) : {};
          const v = parseInt(o.off, 10);
          TZ_OFF_H = (v === 9) ? 9 : 8;
          sendJson(req, res, { ok: true, off: TZ_OFF_H }, 'tz set UTC+' + TZ_OFF_H);
        } catch (e) { sendJson(req, res, { ok: false, error: String(e.message || e) }, 'tz rejected'); }
      });
      return;
    }
    if (u === '/clear') { current = null; QUEUE = []; Object.keys(EPOCH).forEach(k => delete EPOCH[k]); sendJson(req, res, { ok: true, queued: 0 }, 'cleared'); return; }
    // 切换 EQuake 的 P/S 波显示：show 显示 / wave 只隐藏推算震源波 / full 完全不画波前（正式报）
    if (u === '/pswave') {
      readBody(req, raw => {
        try {
          const o = raw ? JSON.parse(raw) : {};
          const r = psApply(String(o.mode || 'full'));
          sendJson(req, res, r, 'pswave set ' + r.mode);
        } catch (e) { sendJson(req, res, { ok: false, error: String(e.message || e) }, 'pswave rejected'); }
      });
      return;
    }
    // 直接取消某次地震：立刻排入一条 isCancel 报文(同 eventID)，并清掉尚未投递的排队报
    if (u === '/cancelEvent') {
      readBody(req, raw => {
        try {
          const o = JSON.parse(raw) || {};
          const ev = String(o.eventID || '').trim();
          if (!ev) throw new Error('eventID 为空');
          const now = Date.now();
          // 请求里没带的字段，用该事件最后一次已发报的内容补齐（同 eventID 的震源/震级/地名）
          let last = null;
          for (let i = SENT.length - 1; i >= 0; i--) { if (SENT[i].eventID === ev) { last = SENT[i]; break; } }
          const nb = last || {};
          const pick = (v, fb) => (v === undefined || v === null || v === '' || !isFinite(parseFloat(v))) ? fb : parseFloat(v);
          const p = {
            eventID: ev,
            placeName: o.placeName || nb.placeName || '',
            latitude: pick(o.latitude, nb.latitude),
            longitude: pick(o.longitude, nb.longitude),
            depth: pick(o.depth, nb.depth),
            magnitude: pick(o.magnitude, nb.magnitude),
            reportTime: msToTs(now), shockTime: msToTs(now),
            reportNum: pick(o.reportNum, (nb.reportNum ? parseInt(nb.reportNum, 10) : 0) + 1) || 1,
            maxIntensity: '', maxLgInt: '',
            isCSIS: false, isPLUM: false, isCancel: true, isFinal: false,
            sourceName: o.sourceName || 'JMA'
          };
          QUEUE = [{ payload: p, at: now, delay: 0, idx: 1 }]; // 覆盖式：取消报优先发出，其余排队报作废
          CANCELED.add(ev); // 标记为已取消 → 立即从「本次已发出」列表移除
          delete EPOCH[ev]; // 同时清掉该事件的震源时刻，重新发布时从零开始
          // 立刻把该事件在列表里的历史记录删掉（发布即登记 + 已送达的都一并清掉）
          for (let i = SENT.length - 1; i >= 0; i--) { if (SENT[i].eventID === ev) SENT.splice(i, 1); }
          sendJson(req, res, { ok: true, canceled: ev, queued: QUEUE.length, schedule: queueState() }, 'cancel event');
        } catch (e) {
          sendJson(req, res, { ok: false, error: String(e.message || e) }, 'cancel rejected');
        }
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    log(req, 404, 0, 'unknown POST path');
    return;
  }
  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('method not allowed');
  log(req, 405, 0, '');
}

const server = http.createServer((req, res) => guard(req, res, function(){ onReq(req, res); }));

// 端口从 8790 起自动顺延 (可用环境变量 EQ_PORT 指定起始端口)
function tryPort(i) {
  if (i > 20) { console.error('ERROR: no free port'); process.exit(1); }
  const start = parseInt(process.env.EQ_PORT || '8790', 10);
  const port = start + i;
  server.once('error', () => tryPort(i + 1));
  server.listen(port, '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + port;
    console.log('EQuake sender listening on ' + url);
    console.log('EQuake subscribe URL: ' + url + '/json');
    if (!process.argv.includes('--no-open')) {
      try {
        if (process.platform === 'win32') cp.exec('start "" "' + url + '"');
        else cp.exec('xdg-open "' + url + '"');
      } catch (e) { /* ignore */ }
    }
  });
}
tryPort(0);
