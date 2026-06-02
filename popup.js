const statusCard = document.getElementById("statusCard");
const statusLabel = document.getElementById("statusLabel");
const resultLabel = document.getElementById("resultLabel");
const companyNameNode = document.getElementById("companyName");
const businessScopeNode = document.getElementById("businessScope");
const reasonNode = document.getElementById("reason");
const searchLink = document.getElementById("searchLink");
const refreshButton = document.getElementById("refreshButton");
const historyList = document.getElementById("historyList");
const historyCount = document.getElementById("historyCount");

refreshButton.addEventListener("click", runCheck);
document.addEventListener("DOMContentLoaded", () => {
  runCheck();
  loadHistory();
});

async function runCheck() {
  setState("pending", "检测中", "正在读取当前页面");
  setDetails({ companyName: "-", businessScope: "-", reason: "-" });
  setSearchLink("");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:\/\/([^/]+\.)?1688\.com\//.test(tab.url || "")) {
      throw new Error("请先打开 1688 页面，再点击扩展。");
    }

    const extracted = await extractCompanyName(tab.id);
    if (!extracted?.ok || !extracted.companyName) {
      throw new Error("未能从当前 1688 页面识别公司名称。");
    }

    setDetails({ companyName: extracted.companyName, businessScope: "查询爱企查中...", reason: "-" });
    const result = await chrome.runtime.sendMessage({
      type: "CHECK_COMPANY",
      companyName: extracted.companyName
    });

    if (!result?.ok) {
      throw new Error(result?.error || "爱企查查询失败。");
    }

    setState(result.result, "检测完成", result.result === "factory" ? "工厂" : "贸易");
    setDetails({
      companyName: result.companyName,
      businessScope: result.businessScope || "未解析到经营范围",
      reason: result.reason
    });
    setSearchLink(result.detailUrl || result.searchUrl);

    // 查询完成后刷新历史记录
    loadHistory();
  } catch (error) {
    setState("error", "检测失败", error?.message || "发生未知错误");
    setDetails({
      companyName: companyNameNode.textContent || "-",
      businessScope: "-",
      reason: "如果爱企查出现验证码或登录限制，请点击下方链接手动复核。"
    });
  }
}

async function extractCompanyName(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_COMPANY_NAME" });
  } catch (_error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
    return chrome.tabs.sendMessage(tabId, { type: "EXTRACT_COMPANY_NAME" });
  }
}

function setState(type, status, result) {
  statusCard.className = `status-card ${type}`;
  statusLabel.textContent = status;
  resultLabel.textContent = result;
}

function setDetails({ companyName, businessScope, reason }) {
  companyNameNode.textContent = companyName;
  businessScopeNode.textContent = businessScope;
  reasonNode.textContent = reason;
}

function setSearchLink(url) {
  if (!url) {
    searchLink.href = "#";
    searchLink.classList.add("disabled");
    return;
  }

  searchLink.href = url;
  searchLink.classList.remove("disabled");
}

// ── 历史记录 ──

async function loadHistory() {
  try {
    const history = await chrome.runtime.sendMessage({ type: "GET_HISTORY" });
    renderHistory(history || []);
  } catch (_e) {
    renderHistory([]);
  }
}

function renderHistory(history) {
  historyCount.textContent = history.length + " 条";

  if (!history.length) {
    historyList.innerHTML = '<li class="history-empty">暂无查询记录</li>';
    return;
  }

  historyList.innerHTML = "";
  for (const item of history) {
    const li = document.createElement("li");

    const isFactory = item.result === "factory";
    const link = item.detailUrl || item.searchUrl || "#";

    const a = document.createElement("a");
    a.className = "history-item";
    a.href = link;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.title = item.businessScope || "无经营范围";

    // 徽章
    const badge = document.createElement("span");
    badge.className = "history-badge " + (isFactory ? "factory" : "trade");
    badge.textContent = isFactory ? "工厂" : "贸易";

    // 信息区
    const info = document.createElement("div");
    info.className = "history-info";

    const name = document.createElement("div");
    name.className = "history-name";
    name.textContent = item.companyName || "-";

    const time = document.createElement("div");
    time.className = "history-time";
    time.textContent = formatTime(item.timestamp);

    info.appendChild(name);
    info.appendChild(time);

    a.appendChild(badge);
    a.appendChild(info);
    li.appendChild(a);
    historyList.appendChild(li);
  }
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
