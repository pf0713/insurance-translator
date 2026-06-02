/**
 * 保险条款翻译器 - AI 代理后端 v2.0
 * 纯 Node.js 内置模块，无需 npm install
 * 启动: node server.js
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

// ==================== 配置 ====================
const PORT = 8765;
const LOG_LEVEL = process.env.LOG_LEVEL || 'info'; // 'quiet' | 'info'
const log = LOG_LEVEL === 'quiet' ? () => {} : console.log.bind(console);
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:8765';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
const AI_KEY = process.env.AI_KEY;
if (!AI_KEY) {
  console.error('[错误] 请设置环境变量 AI_KEY（DeepSeek API Key）');
  process.exit(1);
}
const AUTH_TOKEN = process.env.API_TOKEN || 'insurance-translator-dev-2024';

const AI = {
  baseURL: 'https://api.deepseek.com',
  apiKey: AI_KEY,
  model: 'deepseek-chat',
  temperature: 0.3,
  maxTokens: 3000,
};
const DATA_DIR = path.join(__dirname, 'data');
const TERMS_FILE = path.join(DATA_DIR, 'terms_dynamic.json');
const TERMS_GENERAL_FILE = path.join(DATA_DIR, 'terms_general.json');
const COMPANIES_FILE = path.join(DATA_DIR, 'companies.json');

// ==================== 数据读写 ====================
function loadJSON(filePath, fallback = []) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (_) {}
  return fallback;
}
function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// 互斥锁：串行化 "读取→修改→写入" 操作，防止并发覆盖
let dataLock = Promise.resolve();
function withLock(fn) {
  return new Promise((resolve) => {
    dataLock = dataLock.then(() => Promise.resolve(fn()).then(resolve));
  });
}

// 动态保险术语库
let dynamicTerms = loadJSON(TERMS_FILE);
function reloadTerms() { dynamicTerms = loadJSON(TERMS_FILE); }
function addDynamicTerm(term, explanation) {
  return withLock(() => {
    reloadTerms();
    const exists = dynamicTerms.find(t => t.term === term);
    if (exists) return false;
    dynamicTerms.push({ term, explanation, addedAt: new Date().toISOString() });
    saveJSON(TERMS_FILE, dynamicTerms);
    return true;
  });
}

// 通用词库（非保险术语的普通解释）
let generalTerms = loadJSON(TERMS_GENERAL_FILE);
function reloadGeneralTerms() { generalTerms = loadJSON(TERMS_GENERAL_FILE); }
function addGeneralTerm(term, explanation) {
  return withLock(() => {
    reloadGeneralTerms();
    const exists = generalTerms.find(t => t.term === term);
    if (exists) return false;
    generalTerms.push({ term, explanation, addedAt: new Date().toISOString() });
    saveJSON(TERMS_GENERAL_FILE, generalTerms);
    return true;
  });
}

// 保险公司库
let companiesDB = loadJSON(COMPANIES_FILE, []);
function reloadCompanies() { companiesDB = loadJSON(COMPANIES_FILE, []); }
function findCompany(name) {
  reloadCompanies();
  return companiesDB.find(c => c.name === name || c.name.includes(name) || (c.aliases || []).includes(name));
}
function getOrCreateCompany(name, info) {
  return withLock(() => {
    reloadCompanies();
    let c = findCompany(name);
    if (c) return c;
    c = { name, ...info, addedAt: new Date().toISOString() };
    companiesDB.push(c);
    saveJSON(COMPANIES_FILE, companiesDB);
    return c;
  });
}

// ==================== AI 调用 ====================
function aiChat(messages, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(AI.baseURL + '/v1/chat/completions');
    const reqBody = {
      model: AI.model,
      messages,
      temperature: opts.temperature || AI.temperature,
      max_tokens: opts.maxTokens || AI.maxTokens,
    };
    if (opts.fileIds) reqBody.file_ids = opts.fileIds;
    const body = JSON.stringify(reqBody);

    const req = https.request({
      hostname: url.hostname, port: 443, path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI.apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 60000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message));
          resolve(json.choices[0].message.content);
        } catch (e) {
          reject(new Error('AI 响应解析失败: ' + data.slice(0, 300)));
        }
      });
    });
    req.on('error', e => reject(new Error('AI 连接失败: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('AI 超时')); });
    req.write(body);
    req.end();
  });
}

// 带图片的 AI 调用 — 使用 OpenAI vision 格式
async function aiChatWithImage(messages, imageBase64) {
  // 清洗 base64（去掉可能的换行和空格）
  const cleanBase64 = imageBase64.replace(/[\r\n\s]/g, '');
  const dataUrl = `data:image/jpeg;base64,${cleanBase64}`;

  const text = messages[0].content;
  messages[0].content = [
    { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } },
    { type: 'text', text: text },
  ];

  log('[图片] 使用 vision 格式发送, base64大小:', (cleanBase64.length / 1024).toFixed(0) + 'KB');
  return aiChat(messages);
}

// PDF 文本提取
async function extractPDFText(base64Data) {
  const buffer = Buffer.from(base64Data, 'base64');
  const data = await pdfParse(buffer);
  log('[PDF] 提取文本:', data.text.length, '字, 页数:', data.numpages);
  return data.text;
}

// ==================== AI 功能 ====================

// 1. AI 智能翻译（整句翻译）
async function aiTranslate(text) {
  return aiChat([
    { role: 'system', content: `你是资深保险条款解读专家，擅长把复杂条款翻译成大白话。
规则：
1. 逐句翻译，不遗漏
2. 专业术语换成口语表达（"被保险人"→"受保障的人"，"不承担保险责任"→"不赔"）
3. 括号标注重要数字和提示
4. 输出格式：【大白话版】+【关键提示】（3-5条要点）` },
    { role: 'user', content: `翻译这段条款：${text}` },
  ]);
}

// 2. AI 解释术语 + 自动入库（保险术语→保险库，其他→通用库，风险内容→拒绝）
async function aiExplainTerm(term, context = '') {
  const ctx = context ? `\n语境：${context}` : '';
  const raw = await aiChat([
    { role: 'system', content: `你是一个智能解释助手。根据用户输入的内容做以下判断和操作：

【第一步：安全检查】
如果该内容涉及政治敏感、色情、赌博、暴力恐怖、违法信息等风险内容，回复：RISKY
否则继续下一步。

【第二步：分类与解释】
- 如果是保险/金融行业的专业术语 → 用大白话解释（1-3句话）
- 如果不是保险术语，但仍是可以正常解释的词汇或概念 → 也用大白话解释
- 在解释前面加上类别标记：[INSURANCE] 或 [GENERAL]

输出格式：
- 风险内容 → 只回复 RISKY
- 保险术语 → [INSURANCE] + 解释内容
- 普通词汇 → [GENERAL] + 解释内容` },
    { role: 'user', content: `请判断并解释："${term}"${ctx}` },
  ], { temperature: 0.1, maxTokens: 300 });

  const result = raw.trim();

  // 风险内容拒绝
  if (result === 'RISKY') {
    return { isTerm: false, isGeneral: false, isRisky: true, explanation: '抱歉，该内容涉及风险领域，无法回答。' };
  }

  // 保险术语 → 保险库
  if (result.startsWith('[INSURANCE]')) {
    const explanation = result.replace('[INSURANCE]', '').trim();
    const added = await addDynamicTerm(term, explanation);
    return { isTerm: true, isGeneral: false, isRisky: false, explanation, addedToDict: added, category: 'insurance' };
  }

  // 普通词汇 → 通用库
  if (result.startsWith('[GENERAL]')) {
    const explanation = result.replace('[GENERAL]', '').trim();
    const added = await addGeneralTerm(term, explanation);
    return { isTerm: false, isGeneral: true, isRisky: false, explanation, addedToDict: added, category: 'general' };
  }

  // 兜底：AI 没按格式回复但内容正常 → 按通用词处理
  const added = await addGeneralTerm(term, result);
  return { isTerm: false, isGeneral: true, isRisky: false, explanation: result, addedToDict: added, category: 'general' };
}

// 3. AI 分析图片中的保险内容
async function aiAnalyzeImage(base64Image) {
  return aiChatWithImage([
    { role: 'user', content: `这张图片中包含保险相关的内容（条款、合同、通知、报价单等）。请：
1. 识别并提取其中所有保险相关的文字和术语
2. 把保险术语逐条用大白话解释
3. 如果整体是一段条款，给出大白话版翻译
4. 如果有对消费者不利的条款（免责、等待期、高免赔额等），重点标注出来
输出格式：【识别内容】→【术语解释列表】→【大白话翻译/解读】→【避坑提醒】` },
  ], base64Image);
}

// 4. AI 分析文件内容
async function aiAnalyzeFile(textContent) {
  const MAX = 12000;
  const truncated = textContent.length > MAX;
  const content = textContent.slice(0, MAX);
  const note = truncated ? `\n\n（注：原文件共${textContent.length}字，已截取前${MAX}字分析。如需分析完整内容，请分段提交。）` : '';

  return aiChat([
    { role: 'system', content: `你是保险文件分析专家。分析保险相关的文件内容。
输出格式：【文件内容摘要】→【关键术语解释】→【消费者须知】→【潜在风险提示】` },
    { role: 'user', content: `分析以下文件中的保险相关内容：\n\n${content}${note}` },
  ]);
}

// 5. AI 智能对比 + 公司综合对比（支持多方案）
async function aiCompareMulti(policies) {
  // policies: [{ clause, company?, label? }]
  const n = policies.length;
  const labels = policies.map((p, i) => p.label || String.fromCharCode(65 + i));

  // 构建条款内容
  let clauseSection = '';
  policies.forEach((p, i) => {
    clauseSection += `\n【${labels[i]}】${p.clause}`;
  });

  // 构建公司背景
  let companySection = '\n\n【保险公司背景】';
  policies.forEach((p, i) => {
    if (p.company) {
      const c = findCompany(p.company) || { name: p.company };
      companySection += `\n${labels[i]}对应公司: ${p.company} (类型:${c.type || '未知'}, 偿付能力:${c.solvency_ratio || '未知'}, 理赔效率:${c.claims_efficiency || '未知'})`;
    }
  });

  // 动态生成对比表格的表头
  const tableHeaders = labels.map(l => `方案${l}`).join(' | ');
  const tableSep = labels.map(() => '---').join(' | ');

  return aiChat([
    { role: 'system', content: `你是资深保险产品对比分析专家。请用·分项对比（不要用表格），格式如下：

## 📊 条款对比
· 保障范围：方案A - ...；方案B - ...（标注哪个更优✅）
· 免赔额：方案A - ...；方案B - ...
· 赔付比例：方案A - ...；方案B - ...
· 等待期：方案A - ...；方案B - ...
· 免责条款：方案A - ...；方案B - ...
· 保费/保额：方案A - ...；方案B - ...
· 续保条件：方案A - ...；方案B - ...

## 🏢 保险公司对比
· 公司规模：A - ...；B - ...
· 偿付能力：A - ...；B - ...
· 理赔效率：A - ...；B - ...
· 服务网络：A - ...；B - ...
· 投诉率：A - ...；B - ...

## 💡 综合建议
· 追求性价比 → 选...
· 追求理赔体验 → 选...
· 最终推荐及理由
${n > 2 ? '· 对所有' + n + '个方案按推荐度排序' : ''}` },
    { role: 'user', content: `对比以下${n}个保险方案：${clauseSection}${companySection}` },
  ], { maxTokens: 3000 });
}

// 6. AI 自动识别未入库术语并解释
async function aiDiscoverNewTerms(text) {
  const result = await aiChat([
    { role: 'system', content: `你是一个保险术语提取器。从文本中提取所有保险专业术语，每个术语给一句大白话解释。
只提取真正的保险专有术语（如"被保险人""免赔额""等待期""现金价值""偿付能力"等），不要提取普通词语。
输出格式：每行一个术语，格式为"术语|解释"。
如果没有保险术语，回复 NONE。` },
    { role: 'user', content: text },
  ], { temperature: 0.1, maxTokens: 1000 });

  if (result.trim() === 'NONE') return [];

  const discovered = [];
  for (const line of result.split('\n').map(l => l.trim()).filter(Boolean)) {
    const parts = line.split('|');
    if (parts.length >= 2) {
      const term = parts[0].trim();
      const explanation = parts.slice(1).join('|').trim();
      if (term && explanation) {
        const added = await addDynamicTerm(term, explanation);
        discovered.push({ term, explanation, isNew: added });
      }
    }
  }
  return discovered;
}

// 7. 保险报价对比
async function aiQuoteCompare(policies) {
  const n = policies.length;
  const labels = policies.map((p, i) => p.label || String.fromCharCode(65 + i));

  let quoteSection = '';
  policies.forEach((p, i) => {
    quoteSection += `\n【${labels[i]}】公司: ${p.company} | 报价: ${p.premium || '未填'} | 详情: ${p.clause}`;
  });

  return aiChat([
    { role: 'system', content: `你是资深保险产品对比专家，精通车险、医疗险、重疾险、意外险等各种险种的报价分析。

第一步：先识别每个方案的险种类型

第二步：用·分项对比（不要用表格），格式如下：

## 🔍 险种识别
· 方案A：[险种类型]
· 方案B：[险种类型]
（如果险种不同，单独说明：不同险种不可直接比价格，以下是各自方案的独立分析）

## 📊 逐项对比
（根据实际险种调整对比维度）
· 保险公司：A - xxx；B - xxx
· 总保费：A - xxx；B - xxx
· 核心保额：A - xxx；B - xxx
· 免赔额/起付线：A - xxx；B - xxx
· 赔付比例：A - xxx；B - xxx
· 等待期/观察期：A - xxx；B - xxx
· 保障期限：A - xxx；B - xxx
· 免责条款关键点：A - xxx；B - xxx

## 🏢 公司对比
· 理赔效率：A - ...；B - ...
· 偿付能力：A - ...；B - ...
· 服务口碑：A - ...；B - ...

## 💡 专家建议
· 性价比最高：...
· 保障最全：...
· 最终推荐及理由
· 特别提醒注意的坑
（如果险种不同，说明各自适用场景，不强行比较价格）` },
    { role: 'user', content: `对比以下${n}个保险报价方案：${quoteSection}` },
  ], { maxTokens: 3000 });
}

// 7. 保单说明对话（无限多轮）
async function aiPolicyChat(policyText, message, history = []) {
  const messages = [
    { role: 'system', content: `你是资深保险解读专家，擅长用大白话解释保险条款。你的任务是帮用户理解保单内容、回答相关问题。

规则：
1. 用大白话回答，不要用保险术语（如果必须用，立即用括号解释）
2. 回答简洁明了，像朋友聊天一样
3. 如果用户问的问题保单里没有，诚实告知并给出通用建议
4. 关键风险点（免赔高、等待期长、免责多）要主动提醒
5. 用·符号分点，不要用表格

以下是用户上传的保单内容，以此为准回答问题：
---
${policyText}
---` },
  ];

  // 添加历史对话
  for (const h of history) {
    messages.push({ role: h.role, content: h.content });
  }
  // 添加当前问题
  messages.push({ role: 'user', content: message });

  return aiChat(messages, { maxTokens: 2000, temperature: 0.3 });
}

// ==================== HTTP 服务 ====================
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // auth check (skip for health)
  if (url.pathname !== '/api/health' && !checkAuth(req)) {
    return sendJSON(res, { error: '未授权访问' }, 401);
  }

  try {
    // ──── 健康检查 ────
    if (url.pathname === '/api/health' && req.method === 'GET') {
      return sendJSON(res, {
        status: 'ok',
        staticTerms: '260+',
        dynamicTerms: dynamicTerms.length,
        generalTerms: generalTerms.length,
        companies: companiesDB.length,
        ai: 'ready'
      });
    }

    // ──── AI 翻译 ────
    if (url.pathname === '/api/ai/translate' && req.method === 'POST') {
      const { text } = await readJSON(req);
      if (!text?.trim()) return sendJSON(res, { error: '请输入条款内容' }, 400);
      log('[翻译]', text.slice(0, 80));
      const result = await aiTranslate(text.trim());
      // 同时发现新术语
      const discovered = await aiDiscoverNewTerms(text.trim()).catch(() => []);
      log('[翻译] 完成, 发现新术语:', discovered.length);
      return sendJSON(res, { result, discoveredTerms: discovered });
    }

    // ──── AI 解释术语（自动入库） ────
    if (url.pathname === '/api/ai/explain-term' && req.method === 'POST') {
      const { term, context } = await readJSON(req);
      if (!term?.trim()) return sendJSON(res, { error: '请提供术语' }, 400);
      log('[术语解释]', term);
      const result = await aiExplainTerm(term.trim(), context || '');
      return sendJSON(res, {
        term: term.trim(),
        isTerm: result.isTerm,
        explanation: result.explanation,
        addedToDict: result.addedToDict,
        dynamicTotal: dynamicTerms.length,
      });
    }

    // ──── AI 分析图片 ────
    if (url.pathname === '/api/ai/analyze-image' && req.method === 'POST') {
      const { imageBase64 } = await readJSON(req);
      if (!imageBase64) return sendJSON(res, { error: '请提供图片数据' }, 400);
      log('[图片分析] 数据大小:', (imageBase64.length / 1024).toFixed(0) + 'KB');
      const result = await aiAnalyzeImage(imageBase64);
      log('[图片分析] 完成');
      return sendJSON(res, { result });
    }

    // ──── AI 分析 PDF ────
    if (url.pathname === '/api/ai/analyze-pdf' && req.method === 'POST') {
      const { fileBase64, fileName } = await readJSON(req);
      if (!fileBase64) return sendJSON(res, { error: '请提供PDF文件数据' }, 400);
      log('[PDF分析] 文件:', fileName, '大小:', (fileBase64.length / 1024).toFixed(0) + 'KB');
      try {
        const pdfText = await extractPDFText(fileBase64);
        log('[PDF分析] 提取文本:', pdfText.length, '字');
        const result = await aiAnalyzeFile(pdfText);
        return sendJSON(res, { result, extractedText: pdfText.slice(0, 500) + (pdfText.length > 500 ? '...' : '') });
      } catch (e) {
        console.error('[PDF分析] 失败:', e.message);
        return sendJSON(res, { error: 'PDF解析失败: ' + e.message }, 500);
      }
    }

    // ──── AI 分析文件 ────
    if (url.pathname === '/api/ai/analyze-file' && req.method === 'POST') {
      const { textContent } = await readJSON(req);
      if (!textContent?.trim()) return sendJSON(res, { error: '请提供文件文本内容' }, 400);
      log('[文件分析] 文本长度:', textContent.length);
      const result = await aiAnalyzeFile(textContent.trim());
      log('[文件分析] 完成');
      return sendJSON(res, { result });
    }

    // ──── AI 高级对比（支持多方案） ────
    if (url.pathname === '/api/ai/compare' && req.method === 'POST') {
      const body = await readJSON(req);
      // 兼容旧格式
      let policies = body.policies;
      if (!policies && body.clauseA && body.clauseB) {
        policies = [
          { clause: body.clauseA, company: body.companyA, label: 'A' },
          { clause: body.clauseB, company: body.companyB, label: 'B' },
        ];
      }
      if (!policies || !Array.isArray(policies) || policies.length < 2) {
        return sendJSON(res, { error: '请至少提供2个方案的条款' }, 400);
      }
      log('[对比]', policies.length, '个方案');
      const result = await aiCompareMulti(policies);
      log('[对比] 完成');
      return sendJSON(res, { result });
    }

    // ──── 车险报价对比 ────
    if (url.pathname === '/api/ai/quote-compare' && req.method === 'POST') {
      const body = await readJSON(req);
      const policies = body.policies;
      if (!policies || !Array.isArray(policies) || policies.length < 2) {
        return sendJSON(res, { error: '请至少提供2个保险报价方案' }, 400);
      }
      log('[报价对比]', policies.length, '家报价');
      const result = await aiQuoteCompare(policies);
      log('[报价对比] 完成');
      return sendJSON(res, { result });
    }

    // ──── 保单说明对话 ────
    if (url.pathname === '/api/ai/chat' && req.method === 'POST') {
      const { policyText, message, history } = await readJSON(req);
      if (!policyText?.trim() || !message?.trim()) {
        return sendJSON(res, { error: '请提供保单内容和问题' }, 400);
      }
      log('[对话]', message.slice(0, 60));
      const reply = await aiPolicyChat(policyText.trim(), message.trim(), history || []);
      log('[对话] 完成');
      return sendJSON(res, { reply });
    }

    // ──── 保险公司库 ────
    if (url.pathname === '/api/companies' && req.method === 'GET') {
      reloadCompanies();
      const search = url.searchParams.get('q');
      if (search) {
        const q = search.toLowerCase();
        return sendJSON(res, companiesDB.filter(c =>
          c.name.toLowerCase().includes(q) || (c.aliases || []).some(a => a.toLowerCase().includes(q))
        ));
      }
      return sendJSON(res, companiesDB);
    }

    if (url.pathname === '/api/companies' && req.method === 'POST') {
      const data = await readJSON(req);
      const c = await getOrCreateCompany(data.name, data);
      return sendJSON(res, c);
    }

    // ──── 动态术语库 ────
    if (url.pathname === '/api/terms/dynamic' && req.method === 'GET') {
      reloadTerms();
      return sendJSON(res, dynamicTerms);
    }

    // ──── 通用词库 ────
    if (url.pathname === '/api/terms/general' && req.method === 'GET') {
      reloadGeneralTerms();
      return sendJSON(res, generalTerms);
    }

    // ──── AI 自动发现术语 ────
    if (url.pathname === '/api/ai/discover-terms' && req.method === 'POST') {
      const { text } = await readJSON(req);
      if (!text?.trim()) return sendJSON(res, { error: '请输入文本' }, 400);
      log('[发现术语]', text.slice(0, 80));
      const discovered = await aiDiscoverNewTerms(text.trim());
      log('[发现术语] 完成, 新术语:', discovered.filter(d => d.isNew).length);
      return sendJSON(res, { discovered, dynamicTotal: dynamicTerms.length });
    }

    // ──── 404 ────
    sendJSON(res, { error: '接口不存在' }, 404);

  } catch (e) {
    console.error('[错误]', e.message);
    sendJSON(res, { error: e.message || '服务器内部错误' }, 500);
  }
});

// ==================== 辅助 ====================
function checkAuth(req) {
  const url = new URL(req.url, `http://localhost`);
  const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token');
  return token === AUTH_TOKEN;
}

function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  }, corsHeaders()));
  res.end(body);
}

function readJSON(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    const MAX = 20 * 1024 * 1024; // 20MB 上限
    req.on('data', c => {
      size += c.length;
      if (size > MAX) { req.destroy(); reject(new Error('请求体过大，上限20MB')); return; }
      body += c;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

server.listen(PORT, '0.0.0.0', () => {
  // 确保数据文件存在
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(TERMS_FILE)) saveJSON(TERMS_FILE, []);
  if (!fs.existsSync(TERMS_GENERAL_FILE)) saveJSON(TERMS_GENERAL_FILE, []);
  if (!fs.existsSync(COMPANIES_FILE)) { saveJSON(COMPANIES_FILE, COMPANIES_SEED); }
  reloadCompanies(); reloadTerms(); reloadGeneralTerms();

  console.log(`
╔══════════════════════════════════════════════╗
║   🛡️  保险条款翻译器 - AI 后端 v2.0        ║
║                                              ║
║   地址: http://localhost:${PORT}                ║
║                                              ║
║   API 接口:                                  ║
║   POST /api/ai/translate       AI翻译       ║
║   POST /api/ai/explain-term    术语解释+入库 ║
║   POST /api/ai/analyze-image   图片分析      ║
║   POST /api/ai/analyze-file    文件分析      ║
║   POST /api/ai/compare         条款对比      ║
║   POST /api/ai/quote-compare   保险报价对比  ║
║   POST /api/ai/discover-terms  发现新术语    ║
║   POST /api/ai/chat            保单说明对话  ║
║   POST /api/ai/analyze-pdf     PDF文件解析   ║
║   GET  /api/companies          保险公司库    ║
║   GET  /api/terms/dynamic      动态术语库    ║
║   GET  /api/health             健康检查      ║
║                                              ║
║   按 Ctrl+C 关闭                             ║
╚══════════════════════════════════════════════╝
`);
});

// ==================== 保险公司种子数据 ====================
const COMPANIES_SEED = [
  {
    name: '中国人寿', aliases: ['国寿', '中国人寿保险'],
    type: 'large', established: 1949,
    assets: '超6万亿', solvency_ratio: '260%+',
    risk_capacity: '极强（央企、全球最大寿险公司之一）',
    claims_efficiency: '平均3-5个工作日，网点覆盖最广',
    claims_rate: '99%+',
    complaints_rank: '中等（体量大，投诉绝对量多但相对比率低）',
    network: '全国所有省市县，乡镇级服务点',
    features: ['央企背景最稳', '全国网点最多', '理赔流程成熟', '产品线最全'],
    weaknesses: ['产品创新偏保守', '部分产品定价偏贵', '线上体验一般'],
  },
  {
    name: '中国平安', aliases: ['平安', '平安保险'],
    type: 'large', established: 1988,
    assets: '超11万亿', solvency_ratio: '240%+',
    risk_capacity: '极强（综合金融集团、科技投入大）',
    claims_efficiency: '平均2-3个工作日，"闪赔"技术领先',
    claims_rate: '99%+',
    complaints_rank: '中等偏高（业务量大）',
    network: '全国所有省市，线上线下融合最好',
    features: ['科技赋能理赔快', '综合金融服务', '产品创新能力强', 'APP体验好'],
    weaknesses: ['保费偏贵', '销售导向强', '部分产品条款复杂'],
  },
  {
    name: '中国太保', aliases: ['太保', '太平洋保险', '太平洋'],
    type: 'large', established: 1991,
    assets: '超2万亿', solvency_ratio: '250%+',
    risk_capacity: '极强（上海国资背景）',
    claims_efficiency: '平均3-7个工作日',
    claims_rate: '98%+',
    complaints_rank: '中等',
    network: '全国主要省市',
    features: ['经营稳健', '产品性价比尚可', '上海本地服务强'],
    weaknesses: ['品牌影响力不如国寿和平安', '线上化程度一般'],
  },
  {
    name: '泰康保险', aliases: ['泰康', '泰康人寿'],
    type: 'large', established: 1996,
    assets: '超1.5万亿', solvency_ratio: '250%+',
    risk_capacity: '强（养老社区布局领先）',
    claims_efficiency: '平均3-5个工作日',
    claims_rate: '98%+',
    complaints_rank: '中等偏低',
    network: '全国主要省市',
    features: ['养老社区"泰康之家"行业领先', '医养结合', '年金产品有特色'],
    weaknesses: ['部分产品绑定养老社区', '入门门槛高'],
  },
  {
    name: '新华保险', aliases: ['新华', '新华人寿'],
    type: 'large', established: 1996,
    assets: '超1万亿', solvency_ratio: '240%+',
    risk_capacity: '强（A+H股上市）',
    claims_efficiency: '平均5-7个工作日',
    claims_rate: '97%+',
    complaints_rank: '中等',
    network: '全国主要省市',
    features: ['产品线齐全', '重疾险有一定口碑'],
    weaknesses: ['近年增长放缓', '代理人队伍缩减'],
  },
  {
    name: '众安保险', aliases: ['众安', '众安在线'],
    type: 'internet', established: 2013,
    assets: '中等', solvency_ratio: '400%+',
    risk_capacity: '中等偏强（互联网保险龙头、蚂蚁/腾讯/平安合资）',
    claims_efficiency: '小额理赔秒级到账，线上化100%',
    claims_rate: '96%+',
    complaints_rank: '中等偏高（互联网模式投诉率天然偏高）',
    network: '纯线上，无线下网点',
    features: ['百万医疗险开创者', '纯线上体验流畅', '产品创新快', '保费有竞争力'],
    weaknesses: ['无线下服务', '续保稳定性待观察', '体量远小于传统大公司'],
  },
  {
    name: '信泰人寿', aliases: ['信泰', '信泰保险'],
    type: 'medium', established: 2007,
    assets: '超千亿', solvency_ratio: '160%+',
    risk_capacity: '中等（近年偿付能力偏紧，需关注）',
    claims_efficiency: '平均7-15个工作日',
    claims_rate: '95%+',
    complaints_rank: '偏高（重疾险纠纷较多）',
    network: '主要省市有分支机构',
    features: ['重疾险性价比极高', '产品创新大胆', '保额高保费低'],
    weaknesses: ['偿付能力偏低', '理赔体验参差不齐', '服务能力有限'],
  },
  {
    name: '百年人寿', aliases: ['百年', '百年保险'],
    type: 'medium', established: 2009,
    assets: '中等', solvency_ratio: '130%+（偏低）',
    risk_capacity: '偏低（偿付能力低于行业平均、曾因治理问题被监管关注）',
    claims_efficiency: '平均7-15个工作日，个案差异大',
    claims_rate: '93%+',
    complaints_rank: '偏高',
    network: '部分省市',
    features: ['产品定价激进（对消费者有利）', '网销产品性价比高'],
    weaknesses: ['偿付能力堪忧', '公司治理曾有问题', '理赔不确定性大', '长期稳定性存疑'],
  },
  {
    name: '复星联合健康', aliases: ['复星联合', '复星'],
    type: 'medium', established: 2017,
    assets: '中等', solvency_ratio: '150%+',
    risk_capacity: '中等偏下（新公司、规模有限）',
    claims_efficiency: '平均5-10个工作日',
    claims_rate: '94%+',
    complaints_rank: '中等偏低',
    network: '线上为主，部分城市有网点',
    features: ['健康险专业', '产品设计人性化', '性价比高'],
    weaknesses: ['公司成立时间短', '体量小', '长期理赔能力待验证'],
  },
  {
    name: '阳光保险', aliases: ['阳光', '阳光人寿'],
    type: 'large', established: 2005,
    assets: '超5000亿', solvency_ratio: '220%+',
    risk_capacity: '强',
    claims_efficiency: '平均3-7个工作日',
    claims_rate: '97%+',
    complaints_rank: '中等偏低',
    network: '全国主要省市',
    features: ['综合金融布局', '产品线全', '经营稳健'],
    weaknesses: ['品牌影响力中等', '差异化不明显'],
  },
  {
    name: '太平人寿', aliases: ['太平', '中国太平'],
    type: 'large', established: 1929,
    assets: '超1万亿', solvency_ratio: '240%+',
    risk_capacity: '强（央企、历史最悠久的民族保险品牌）',
    claims_efficiency: '平均3-5个工作日',
    claims_rate: '98%+',
    complaints_rank: '中等偏低',
    network: '全国主要省市',
    features: ['央企背景', '历史悠久', '跨境服务能力', '经营稳健'],
    weaknesses: ['产品创新力度一般', '营销力度不如头部'],
  },
  {
    name: '国华人寿', aliases: ['国华', '国华保险'],
    type: 'medium', established: 2007,
    assets: '超千亿', solvency_ratio: '160%+',
    risk_capacity: '中等',
    claims_efficiency: '平均5-10个工作日',
    claims_rate: '95%+',
    complaints_rank: '中等',
    network: '主要省市',
    features: ['互联网保险活跃', '产品创新', '价格有竞争力'],
    weaknesses: ['规模偏小', '服务能力有限'],
  },
];
