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
const CLIENT = { hits: 0, last: '', lastUa: '', lastPath: '' };
const BROWSER_UA_RE = /mozilla|chrome|chromium|safari|firefox|edg(e|\/)|opera|webkit/i;

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
  if(!BROWSER_UA_RE.test(ua) && pathOnly !== '/health' && pathOnly !== '/log'){
    CLIENT.hits++;
    CLIENT.last = rec.t;
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
function tsToMs(s){
  if(typeof s !== 'string') return null;
  const m = s.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,3}):(\d{2}):(\d{2})/);
  if(!m) return null;
  let h = parseInt(m[4], 10);
  const day = Math.floor(h / 24); h = h % 24; // 25:25:00 -> 次日 01:25:00
  return Date.UTC(+m[1], +m[2] - 1, +m[3], h, +m[5], +m[6]) + day * 86400000;
}
function msToTs(ms){
  const d = new Date(ms + 9 * 3600000); // 改成 UTC 读法即得 UTC+9 墙上时间
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
  // 继着上一次波：不重置
  let shockMs;
  if(ev && EPOCH[ev] !== undefined) shockMs = EPOCH[ev];
  else {
    const s = tsToMs(p.shockTime);
    if(s === null) return p;                      // 既没 epoch 又没合法发震时刻：原样返回
    shockMs = s;
    if(ev) EPOCH[ev] = s;
  }
  const out = Object.assign({}, p);
  out.shockTime = msToTs(shockMs);
  // reportTime 保留表单填写的发报时刻（续报时一般就是当时填的 now）
  return out;
}
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
    isPLUM: !!p.isPLUM, isCSIS: !!p.isCSIS
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
    isCancel: r.isCancel, isFinal: r.isFinal, isPLUM: r.isPLUM, isCSIS: r.isCSIS
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
  return current === null ? [] : [current];
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

const server = http.createServer((req, res) => {
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
        clientUa: CLIENT.lastUa,
        clientPath: CLIENT.lastPath
      });
      return;
    }
    if (u === '/queue') { sendJson(req, res, { ok: true, queued: queueState(), sent: current ? 1 : 0 }); return; }
    if (u === '/sent') {
      const items = sentState();
      sendJson(req, res, { ok: true, items: items, pending: items.filter(x => !x.arrived).length }, 'sent log');
      return;
    }
    if (u === '/state') { sendJson(req, res, { ok: true, current: current === null ? [] : (Array.isArray(current) ? current : [current]) }); return; }
    if (u === '/log') {
      const qs = new URLSearchParams((req.url || '').split('?')[1] || '');
      sendText(req, res, logText(qs.get('client') === '1', parseInt(qs.get('n') || '0', 10) || 0));
      return;
    }
    if (UI_PATHS.has(u)) {
      if (wantsUi(req)) { serveFile(req, res, 'index.html', 'text/html; charset=utf-8'); }
      else { sendJson(req, res, current === null ? [] : current, 'root as json (non-browser UA)'); }
      return;
    }
    // 其他任何路径都按数据端点容错处理, 避免路径填错导致 EQuake 拿不到数据 (同样走定时投递)
    sendJson(req, res, duePayload(), 'fallback data');
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
    if (u === '/clear') { current = null; QUEUE = []; Object.keys(EPOCH).forEach(k => delete EPOCH[k]); sendJson(req, res, { ok: true, queued: 0 }, 'cleared'); return; }
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
});

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
