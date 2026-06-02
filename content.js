const COMPANY_NAME_SELECTORS = [
  ".company-name",
  ".supplier-company-name",
  ".seller-company-name",
  ".shop-name",
  ".companyName",
  "[class*='company-name']",
  "[class*='companyName']",
  "[class*='company']",
  "[class*='supplier'] h1",
  "h1"
];

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "EXTRACT_COMPANY_NAME") {
    return false;
  }

  sendResponse(extractCompanyName());
  return false;
});

function extractCompanyName() {
  // extractFromInlineScripts 优先级最高，因为 1688 动态页面的公司名在 JS 数据里
  const candidates = [
    ...extractFromInlineScripts(),
    ...extractFromSelectors(),
    ...extractFromMeta(),
    ...extractFromText(),
    ...extractFromTitle()
  ];

  const uniqueCandidates = [...new Set(candidates.map(cleanCompanyName).filter(Boolean))];
  const companyName = uniqueCandidates.find(isLikelyCompanyName) || uniqueCandidates[0] || "";

  return {
    ok: Boolean(companyName),
    companyName,
    candidates: uniqueCandidates.slice(0, 8),
    pageTitle: document.title,
    pageUrl: location.href
  };
}

// 从页面内嵌 <script> 标签的 JSON 数据及 window 全局变量中提取 companyNameCn 字段
// 适用于 sale.1688.com/factory/card.html 等动态渲染页面
function extractFromInlineScripts() {
  const results = [];

  // 1. 优先从 window 全局变量中递归查找 companyNameCn
  try {
    const winKeys = Object.keys(window).filter(
      (k) =>
        k.startsWith("__") ||
        k === "_data" ||
        k.startsWith("pageData") ||
        k.startsWith("initialState") ||
        k.startsWith("__INITIAL")
    );
    for (const key of winKeys) {
      const val = tryExtractCompanyNameCn(window[key]);
      if (val) {
        results.push(val);
      }
    }
  } catch (_e) {
    // 忽略跨域或访问异常
  }

  // 2. 从 <script> 标签文本中用正则匹配
  const scripts = [...document.querySelectorAll("script")];
  const plainPatterns = [
    /"companyNameCn"\s*:\s*"([^"]{2,80})"/g,
    /'companyNameCn'\s*:\s*'([^']{2,80})'/g,
    /companyNameCn\s*[:=]\s*["']([^"']{2,80})["']/g,
    /"companyName"\s*:\s*"([^"]{2,80})"/g,
    /"supplierName"\s*:\s*"([^"]{2,80})"/g,
    /"memberName"\s*:\s*"([^"]{2,80})"/g
  ];
  // 支持 Unicode 转义（如 "companyNameCn":"\u516c\u53f8\u540d"）
  const unicodePatterns = [
    /"companyNameCn"\s*:\s*"((?:\\u[0-9a-fA-F]{4}|[^"\\]){2,120})"/g,
    /"companyName"\s*:\s*"((?:\\u[0-9a-fA-F]{4}|[^"\\]){2,120})"/g,
    /"supplierName"\s*:\s*"((?:\\u[0-9a-fA-F]{4}|[^"\\]){2,120})"/g
  ];

  for (const script of scripts) {
    const text = script.textContent || "";
    if (text.length < 10) {
      continue;
    }

    for (const pattern of plainPatterns) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const val = match[1];
        // 跳过含未解码 Unicode 的值，留给 unicodePatterns 处理
        if (val && !val.includes("\\u") && val.length >= 2) {
          results.push(val);
        }
      }
    }

    for (const pattern of unicodePatterns) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const decoded = decodeUnicodeEscapes(match[1]);
        if (decoded && decoded.length >= 2) {
          results.push(decoded);
        }
      }
    }
  }

  return results;
}

// 递归从对象中提取 companyNameCn 字段（最多深度 5 层）
function tryExtractCompanyNameCn(obj, depth) {
  if (depth === undefined) {
    depth = 0;
  }
  if (depth > 5 || !obj || typeof obj !== "object") {
    return "";
  }

  if (typeof obj.companyNameCn === "string" && obj.companyNameCn.length >= 2) {
    return obj.companyNameCn;
  }

  const keys = Object.keys(obj).slice(0, 30);
  for (var i = 0; i < keys.length; i++) {
    const child = obj[keys[i]];
    if (child && typeof child === "object") {
      const val = tryExtractCompanyNameCn(child, depth + 1);
      if (val) {
        return val;
      }
    }
  }

  return "";
}

function decodeUnicodeEscapes(value) {
  return String(value || "").replace(/\\u([0-9a-fA-F]{4})/g, function(_, code) {
    return String.fromCharCode(parseInt(code, 16));
  });
}

function extractFromSelectors() {
  return COMPANY_NAME_SELECTORS.flatMap((selector) =>
    [...document.querySelectorAll(selector)]
      .map((node) => node.textContent)
      .filter(Boolean)
  );
}

function extractFromMeta() {
  return [
    document.querySelector("meta[property='og:title']") && document.querySelector("meta[property='og:title']").content,
    document.querySelector("meta[name='keywords']") && document.querySelector("meta[name='keywords']").content,
    document.querySelector("meta[name='description']") && document.querySelector("meta[name='description']").content
  ].filter(Boolean);
}

function extractFromText() {
  const bodyText = document.body ? document.body.innerText : "";
  const matches = [];
  const labelPatterns = [
    /公司名称\s*[:：]\s*([^\n\r]+)/g,
    /供应商\s*[:：]\s*([^\n\r]+)/g,
    /厂商\s*[:：]\s*([^\n\r]+)/g
  ];

  for (const pattern of labelPatterns) {
    for (const match of bodyText.matchAll(pattern)) {
      matches.push(match[1]);
    }
  }

  const companyLikePattern = /[\u4e00-\u9fa5（）()]{4,50}(?:公司|工厂|厂|有限公司|有限责任公司)/g;
  for (const match of bodyText.matchAll(companyLikePattern)) {
    matches.push(match[0]);
    if (matches.length >= 20) {
      break;
    }
  }

  return matches;
}

function extractFromTitle() {
  return document.title
    .split(/[_\-|,，]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function cleanCompanyName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^(公司名称|供应商|厂商|店铺|旺铺)\s*[:：]\s*/g, "")
    .replace(/1688\.com|阿里巴巴|诚信通|旺铺|首页|官网/g, "")
    .replace(/[【】\[\]]/g, "")
    .trim()
    .slice(0, 80);
}

function isLikelyCompanyName(value) {
  if (!value || value.length < 4 || value.length > 60) {
    return false;
  }

  if (/^\d+$/.test(value)) {
    return false;
  }

  return /(公司|工厂|厂|经营部|商行|店|有限公司|有限责任公司)$/.test(value) ||
    /(公司|工厂|有限公司|有限责任公司)/.test(value);
}
