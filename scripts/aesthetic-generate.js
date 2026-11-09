#!/usr/bin/env node
'use strict';
/*
 * sure-aesthetic : one text prompt (or a prompt file) -> generated image(s). Reference images
 *   are not taken this version - the create flow drops them server-side, so the interface says so.
 * The backend is asynchronous, so a single call is NOT how it works. Three steps per prompt:
 *   1) check the api_key and read the balance            (one read call, no task, no charge)
 *   2) create an image task                              -> data.task_result.task_id
 *      is_prompt MUST be false: true makes the server run its own prompt-enhancement branch,
 *      which feeds the model "[object Object]" instead of the user's words and still charges.
 *   3) poll that task until it finishes (or the wait window expires) and read out
 *      that task's result image                          -> data.task.images
 * Landing: the image is created on the platform under the user's own account, so nothing is
 *   written to their machine - the run reports the task id and points at their own preview
 *   workbench page. Those cards rotate after ~2 days; --links <task id> refreshes the card for
 *   nothing. A raw address is never printed: a link that dies in two days tells people less
 *   than the workbench entry does. A local copy (and the ledger CSV) happens only when
 *   output_dir in config points at a folder, which a reply never offers on its own.
 * A batch = the loop over that, one task per line, and it never stops at the first failure.
 * Every call authenticates with the api_key alone - no bearer token is exchanged or stored.
 * Never print the api_key or the request bodies.
 */
const fs = require('fs');
const path = require('path');

const MODELS = ['nano-banana-pro', 'nano-banana-2'];
const SIZES = ['2K'];
const TASK_STATUS = { 2: '排队中', 5: '生成中', 9: '已完成' };
const LEDGER_COLS = '批次ID,时间,产物文件,来源,参数摘要,状态';
const LEDGER_NAME = '_批次台账.csv';
const POLL_QUERY = 'mutation CheckSureKey($api_key: String!, $task_id: String!) { task: fz_invoke_action_flow_default_by_latest_version(actionFlowId: "ddc9ef24-5647-4f00-85cd-d51df9fbdbe3", args: { api_key: $api_key, task_id: $task_id }) }';
const CREATE_QUERY = 'mutation CreateImageGenTask($api_key: String!, $model_name: String!, $size: String, $image_urls: [String!], $is_prompt: Boolean, $prompt: String, $range: String, $channel: String) { task_result: fz_invoke_action_flow_default_by_latest_version(actionFlowId: "11404a7a-4aa9-21fc-30f0-1dc8fd1bcf9e", args: { api_key: $api_key, model_name: $model_name, size: $size, image_urls: $image_urls, is_prompt: $is_prompt, prompt: $prompt, range: $range, channel: $channel }) }';

// Aborting a whole batch is a different thing from one prompt failing: the outer loop only
// stops for the kinds of failure that would repeat on every remaining line (bad key, no
// balance, no network). A single GEN_FAILED is recorded and the batch walks on.
class Abort extends Error {
  constructor(f) { super(f.tag); this.payload = f; }
}

function fail(f) { return { tag: f.tag, msg: f.msg }; }

function loadConfig() {
  const p = path.join(__dirname, '..', 'config', 'config.json');
  if (!fs.existsSync(p)) {
    console.log('RESULT: FAIL NO_CONFIG');
    console.log('原因：还没有配置文件。这一步智能体自己做：把 config/config.example.json 复制成 config/config.json；等用户把官网账号里那串 sk- 发过来，由它写进 api_key 那一栏并保存，不要把他支去自己编辑文件。写进去之后这串值不再念回对话，打了码也不行。');
    process.exit(1);
  }
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); }
  catch (e) { console.log('RESULT: FAIL BAD_CONFIG'); console.log('原因：config/config.json 不是合法 JSON（' + e.message + '）。'); process.exit(1); }
  // api_key is what the user fills in. It is used directly on every call and never exchanged.
  if (!cfg.api_key || String(cfg.api_key).trim() === '') {
    console.log('RESULT: FAIL NO_API_KEY');
    console.log('原因：config/config.json 里 api_key 还空着。打开官网 www.sureflow-ai.com 注册登录，复制你自己账号里那串 sk- 开头的 api_key 发给智能体，由它写进这一栏；它写完只回一句「配好了」，不会把这串念回来。');
    process.exit(1);
  }
  if (String(cfg.api_key).startsWith('<')) {
    console.log('RESULT: FAIL NO_API_KEY');
    console.log('原因：api_key 还是模板占位符。去官网 www.sureflow-ai.com 登录自己的账号，把那串真实的 sk- 发给智能体，由它写进这一栏（写完不再念回对话）。');
    process.exit(1);
  }
  if (!cfg.gateway_url) {
    console.log('RESULT: FAIL NO_GATEWAY');
    console.log('原因：config/config.json 的 gateway_url 为空，请填服务方提供的接口地址。');
    process.exit(1);
  }
  return cfg;
}

const USAGE = '用法：单条  node scripts/aesthetic-generate.js --prompt "想要什么" [--model ...] [--range 3:4]\n'
  + '      一批  node scripts/aesthetic-generate.js --prompt-file "<清单.txt>"（一行一条，# 开头跳过）[--model ...] [--range ...]\n'
  + '      清单从哪儿来：自己写的 txt，或从飞书表格/Excel 那一列复制出来存成 txt - 都行，脚本只认「一行一条」\n'
  + '      刷新  node scripts/aesthetic-generate.js --links 9237,9236（按任务号把你工作台里那几张卡片刷新，不出图、不花钱）\n'
  + '      自检  node scripts/aesthetic-generate.js --check（只确认装好了没有：不出图、不建任务、不写任何文件）';

function parseArgs(cfg) {
  const a = process.argv.slice(2);
  const o = { prompt: '', promptFile: '', links: '', model: cfg.model || MODELS[0], size: cfg.size || '2K', range: cfg.range || '3:4', channel: cfg.channel || 'flagship', check: false };
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === '--check') o.check = true;
    else if (k === '--help' || k === '-h') { console.log(USAGE); process.exit(0); }
    else if (k === '--prompt') o.prompt = a[++i] || '';
    else if (k === '--prompt-file') o.promptFile = a[++i] || '';
    else if (k === '--links') o.links = a[++i] || '';
    else if (k === '--image-url' || k === '--local-image') {
      console.log('RESULT: FAIL REF_IMAGE_UNSUPPORTED');
      console.log('原因：这一版出图只按文字提示词生成，参考图不会被用到。把想要的画面写进那句话里就行（颜色、材质、光线、构图越具体越像）。');
      process.exit(1);
    } else if (k === '--model') o.model = a[++i] || o.model;
    else if (k === '--size') o.size = a[++i] || o.size;
    else if (k === '--range') o.range = a[++i] || o.range;
    else if (k === '--channel') o.channel = a[++i] || o.channel;
    else if (!k.startsWith('--') && !o.prompt) o.prompt = k;
  }
  if (o.prompt.trim() && o.promptFile) {
    console.log('RESULT: FAIL BOTH_INPUTS');
    console.log('原因：--prompt 和 --prompt-file 只能用一个。单条用 --prompt，一批把提示词写进一个 txt（一行一条）用 --prompt-file。');
    process.exit(1);
  }
  if (!o.prompt.trim() && !o.promptFile && !o.check && !o.links) { console.log(USAGE); process.exit(1); }
  if (!MODELS.includes(o.model)) { console.log('不支持的模型：' + o.model + '（可选 ' + MODELS.join(' / ') + '）'); process.exit(1); }
  if (!SIZES.includes(o.size)) { console.log('不支持的尺寸档：' + o.size + '（当前只承诺 ' + SIZES.join(' / ') + '）'); process.exit(1); }
  return o;
}

// readPrompts : one prompt per line. Blank lines and '#' comments are skipped, and a file
// that yields nothing is stopped here rather than sending an empty batch.
function readPrompts(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.log('RESULT: FAIL PROMPT_FILE_NOT_FOUND');
    console.log('原因：清单文件不存在：' + abs + '。确认路径（可以把文件拖进终端自动带出完整路径）。');
    process.exit(1);
  }
  const lines = fs.readFileSync(abs, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
  const out = [];
  lines.forEach((l, i) => {
    const t = l.trim();
    if (!t || t.startsWith('#')) return;
    out.push({ no: i + 1, text: t });
  });
  if (!out.length) {
    console.log('RESULT: FAIL PROMPT_FILE_EMPTY');
    console.log('原因：清单里一行可用的提示词都没有（' + abs + '）。一行一条，# 开头的是注释。');
    process.exit(1);
  }
  if (out.length > 50) {
    console.log('RESULT: FAIL BATCH_TOO_LARGE');
    console.log('原因：一次最多 50 条（这份清单有 ' + out.length + ' 条）。拆成几份分别跑，别一次压满。');
    process.exit(1);
  }
  return out;
}

// postGraphql : one GraphQL call, authenticated by api_key only - no bearer token anywhere.
// Failures on this link arrive as HTTP 200 with an ok:false payload, so the caller must
// inspect the body, not just the status code.
async function postGraphql(cfg, query, variables) {
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let res;
  try {
    res = await fetch(cfg.gateway_url, { method: 'POST', headers, body: JSON.stringify({ query, variables }), signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    throw new Abort(fail(FAILURES.NETWORK));
  }
  clearTimeout(timer);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Abort(fail(FAILURES.FAILED));
    if (res.status === 402) throw new Abort(fail(FAILURES.CREDIT));
    throw new Abort(fail(FAILURES.FAILED));
  }
  if (!json) throw new Abort(fail(FAILURES.FAILED));
  return json;
}

// pollPayload : the query flow answers with one JSON string in `payload`; anything unparsable
// means the call itself did not get through, which the caller reads as "no result".
function pollPayload(json) {
  const raw = json && json.data && json.data.task && json.data.task.payload;
  if (typeof raw !== 'string') return null;
  try { const p = JSON.parse(raw); return p && typeof p === 'object' ? p : null; } catch (e) { return null; }
}

// checkKey : the free, read-only call that proves the key works (no task, no charge).
async function checkKey(cfg) {
  return pollPayload(await postGraphql(cfg, POLL_QUERY, { api_key: cfg.api_key, task_id: '' }));
}


// failureOf : pull every message out of a 200 response that actually means "no"
function failureOf(json) {
  const parts = [];
  const push = (v) => { if (typeof v === 'string' && v) parts.push(v); };
  push(json.message); push(json.msg); push(json.error);
  if (Array.isArray(json.errors)) json.errors.forEach((e) => push(e && e.message));
  for (const key of ['task_result', 'task']) {
    const r = json.data && json.data[key];
    if (r && typeof r === 'object') {
      push(r.message); push(r.msg); push(r.task_message);
      if (r.result === false) parts.push('result:false');
      const p = key === 'task' ? pollPayload(json) : null;
      if (p && p.ok === false) { push(p.code); push(p.message); }
    }
  }
  return parts.join(' | ');
}

function classify(text) {
  const s = String(text || '').toLowerCase();
  if (/积分|余额|欠费|credit|quota|insufficient|balance/.test(s)) return FAILURES.CREDIT;
  if (/anonymous user|no permission on|permission on invocation|action flow/.test(s)) return FAILURES.DENIED;
  if (/api_key|apikey|密钥|unauthor|forbidden|invalid key|invalid token|token.*(invalid|expired)|未授权|无权限/.test(s)) return FAILURES.KEY;
  return FAILURES.FAILED;
}

// pickImageUrl : the query flow returns this task's result rows; the media column is the
// authoritative link, the text column holds the same link on older rows.
function pickImageUrl(results) {
  if (!Array.isArray(results)) return '';
  for (const r of results) {
    if (!r) continue;
    const media = r.ud_tupian_08f201 && r.ud_tupian_08f201.url;
    const hit = [media, r.ud_renwujieguo_c3567b].filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u))[0];
    if (hit) return hit;
  }
  return '';
}

// mediaReady : 这一张的「图片本体」那一格是否已经填上。工作台那张卡片是查询这一句顺带写进去的，
// 而服务端只认这一格；同一拍上那条文字地址往往先有值（pickImageUrl 的兜底），于是屏幕上报了任务号、
// 工作台里却没有这张图。卡片读的就是这一格，这一格没填上就不能算收工。
function mediaReady(results) {
  if (!Array.isArray(results)) return false;
  return results.some((r) => r && ((r.ud_tupian_08f201 && r.ud_tupian_08f201.url) || (r.ud_shipin_42b300 && r.ud_shipin_42b300.url)));
}

// settleMedia : 那一格还没填上就再免费读几次（同一条查询，不出图、不花钱），读到为止或到点为止。
async function settleMedia(cfg, taskId, results, budgetMs) {
  const until = Date.now() + budgetMs;
  while (!mediaReady(results)) {
    const again = pollPayload(await postGraphql(cfg, POLL_QUERY, { api_key: cfg.api_key, task_id: String(taskId) }));
    if (again && again.data && Array.isArray(again.data.results)) results = again.data.results;
    if (mediaReady(results) || Date.now() >= until) break;
    await sleep(3000);
  }
  return results;
}

function extOf(url, buf) {
  const m = (url || '').match(/\.(png|jpe?g|webp)(?:\?|#|$)/i);
  if (m) return m[1].toLowerCase() === 'jpeg' ? '.jpg' : '.' + m[1].toLowerCase();
  if (buf && buf.length > 12 && buf[0] === 0x89 && buf[1] === 0x50) return '.png';
  if (buf && buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  return '.png';
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function stamp(d) {
  const p2 = (n) => String(n).padStart(2, '0');
  return {
    day: '' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()),
    clock: p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()),
    full: d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()),
  };
}

// nextBatchId : B<yyyyMMdd>-<NN>, continuing from the ids already in the ledger so re-running
// the same day does not restart at 01. One run = one id, shared by every row it writes.
function nextBatchId(dir) {
  const file = path.join(dir, LEDGER_NAME);
  let text = '';
  if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const day = stamp(new Date()).day;
  const re = new RegExp('B' + day + '-(\\d{2})', 'g');
  let m, seq = 0;
  while ((m = re.exec(text)) !== null) seq = Math.max(seq, Number(m[1]));
  return 'B' + day + '-' + String(seq + 1).padStart(2, '0');
}

// flushLedger : 台账只在「这一趟真出了图」的时候才存在，一次写完。
// 真实事故：跑挂了、零产物，桌面根目录却凭空多出一张只写 FAIL:NO_CREDITS 的表。
// 失败走 RESULT 那一句给人读，不落文件；落了图才配占一个文件名。
function flushLedger(dir, rows) {
  if (!rows.some((r) => r.status === 'OK')) return null;
  const file = path.join(dir, LEDGER_NAME);
  const q = (v) => { const s = s0(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') : s; };
  const body = rows.map((it) => [it.batchId, stamp(new Date()).full, it.file, it.source, it.params, it.status].map(q).join(',')).join('\r\n') + '\r\n';
  const exist = fs.existsSync(file);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, (exist ? '' : LEDGER_COLS + '\r\n') + body, 'utf8');
  return file;
}

function s0(v) { return v === null || v === undefined ? '' : String(v); }

// outDirOf : 默认返回 null——图在自己账号的出图记录里，本机不落文件（成品不许凭空长到桌面）。
// output_dir 填了某个文件夹路径，才在本机另存一份，台账跟着那一份走；'desktop' 这个旧值按默认走，
// 免得手上还留着旧配置的人在桌面凭空长出夹子。
function outDirOf(cfg) {
  const v = String(cfg.output_dir || '').trim();
  if (!v || v === 'desktop') return null;
  return path.resolve(v);
}

// onePrompt : create the task, poll it through the query flow, download the image.
async function onePrompt(cfg, text, o, tagPrefix) {
  const created = await postGraphql(cfg, CREATE_QUERY, {
    api_key: cfg.api_key, model_name: o.model, size: o.size, image_urls: [],
    // 这一栏置 true 会让服务端先跑「提示词增强」，那一支把提示词写坏成 [object Object] 再喂模型。
    is_prompt: false, prompt: text, range: o.range, channel: o.channel,
  });
  const taskId = created && created.data && created.data.task_result && Number(created.data.task_result.task_id);
  if (!Number.isFinite(taskId) || taskId <= 0) {
    const f = classify(failureOf(created) || 'no task_id');
    return { ok: false, status: 'FAIL:' + f.tag, note: f.msg };
  }
  console.log(tagPrefix + '任务已创建 taskId=' + taskId);

  const waitSec = Math.max(60, Math.min(3600, Number(cfg.max_wait_sec) || 600));
  const pollSec = Math.max(2, Number(cfg.poll_interval_sec) || 5);
  const deadline = Date.now() + waitSec * 1000;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(pollSec * 1000);
    const got = await postGraphql(cfg, POLL_QUERY, { api_key: cfg.api_key, task_id: String(taskId) });
    const p = pollPayload(got);
    const task = p && p.data && p.data.task;
    if (p && p.ok === false) {
      const c = classify(failureOf(got));
      if (c !== FAILURES.FAILED) return { ok: false, status: 'FAIL:' + c.tag, note: c.msg };
      return { ok: false, status: 'FAIL:GEN_FAILED', note: FAILURES.FAILED.msg };
    }
    const status = task ? Number(task.ud_renwuzhuangtai_f9ec4e) : null;
    if (status !== last) { console.log(tagPrefix + '状态：' + (TASK_STATUS[status] || ('处理中(' + status + ')'))); last = status; }
    if (status === 9) {
      let results = p.data.results;
      let url = pickImageUrl(results);
      if (!url) return { ok: false, status: 'FAIL:GEN_FAILED', note: FAILURES.FAILED.msg };
      if (!mediaReady(results)) {
        results = await settleMedia(cfg, taskId, results, 15000);
        url = pickImageUrl(results) || url;
      }
      const dir = outDirOf(cfg);
      let name = '';
      if (dir) {
        // 只有用户自己要本机那一份时才下载：站内那条链接约 2 天就换，落盘的那份才是原件
        let img;
        try { img = await fetch(url); } catch (e) { throw new Abort(fail(FAILURES.NETWORK)); }
        if (!img.ok) return { ok: false, status: 'FAIL:GEN_FAILED', note: FAILURES.FAILED.msg };
        const buf = Buffer.from(await img.arrayBuffer());
        if (buf.length < 1024) return { ok: false, status: 'FAIL:GEN_FAILED', note: FAILURES.FAILED.msg };
        fs.mkdirSync(dir, { recursive: true });
        const st = stamp(new Date());
        name = 'aesthetic_' + st.day + '_' + st.clock + (tagPrefix ? '_' + o.seqTag : '') + extOf(url, buf);
        fs.writeFileSync(path.join(dir, name), buf);
      }
      return { ok: true, file: name, url: url, taskId: taskId, status: 'OK' };
    }
    if (status !== 2 && status !== 5 && status !== null && Number.isFinite(status)) {
      // unknown status: the platform has no documented failure code, so keep polling until the window closes
      console.log(tagPrefix + '任务状态 ' + status + '（未知），继续等待');
    }
  }
  return { ok: false, status: 'FAIL:NOT_COMPLETED', note: FAILURES.TIMEOUT.msg };
}

// linksOnly : 只读＋刷新自己那几张卡片。站内那条地址约 2 天滚动过期，图本身一直在账号里；
// 这一句把新地址写回用户工作台那一行，屏幕上不给原始地址（会过期的链接不如工作台入口有用）。
async function linksOnly(cfg, idsText) {
  const ids = String(idsText).split(/[,，\s]+/).filter((s) => /^\d+$/.test(s));
  if (!ids.length) {
    console.log('RESULT: FAIL BAD_TASK_IDS');
    console.log('原因：--links 后面要跟任务号，多个用逗号隔开，例如 --links 9237,9236');
    return 1;
  }
  let hit = 0;
  for (const id of ids) {
    const got = await postGraphql(cfg, POLL_QUERY, { api_key: cfg.api_key, task_id: id });
    const p = pollPayload(got);
    const task = p && p.data && p.data.task;
    if (!task) { console.log('任务号 ' + id + '：没查到这条任务（先确认是自己账号下的任务号）'); continue; }
    let results = p.data.results;
    let url = pickImageUrl(results);
    if (url && !mediaReady(results)) {
      results = await settleMedia(cfg, id, results, 9000);
      url = pickImageUrl(results) || url;
    }
    if (url) { hit++; console.log('任务号 ' + id + '：这一张还在，工作台里那张卡片已经刷新（约 2 天后又会点不开，再跑一次就行）'); }
    else {
      const st = Number(task.ud_renwuzhuangtai_f9ec4e);
      console.log('任务号 ' + id + '：这一张还没有图（当前状态：' + (TASK_STATUS[st] || st) + '）');
    }
  }
  if (hit) console.log('RESULT: OK 刷新了 ' + hit + ' 张，打开 https://www.sureflow-ai.com/m3lyajgm8#工作台-收图 就是它们；不出图、不花钱。');
  else console.log('RESULT: FAIL NO_LINK');
  return hit ? 0 : 1;
}

// FAILURES is declared after the helpers above use it - hoisting the object keeps the
// six user-facing conclusions in one place, next to the table in SKILL.md.
const FAILURES = {
  KEY:     { tag: 'KEY_INVALID',     msg: '密钥无效：请到官网 www.sureflow-ai.com 登录自己的账号核对 api_key（必要时换一把），把那串发给智能体，由它写进 config/config.json 这一栏，写完只回一句「配好了」再验。本次不产生消耗。' },
  DENIED:  { tag: 'SERVICE_DENIED',  msg: '这一步服务侧没放行：不是你这把钥匙的问题，也不会扣分。过一两分钟说一句「继续」再试；一直这样就把这句原话发给服务方。' },
  CREDIT:  { tag: 'NO_CREDITS',      msg: 'API 积分不够：去官网 www.sureflow-ai.com 充值 API 积分，即可生成。本次不产生消耗。' },
  TIMEOUT: { tag: 'NOT_COMPLETED',   msg: '本次未完成：任务还在排队，稍后用同一条口令再试即可，本次不重复计费。' },
  FAILED:  { tag: 'GEN_FAILED',      msg: '生成失败：本次不计费，可以换一种描述再试一次。' },
  NETWORK: { tag: 'NETWORK',         msg: '连不上服务：请检查本机网络后重试。' },
};

// The three conclusions that stop a whole batch: every remaining line would fail the same way.
const STOP_TAGS = ['KEY_INVALID', 'NO_CREDITS', 'SERVICE_DENIED', 'NETWORK'];

// selfCheck : the one command that proves the install is good. It checks Node, the config
// fields, whether the output folder is writable, and that the key still works -
// then stops. It never creates a task, never downloads, never writes a file.
async function selfCheck(cfg) {
  const major = Number(String(process.versions.node).split('.')[0]);
  console.log('· 本机 Node：v' + process.versions.node + (major >= 18 ? '（可用）' : '（太低，这个包要 18 以上）'));
  if (major < 18) { console.log('RESULT: FAIL NODE_TOO_OLD'); console.log('原因：需要 Node 18 以上，当前 v' + process.versions.node + '。'); return 1; }
  console.log('· 配置文件：已找到，api_key 这一项' + (/^\s*$/.test(String(cfg.api_key)) ? '还是空的' : '已填'));
  const dir = outDirOf(cfg);
  if (dir) {
    let writ = '';
    try {
      const probe = fs.existsSync(dir) ? dir : path.dirname(dir);
      fs.accessSync(probe, fs.constants.W_OK);
      writ = fs.existsSync(dir) ? '' : '（这个目录还没建，第一次出图时会自动建好）';
    } catch (e) { writ = '（写不进去，换个目录或给它权限）'; }
    console.log('· 本机另存一份：' + dir + writ);
    if (writ.indexOf('写不进去') >= 0) { console.log('RESULT: FAIL OUT_DIR_NOT_WRITABLE'); console.log('原因：保存目录写不进去：' + dir + '。'); return 1; }
  } else {
    console.log('· 出图落在：你自己的预览工作台（用自己账号打开 https://www.sureflow-ai.com/m3lyajgm8#工作台-收图），本机不存文件');
  }
  console.log('· 正在确认密钥能不能用（这一步不出图、不建任务、不花钱）…');
  let p;
  try {
    p = await checkKey(cfg);
  } catch (e) {
    if (e instanceof Abort) { console.log('RESULT: FAIL ' + e.payload.tag); console.log('原因：' + e.payload.msg); return 1; }
    throw e;
  }
  if (!p || !p.ok) { console.log('RESULT: FAIL ' + keyFailure(p)); return 1; }
  console.log('· 密钥可用，网络通。');
  if ((Number(p.data && p.data.credit_left) || 0) <= 0) console.log('· 提醒：这把密钥的 API 积分已用完，去官网 www.sureflow-ai.com 充值 API 积分后即可生成。');
  console.log('RESULT: OK');
  console.log('装好了，直接说要什么图就行；跑一批会把清单里每行各出一张，图都落在上面说的那个地方。');
  return 0;
}

// keyFailure : a refused key check is a key problem unless the message says otherwise.
// No readable answer at all is NOT evidence about the key - reporting it as a bad key sends
// the user off to re-register while our own link is what failed, so it says SERVICE_DENIED.
function keyFailure(p) {
  if (!p) return FAILURES.DENIED.tag;
  const text = String(p.code || '') + ' ' + String(p.message || '');
  const c = classify(text.toLowerCase());
  return (c === FAILURES.FAILED ? FAILURES.KEY : c).tag;
}

async function main() {
  const cfg = loadConfig();
  const o = parseArgs(cfg);
  if (o.check) { return await selfCheck(cfg); }
  if (o.links) {
    try {
      return await linksOnly(cfg, o.links);
    } catch (e) {
      if (e instanceof Abort) { console.log('RESULT: FAIL ' + e.payload.tag); console.log('原因：' + e.payload.msg); return 1; }
      throw e;
    }
  }
  const dir = outDirOf(cfg);
  const prompts = o.promptFile ? readPrompts(o.promptFile) : [{ no: 0, text: o.prompt.trim() }];
  const batch = prompts.length > 1 || !!o.promptFile;
  const source = o.promptFile ? '清单文件:' + path.basename(o.promptFile) : '单条口令';
  const params = o.model + ' ' + o.size + ' ' + o.range;

  console.log(batch ? ('本批 ' + prompts.length + ' 条，一条一个任务，逐条跑；正在生成，请稍候…')
                     : '正在为您生成图片，请稍候（排队加生成通常 1 分钟内）...');

  // 1) prove the key works before spending anything on a batch (read-only, not charged)
  let chk;
  try {
    chk = await checkKey(cfg);
  } catch (e) {
    if (e instanceof Abort) { console.log('RESULT: FAIL ' + e.payload.tag); console.log('原因：' + e.payload.msg); return 1; }
    throw e;
  }
  if (!chk || !chk.ok) {
    const f = keyFailure(chk);
    console.log('RESULT: FAIL ' + f);
    console.log('原因：' + (f === 'NO_CREDITS' ? FAILURES.CREDIT : f === 'SERVICE_DENIED' ? FAILURES.DENIED : f === 'NETWORK' ? FAILURES.NETWORK : FAILURES.KEY).msg);
    return 1;
  }
  if ((Number(chk.data && chk.data.credit_left) || 0) <= 0) {
    console.log('RESULT: FAIL NO_CREDITS'); console.log('原因：' + FAILURES.CREDIT.msg); return 1;
  }

  const done = [];
  const taskIds = [];
  const rows = [];
  let failed = 0;
  const batchId = dir ? nextBatchId(dir) : '';
  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    o.seqTag = String(i + 1).padStart(2, '0');
    const tagPrefix = batch ? ('[' + (i + 1) + '/' + prompts.length + '] ') : '';
    if (batch) console.log(tagPrefix + '提示词（第 ' + p.no + ' 行）：' + p.text.slice(0, 24) + (p.text.length > 24 ? '…' : ''));
    let r;
    try {
      r = await onePrompt(cfg, p.text, o, tagPrefix);
    } catch (e) {
      if (e instanceof Abort) r = { ok: false, status: 'FAIL:' + e.payload.tag, note: e.payload.msg };
      else throw e;
    }
    const item = {
      batchId,
      file: r.file || '-',
      source,
      params: params + ' ' + p.text.slice(0, 24).replace(/[\r\n]+/g, ' '),
      status: r.status,
    };
    if (!r.ok && STOP_TAGS.indexOf(r.status.replace('FAIL:', '')) >= 0) {
      // Key / balance / network would fail every remaining line the same way, so the batch
      // stops here - but this line still goes into the ledger, and the RESULT line is the
      // one conclusion the user-facing table keys on.
      rows.push(item);
      if (dir) flushLedger(dir, rows);
      failed++;
      console.log('RESULT: FAIL ' + r.status.replace('FAIL:', ''));
      console.log('原因：' + r.note + '（这一批停在这里，已生成的图不重跑、不重复计费）');
      if (batch) console.log('已完成 ' + done.length + ' 张，未跑 ' + (prompts.length - done.length - failed) + ' 条');
      return 1;
    }
    rows.push(item);
    if (r.ok) {
      if (dir) console.log(tagPrefix + '已保存：' + path.join(dir, r.file) + '（批次 ' + batchId + '）');
      else console.log(tagPrefix + '已完成：任务号 ' + r.taskId + '｜这一张在你自己的预览工作台那一屏里');
      done.push(r.file || ('任务' + r.taskId));
      taskIds.push(r.taskId);
    } else {
      failed++;
      console.log(tagPrefix + '本条未完成：' + r.note + (dir ? '（台账状态 ' + r.status + '，批次 ' + batchId + '）' : '（状态 ' + r.status + '，本次不计费）'));
    }
  }

  const ledFile = dir ? flushLedger(dir, rows) : null;
  if (done.length) {
    console.log('这一批的图都在你自己的预览工作台那一屏里（上面每行的任务号就是它的编号）：用自己账号打开 https://www.sureflow-ai.com/m3lyajgm8#工作台-收图，勾一张或整批「送到画布」能接着局部重绘、扩图、当垫图再出。');
    const idList = taskIds.slice(0, 5).join(',') + (taskIds.length > 5 ? ' 等' + taskIds.length + '条' : '');
    const many = taskIds.length > 1;
    console.log('那一屏上的卡片大约 2 天后会点不开（图本身一直在），跟我说一句「把 ' + idList + ' 那' + (many ? '几条' : '一条') + '再给我一次」，我跑 --links 免费把' + (many ? '它们' : '它') + '刷新回来，不出图、不花钱。');
  }
  if (batch) {
    console.log('本批 ' + prompts.length + ' 条：成功 ' + done.length + ' 张，未完成 ' + failed + ' 条'
      + (batchId ? '（批次 ' + batchId + '）' : '（图都在你自己账号的出图记录里，按上面的任务号找）'));
    if (ledFile) console.log('台账：' + ledFile);
  }
  if (failed) {
    console.log('RESULT: FAIL PARTIAL');
    console.log('说明：上面每一张成的图都已经在你自己账号里了' + (dir ? '，本机那一份在 ' + dir : '') + '，未完成的条目本次不计费，可以只把那几条再跑一遍。');
    return 1;
  }
  console.log('RESULT: OK');
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((e) => {
  if (e instanceof Abort) { console.log('RESULT: FAIL ' + e.payload.tag); console.log('原因：' + e.payload.msg); process.exitCode = 1; return; }
  console.log('RESULT: FAIL FATAL');
  console.log('原因：' + (e && e.message ? e.message : String(e)));
  process.exitCode = 1;
});
