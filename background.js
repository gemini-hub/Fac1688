chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CHECK_COMPANY") {
    checkCompany(message.companyName)
      .then((result) => {
        if (result?.ok) {
          saveHistory(result);
        }
        sendResponse(result);
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          result: "error",
          error: error?.message || "查询失败"
        });
      });
    return true;
  }

  if (message?.type === "GET_HISTORY") {
    chrome.storage.local.get({ history: [] }).then((data) => {
      sendResponse(data.history || []);
    });
    return true;
  }

  return false;
});

async function checkCompany(companyName) {
  const normalizedName = normalizeCompanyName(companyName);
  if (!normalizedName) {
    throw new Error("未获取到公司名称");
  }

  const searchUrl = buildSearchUrl(normalizedName);
  const renderedResult = await checkCompanyViaRenderedTabs(searchUrl, normalizedName).catch(() => null);
  if (renderedResult?.detailUrl) {
    return buildResult({
      companyName: normalizedName,
      businessScope: renderedResult.businessScope,
      searchUrl,
      detailUrl: renderedResult.detailUrl
    });
  }

  // 渲染方案失败时，用 fetch 尝试静态 HTML（通常爱企查会 SSR 部分内容）
  const searchHtml = await fetchText(searchUrl).catch(() => "");
  const detailUrl = searchHtml ? extractCompanyDetailUrl(searchHtml, normalizedName) : "";

  if (!detailUrl) {
    return buildResult({
      companyName: normalizedName,
      businessScope: "",
      searchUrl,
      detailUrl: "",
      reason: "已搜索爱企查，但未能识别公司名称对应的详情页链接，暂判定为贸易；建议打开爱企查人工复核。"
    });
  }

  const detailHtml = await fetchText(detailUrl).catch(() => "");
  const businessScope = detailHtml ? extractBusinessScopeFromDetail(detailHtml) : "";

  return buildResult({
    companyName: normalizedName,
    businessScope,
    searchUrl,
    detailUrl
  });
}

async function checkCompanyViaRenderedTabs(searchUrl, companyName) {
  const searchTab = await chrome.tabs.create({ url: searchUrl, active: false });

  try {
    await waitForTabComplete(searchTab.id);
    // 爱企查搜索结果是异步渲染的，等待更长时间
    await sleep(3000);

    // 第一次尝试：在当前搜索结果页查找详情链接
    let detailUrl = await tryFindDetailUrl(searchTab.id, companyName);

    // 第一次失败时，再等 2000ms 重试（部分网络慢的情况）
    if (!detailUrl) {
      await sleep(2000);
      detailUrl = await tryFindDetailUrl(searchTab.id, companyName);
    }

    // 两次正则查找都失败时，尝试点击第一条搜索结果进入详情页
    if (!detailUrl) {
      const clicked = await tryClickFirstResult(searchTab.id);
      if (clicked) {
        await waitForTabComplete(searchTab.id);
        await sleep(3000);
        // 当前 tab 已跳转到详情页，直接读取内容
        const currentUrl = await getTabUrl(searchTab.id);
        if (currentUrl && isCompanyDetailPath(currentUrl)) {
          detailUrl = currentUrl;
        }
      }
    }

    if (!detailUrl) {
      return { detailUrl: "", businessScope: "" };
    }

    // 如果 tab 不在详情页（正则找到的 URL），则导航过去
    const currentUrl = await getTabUrl(searchTab.id);
    if (!isSameUrl(currentUrl, detailUrl)) {
      await chrome.tabs.update(searchTab.id, { url: detailUrl });
      await waitForTabComplete(searchTab.id);
      await sleep(3000);
    }

    // 等待详情页的经营范围区域渲染完成（最多额外等 3s）
    await waitForBusinessScope(searchTab.id);

    const pageResult = await chrome.scripting.executeScript({
      target: { tabId: searchTab.id },
      func: readPageForBusinessScope
    });
    const page = pageResult?.[0]?.result || {};
    const businessScope =
      extractBusinessScopeFromText(page.text || "") ||
      extractBusinessScopeFromDetail(page.html || "");

    return { detailUrl, businessScope };
  } finally {
    if (searchTab?.id) {
      await chrome.tabs.remove(searchTab.id).catch(() => {});
    }
  }
}

// 在指定 tab 的当前页面查找爱企查详情页链接
async function tryFindDetailUrl(tabId, companyName) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: findCompanyDetailUrlInPage,
      args: [companyName]
    });
    return normalizeAiqichaUrl(result?.[0]?.result || "");
  } catch (_e) {
    return "";
  }
}

// 尝试点击搜索结果页第一个公司链接
async function tryClickFirstResult(tabId) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: clickFirstCompanyResult
    });
    return Boolean(result?.[0]?.result);
  } catch (_e) {
    return false;
  }
}

// 获取 tab 当前 URL
async function getTabUrl(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.url || "";
  } catch (_e) {
    return "";
  }
}

// 等待详情页出现经营范围文字（最多 3s）
async function waitForBusinessScope(tabId) {
  for (let i = 0; i < 6; i++) {
    await sleep(500);
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const text = document.body ? document.body.innerText : "";
          return /经营范围/.test(text);
        }
      });
      if (result?.[0]?.result) {
        return;
      }
    } catch (_e) {
      // 忽略
    }
  }
}

function isSameUrl(a, b) {
  try {
    return new URL(a).pathname === new URL(b).pathname;
  } catch (_e) {
    return a === b;
  }
}

// 在搜索结果页中查找公司详情链接
// 优先匹配含公司名的链接，次选第一个 company_detail 链接，最后全文正则搜
function findCompanyDetailUrlInPage(companyName) {
  var normalize = function(value) {
    return String(value || "").replace(/\s+/g, "");
  };
  var targetName = normalize(companyName);

  // 收集所有含 company_detail_ 的 <a> 标签
  var anchors = Array.from(document.querySelectorAll("a"));
  var detailAnchors = anchors
    .map(function(anchor) {
      return {
        href: anchor.href || anchor.getAttribute("href") || "",
        text: normalize(anchor.innerText || anchor.textContent || "")
      };
    })
    .filter(function(item) {
      return /company_detail_\d+/i.test(item.href);
    });

  // 优先：名称完全匹配
  var exactMatch = detailAnchors.find(function(item) {
    return item.text.includes(targetName);
  });
  if (exactMatch && exactMatch.href) {
    return exactMatch.href;
  }

  // 次选：名称模糊匹配（至少匹配前4个字）
  if (targetName.length >= 4) {
    var partial = targetName.slice(0, 4);
    var fuzzyMatch = detailAnchors.find(function(item) {
      return item.text.includes(partial);
    });
    if (fuzzyMatch && fuzzyMatch.href) {
      return fuzzyMatch.href;
    }
  }

  // 兜底：取第一个 company_detail 链接
  if (detailAnchors[0] && detailAnchors[0].href) {
    return detailAnchors[0].href;
  }

  // 最后：全文搜索 HTML
  var htmlMatch = document.documentElement.innerHTML.match(/company_detail_\d+/i);
  if (htmlMatch) {
    try {
      return new URL(htmlMatch[0], location.origin).href;
    } catch (_e) {
      return "https://aiqicha.baidu.com/" + htmlMatch[0];
    }
  }

  return "";
}

// 点击搜索结果页的第一个公司名链接（用于动态渲染无法提取链接的情况）
function clickFirstCompanyResult() {
  // 爱企查搜索结果条目的常见选择器
  var selectors = [
    ".result-item a",
    ".search-result-item a",
    ".company-name a",
    ".res-item a",
    "a[href*='company_detail']"
  ];

  for (var i = 0; i < selectors.length; i++) {
    var el = document.querySelector(selectors[i]);
    if (el && /company_detail_\d+/i.test(el.href || "")) {
      el.click();
      return true;
    }
  }

  // 备用：找任何含 company_detail 的链接
  var allAnchors = Array.from(document.querySelectorAll("a"));
  for (var j = 0; j < allAnchors.length; j++) {
    var anchor = allAnchors[j];
    if (/company_detail_\d+/i.test(anchor.href || "")) {
      anchor.click();
      return true;
    }
  }

  return false;
}

function readPageForBusinessScope() {
  return {
    text: document.body ? document.body.innerText : "",
    html: document.documentElement ? document.documentElement.innerHTML : ""
  };
}

function waitForTabComplete(tabId, timeout) {
  if (timeout === undefined) {
    timeout = 18000;
  }
  return new Promise(function(resolve) {
    var settled = false;
    var finish = function() {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    var listener = function(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    };
    var timer = setTimeout(finish, timeout);

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(function(tab) {
      if (tab.status === "complete") {
        finish();
      }
    }).catch(finish);
  });
}

function sleep(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

function buildResult({ companyName, businessScope, searchUrl, detailUrl, reason }) {
  const isFactory = /生产|制造/.test(businessScope);

  return {
    ok: true,
    companyName,
    result: isFactory ? "factory" : "trade",
    businessScope,
    reason: reason || buildReason(businessScope, isFactory, Boolean(detailUrl)),
    searchUrl,
    detailUrl
  };
}

function normalizeCompanyName(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/[【】\[\]]/g, "")
    .trim();
}

function buildSearchUrl(companyName) {
  return `https://aiqicha.baidu.com/s?q=${encodeURIComponent(companyName)}&t=0`;
}

async function fetchText(url) {
  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });

  if (!response.ok) {
    throw new Error(`爱企查请求失败：HTTP ${response.status}`);
  }

  return response.text();
}

function extractCompanyDetailUrl(html, companyName) {
  const decodedHtml = decodeHtml(html);
  const normalizedCompanyName = normalizeCompanyName(companyName);
  const urls = [
    ...extractDetailIdsNearCompanyName(decodedHtml, normalizedCompanyName),
    ...extractDetailLinksNearCompanyName(decodedHtml, normalizedCompanyName),
    ...extractAllDetailLinks(decodedHtml),
    ...extractAllDetailIds(decodedHtml)
  ];

  const uniqueUrls = [...new Set(urls.map(normalizeAiqichaUrl).filter(Boolean))];
  return uniqueUrls[0] || "";
}

function extractDetailIdsNearCompanyName(html, companyName) {
  if (!companyName) {
    return [];
  }

  const links = [];
  const companyIndex = html.indexOf(companyName);
  if (companyIndex === -1) {
    return links;
  }

  const windowStart = Math.max(0, companyIndex - 3000);
  const windowEnd = Math.min(html.length, companyIndex + 3000);
  const nearbyHtml = html.slice(windowStart, windowEnd);

  for (const match of nearbyHtml.matchAll(/company_detail_\d+/gi)) {
    links.push(match[0]);
  }

  return links;
}

function extractDetailLinksNearCompanyName(html, companyName) {
  if (!companyName) {
    return [];
  }

  const escapedName = escapeRegExp(companyName);
  const links = [];
  const patterns = [
    new RegExp(`<a[^>]+href=["']([^"']+)["'][^>]*>[\\s\\S]{0,300}?${escapedName}[\\s\\S]{0,300}?<\\/a>`, "gi"),
    new RegExp(`href=["']([^"']+)["'][^>]{0,300}[\\s\\S]{0,500}?${escapedName}`, "gi")
  ];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      if (isCompanyDetailPath(match[1])) {
        links.push(match[1]);
      }
    }
  }

  return links;
}

function extractAllDetailLinks(html) {
  const links = [];
  const hrefPattern = /href=["']([^"']+)["']/gi;

  for (const match of html.matchAll(hrefPattern)) {
    if (isCompanyDetailPath(match[1])) {
      links.push(match[1]);
    }
  }

  return links;
}

function extractAllDetailIds(html) {
  return [...html.matchAll(/company_detail_\d+/gi)].map((match) => match[0]);
}

function isCompanyDetailPath(value) {
  return /(?:^|\/)company_(basic|detail|base|cert|annual|change|product|brand|invest|branch|risk)_[^"'?#/\s]+/i.test(value)
    || /(?:^|\/)firm_[^"'?#/\s]+/i.test(value)
    || /(?:^|\/)detail\/compinfo\?/i.test(value);
}

function normalizeAiqichaUrl(value) {
  if (!value) {
    return "";
  }

  const cleaned = value.replace(/\\\//g, "/").trim();
  if (!isCompanyDetailPath(cleaned)) {
    return "";
  }

  if (cleaned.startsWith("http")) {
    return cleaned;
  }

  return `https://aiqicha.baidu.com${cleaned.startsWith("/") ? "" : "/"}${cleaned}`;
}

function extractBusinessScopeFromDetail(html) {
  if (!html) {
    return "";
  }

  const decodedHtml = decodeHtml(html);
  const jsonScope = extractBusinessScopeFromJson(decodedHtml);
  if (jsonScope) {
    return jsonScope;
  }

  const plainText = htmlToText(decodedHtml);
  return extractBusinessScopeFromText(plainText);
}

function extractBusinessScopeFromJson(html) {
  const patterns = [
    /"businessScope"\s*:\s*"([^"]{6,2000})"/i,
    /"scope"\s*:\s*"([^"]{6,2000})"/i,
    /"经营范围"\s*:\s*"([^"]{6,2000})"/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    const scope = cleanBusinessScope(match?.[1]);
    if (scope) {
      return scope;
    }
  }

  return "";
}

function extractBusinessScopeFromText(text) {
  const normalizedText = String(text || "").replace(/\s+/g, " ").trim();
  const companyIntro = extractCompanyIntroText(normalizedText);
  const sources = [companyIntro, normalizedText].filter(Boolean);

  for (const source of sources) {
    const patterns = [
      /经营范围\s*(?:包括|为|是|有|：|:)?\s*([^。；;]{6,1200})/,
      /经营项目\s*(?:包括|为|是|有|：|:)?\s*([^。；;]{6,1200})/,
      /主要经营\s*([^。；;]{6,1200})/
    ];

    for (const pattern of patterns) {
      const match = source.match(pattern);
      const scope = cleanBusinessScope(match?.[1]);
      if (scope) {
        return scope;
      }
    }
  }

  return "";
}

function extractCompanyIntroText(text) {
  const introMatch = text.match(/公司简介\s*([\s\S]{0,2500}?)(?:工商信息|基本信息|股东信息|主要人员|变更记录|知识产权|风险信息|附近企业|$)/);
  return introMatch?.[1] || "";
}

function cleanBusinessScope(value) {
  return String(value || "")
    .replace(/\\u([\dA-Fa-f]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\\n|\\r|\\t/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/^[:：,，、\s]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/\\u([\dA-Fa-f]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\\"/g, "\"")
    .replace(/&quot;/g, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildReason(businessScope, isFactory, hasDetailUrl) {
  if (businessScope) {
    return isFactory
      ? '已进入爱企查公司详情页，并在公司简介/经营范围中找到“生产”或“制造”，判定为工厂。'
      : '已进入爱企查公司详情页，但公司简介/经营范围未包含“生产”或“制造”，判定为贸易。';
  }

  return hasDetailUrl
    ? '已进入爱企查公司详情页，但未能从公司简介中解析到经营范围，按未包含关键词暂判定为贸易；建议打开详情页人工复核。'
    : '未能识别爱企查公司详情页，按未包含关键词暂判定为贸易；建议打开爱企查人工复核。';
}

// 保存查询结果到历史记录（最多保留 10 条，按公司名去重）
async function saveHistory(result) {
  try {
    const data = await chrome.storage.local.get({ history: [] });
    const history = data.history || [];

    const entry = {
      companyName: result.companyName || "",
      result: result.result || "",
      businessScope: (result.businessScope || "").slice(0, 200),
      detailUrl: result.detailUrl || "",
      searchUrl: result.searchUrl || "",
      timestamp: Date.now()
    };

    // 去重：移除同名公司的旧记录
    const filtered = history.filter((item) => item.companyName !== entry.companyName);
    filtered.unshift(entry);

    // 只保留最近 10 条
    await chrome.storage.local.set({ history: filtered.slice(0, 10) });
  } catch (_e) {
    // 存储失败不影响主流程
  }
}
