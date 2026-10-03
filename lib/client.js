// NOTE: 本文件是 dsh-codebuddy 的网页端**源码**，不经过构建。
// 改完用 `node --check lib/client.js` 自检。
window.__ModuleLoader__.load({ id: "dsh-codebuddy", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

const React = require("react");
const { useState, useEffect, useCallback } = React;
const h = React.createElement;

/** 后端 HTTP 路由（**带前导斜杠**，与 host 半的 SETTINGS_ROUTE 一致）。 */
const ROUTE = "/_dsh/dsh-codebuddy/settings";

/** 调用 host 侧 API。signal 可选（用于取消长耗时的探测）。 */
async function api(action, payload, signal) {
  const init = action === undefined
    ? { credentials: "same-origin", signal: signal }
    : {
        credentials: "same-origin",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ action }, payload)),
        signal: signal,
      };
  const res = await fetch(ROUTE, init);
  const body = await res.json();
  if (!res.ok || !body.ok) {
    const err = new Error((body && body.error && body.error.message) || ("request failed " + res.status));
    err.code = body && body.error ? body.error.code : undefined;
    throw err;
  }
  return body.value;
}

// ── 样式 ──────────────────────────────────────────────────────
const CSS = `
.cb-wrap { display: flex; flex-direction: column; gap: 14px; font-size: 14px; }
.cb-row { display: flex; flex-direction: column; gap: 6px; }
.cb-label { font-weight: 600; opacity: .9; }
.cb-hint { font-size: 12px; opacity: .6; line-height: 1.5; }
.cb-input { padding: 8px 10px; border-radius: 6px; border: 1px solid rgba(128,128,128,.35);
            background: rgba(128,128,128,.08); color: inherit; font-size: 13px; font-family: inherit; }
.cb-input:focus { outline: 2px solid rgba(90,140,255,.5); outline-offset: 0; }
.cb-btns { display: flex; gap: 8px; flex-wrap: wrap; }
.cb-btn { padding: 7px 14px; border-radius: 6px; border: 1px solid rgba(128,128,128,.35);
          background: rgba(128,128,128,.12); color: inherit; cursor: pointer; font-size: 13px; }
.cb-btn:hover:not(:disabled) { background: rgba(128,128,128,.22); }
.cb-btn:disabled { opacity: .45; cursor: not-allowed; }
.cb-btn.primary { background: rgba(90,140,255,.2); border-color: rgba(90,140,255,.5); }
.cb-msg { padding: 8px 10px; border-radius: 6px; font-size: 13px; line-height: 1.5; }
.cb-ok { background: rgba(60,180,100,.15); border: 1px solid rgba(60,180,100,.4); }
.cb-err { background: rgba(220,80,80,.15); border: 1px solid rgba(220,80,80,.4); }
.cb-info { background: rgba(90,140,255,.12); border: 1px solid rgba(90,140,255,.35); }
.cb-models { display: flex; flex-direction: column; gap: 4px; max-height: 260px; overflow-y: auto;
             padding: 8px; border-radius: 6px; background: rgba(128,128,128,.08); }
.cb-model { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 4px; }
.cb-model:hover { background: rgba(128,128,128,.12); }
.cb-model code { font-size: 12px; opacity: .85; }
.cb-check { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; }
.cb-check input { cursor: pointer; }
.cb-badge { font-size: 11px; padding: 1px 6px; border-radius: 999px;
            background: rgba(128,128,128,.18); opacity: .85; }
.cb-badge-img { background: rgba(90,140,255,.22); border: 1px solid rgba(90,140,255,.45); opacity: 1; }
`;

// ── 组件 ──────────────────────────────────────────────────────
function CodeBuddySettings() {
  const [cfg, setCfg] = useState(null);
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [models, setModels] = useState([]);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState(null);
  // 深度探测默认关闭：一次「获取模型」= 每条候选一次真实计费请求，
  // 默认只探已知清单，猜新模型必须由用户显式勾选。
  const [deep, setDeep] = useState(false);
  const [note, setNote] = useState("");
  const abortRef = React.useRef(null);

  const load = useCallback(async () => {
    try {
      const v = await api();
      setCfg(v);
      setBaseURL(v.baseURL || "");
      setModels(v.models || []);
    } catch (e) {
      setMsg({ kind: "err", text: "读取配置失败：" + e.message });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /** 保存密钥。 */
  const saveKey = async () => {
    if (!apiKey.trim()) { setMsg({ kind: "err", text: "请先填写 API 密钥" }); return; }
    setBusy("save"); setMsg(null);
    try {
      await api("set-key", { apiKey: apiKey.trim() });
      setApiKey("");
      setMsg({ kind: "ok", text: "✅ 密钥已保存（写入 DSH 凭据库）" });
      await load();
    } catch (e) {
      setMsg({ kind: "err", text: "保存失败：" + e.message });
    } finally { setBusy(""); }
  };

  /**
   * 带上「还没保存」的草稿值：新用户粘贴密钥后直接点测试/获取模型也能用，
   * 不必先点保存。只带 sk-/ck- 字面量密钥 —— 环境变量名之类交给服务端从凭据库解析。
   */
  const draftPayload = (extra) => {
    const payload = Object.assign({}, extra);
    const k = apiKey.trim();
    if (/^(sk-|ck-)/.test(k)) payload.apiKey = k;
    if (baseURL.trim()) payload.baseURL = baseURL.trim();
    return payload;
  };

  /** 测试连通性。 */
  const testConn = async () => {
    setBusy("test"); setMsg(null);
    try {
      const v = await api("test", draftPayload({}));
      setMsg({ kind: v.ok ? "ok" : "err", text: v.message });
    } catch (e) {
      setMsg({ kind: "err", text: "测试失败：" + e.message });
    } finally { setBusy(""); }
  };

  /** 探测可用模型。 */
  const discover = async (force) => {
    if (busy) return;
    setBusy("discover"); setMsg(null);
    // 允许用户中途取消：AbortController 会把中断传到服务端，服务端再传进每个探测请求
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const v = await api("discover", draftPayload({ deep: deep, force: force === true }), ac.signal);
      setModels(v.models || []);
      const st = v.stats || {};
      // 成本可见：探测次数 / 命中 / 限流 / 超时
      const cost = `发送 ${st.probed ?? 0} 次计费请求 · 命中 ${st.hit ?? (v.models || []).length}` +
        (st.rate ? ` · 限流 ${st.rate}` : "") +
        (st.quota ? ` · 额度不足 ${st.quota}` : "") +
        (st.timeout ? ` · 超时 ${st.timeout}` : "") +
        (st.absent ? ` · 不存在 ${st.absent}` : "");
      let text;
      let kind;
      if (st.aborted) {
        // 用户主动取消**不是**配置错误，别再说「请检查密钥与网络」
        kind = "info"; text = "⏹ 已取消探测。" + cost;
      } else if (st.quotaStopped) {
        // 额度用尽是**永久失败**：必须说「去充值」，说「稍后重试」是误导
        kind = "err";
        text = "⛔ CodeBuddy 额度已用尽（网关 code 14018），探测已停止。" + cost
          + "　请到 codebuddy.cn 充值或购买加量包后再试。";
      } else if (st.deadlineHit) {
        // 总时限到点：结果不完整，但**不能**当成「模型不存在」（否则会误剔除可用模型）
        kind = "info";
        text = "⏱ 探测达到 60 秒总时限已中止，结果不完整。" + cost + "　可稍后重试。";
      } else if ((v.models || []).length) {
        kind = "ok"; text = `✅ 探测到 ${v.models.length} 个可用模型` + (st.cached ? "（缓存命中，0 请求）" : "") + `　|　${cost}`;
      } else if (st.throttleStopped) {
        kind = "err"; text = `⚠️ 触发限流已熔断（连续 429）。${cost}`;
      } else {
        kind = "info"; text = `未探测到模型。${cost}`;
      }
      // 只有「限流」才建议稍后重试；额度不足不能这么说
      if (st.throttleStopped && !st.quotaStopped) text += "　建议稍后重试，或先不勾选深度探测。";
      setMsg({ kind: kind, text: text });
      if (v.note) setNote(v.note);
    } catch (e) {
      if (e && e.name === "AbortError") setMsg({ kind: "info", text: "⏹ 已取消探测。" });
      else setMsg({ kind: "err", text: "探测失败：" + e.message });
    } finally { abortRef.current = null; setBusy(""); }
  };

  /** 取消正在进行的探测。 */
  const cancelDiscover = () => { if (abortRef.current) abortRef.current.abort(); };

  /** 清空探测缓存。 */
  const clearCache = async () => {
    setBusy("cache"); setMsg(null);
    try {
      const v = await api("discover-cache-clear", {});
      setMsg({ kind: "ok", text: `✅ 已清空探测缓存（${v.cleared} 条），下次探测将重新联网` });
    } catch (e) {
      setMsg({ kind: "err", text: "清空缓存失败：" + e.message });
    } finally { setBusy(""); }
  };

  /** 删除已保存的密钥。 */
  const clearKey = async () => {
    if (!window.confirm("确定删除已保存的 CodeBuddy API 密钥？")) return;
    setBusy("clearkey"); setMsg(null);
    try {
      const v = await api("clear-key", {});
      setMsg({ kind: v.cleared ? "ok" : "info", text: v.message });
      await load();
    } catch (e) {
      setMsg({ kind: "err", text: "删除失败：" + e.message });
    } finally { setBusy(""); }
  };

  if (!cfg) return h("div", { className: "cb-wrap" }, h("div", { className: "cb-hint" }, "加载中…"));

  return h("div", { className: "cb-wrap" },
    // 状态
    h("div", { className: "cb-row" },
      h("div", { className: "cb-label" }, "CodeBuddy 开放平台"),
      h("div", { className: "cb-hint" },
        cfg.hasKey ? "✅ 已配置 API 密钥" : "⚠️ 尚未配置 API 密钥",
        "　|　", "已收录 ", cfg.models?.length ?? 0, " 个模型")
    ),

    // API Key
    h("div", { className: "cb-row" },
      h("div", { className: "cb-label" }, "API 密钥"),
      h("input", {
        className: "cb-input",
        type: "password",
        placeholder: cfg.hasKey ? "已保存（留空则不修改）" : "粘贴你的 CodeBuddy API Key",
        value: apiKey,
        onChange: (e) => setApiKey(e.target.value),
        autoComplete: "off",
        spellCheck: false
      }),
      h("div", { className: "cb-hint" },
        "从 CodeBuddy 开放平台获取，通常以 ck_ 开头。密钥保存到 DSH 凭据库，不写入配置文件。")
    ),

    // BaseURL（只读展示：端点由 cordis.patch.yml / 环境变量决定，设置页无法修改）
    h("div", { className: "cb-row" },
      h("div", { className: "cb-label" }, "接口地址"),
      h("input", {
        className: "cb-input",
        type: "text",
        value: baseURL,
        readOnly: true,
        spellCheck: false
      }),
      h("div", { className: "cb-hint" },
        "只读。端点由 cordis.patch.yml 的 baseURL 决定；如需修改请改配置或设环境变量 CODEBUDDY_BASE_URL，然后重启 DSH。")
    ),

    // 按钮
    h("div", { className: "cb-btns" },
      h("button", { className: "cb-btn primary", onClick: () => saveKey(), disabled: busy || !apiKey.trim() },
        busy === "save" ? "保存中…" : "保存密钥"),
      h("button", { className: "cb-btn", onClick: testConn, disabled: busy },
        busy === "test" ? "测试中…" : "测试连接"),
      h("button", { className: "cb-btn", onClick: () => discover(false), disabled: busy },
        busy === "discover" ? "探测中…" : "获取模型"),
      busy === "discover" && h("button", { className: "cb-btn", onClick: cancelDiscover }, "取消"),
      cfg.hasKey && h("button", { className: "cb-btn", onClick: clearKey, disabled: busy },
        busy === "clearkey" ? "删除中…" : "删除密钥")
    ),

    // 探测成本控制
    h("div", { className: "cb-row" },
      h("label", { className: "cb-check" },
        h("input", {
          type: "checkbox",
          checked: deep,
          disabled: !!busy,
          onChange: (e) => setDeep(e.target.checked)
        }),
        h("span", null, "深度探测（尝试猜测尚未收录的新模型）")
      ),
      h("div", { className: "cb-hint" },
        deep
          ? "⚠️ 深度探测会逐条试全部候选，每条都是一次真实计费请求，耗时更长也更容易触发限流。"
          : "默认只探测已收录的 " + (cfg.models?.length ?? 0) + " 个模型；探测结果会缓存 30 分钟，重复点击 0 请求。"),
      h("div", { className: "cb-btns" },
        h("button", { className: "cb-btn", onClick: clearCache, disabled: !!busy },
          busy === "cache" ? "清理中…" : "清空探测缓存")
      )
    ),

    // 消息
    msg && h("div", { className: "cb-msg cb-" + msg.kind }, msg.text),
    note && h("div", { className: "cb-hint" }, note),

    // 模型列表
    models.length > 0 && h("div", { className: "cb-row" },
      h("div", { className: "cb-label" }, "可用模型（", models.length, "）"),
      h("div", { className: "cb-models" },
        models.map((m) => h("div", { className: "cb-model", key: m.id },
          h("span", null, "•"),
          h("code", null, m.id),
          m.name && m.name !== m.id ? h("span", { className: "cb-hint" }, m.name) : null,
          // 视觉能力对用户是决定性的（能不能贴图），必须显式标出
          (m.inputModalities || []).indexOf("image") >= 0
            ? h("span", { className: "cb-badge cb-badge-img" }, "视觉")
            : null,
          m.contextWindow ? h("span", { className: "cb-badge" }, Math.round(m.contextWindow / 1000) + "k") : null
        ))
      ),
      h("div", { className: "cb-hint" },
        "在「设置 → 模型」里选择 CodeBuddy 路由后即可使用这些模型。")
    )
  );
}

// ── 插件入口 ──────────────────────────────────────────────────
const inject = ["slots", "locale"];

function apply(ctx) {
  // 样式注入
  ctx.effect(() => {
    const id = "dsh-codebuddy/client";
    if (document.querySelector('style[data-plugin-css="' + id + '"]')) return () => {};
    const style = document.createElement("style");
    style.dataset.plugin = "dsh-codebuddy";
    style.dataset.pluginCss = id;
    style.textContent = CSS;
    document.head.appendChild(style);
    return () => { style.remove(); };
  }, "dsh-codebuddy: styles");

  // 设置页分区
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "dsh-codebuddy",
    order: 46,
    label: () => "CodeBuddy",
    inject: () => ({}),
  }, CodeBuddySettings));
}

exports.apply = apply;
exports.inject = inject;

return module.exports;
}});
