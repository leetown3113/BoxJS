/*
 * 京东 CK → 呆呆面板 自动推送
 * 运行环境：Shadowrocket / Surge 的 http-request 脚本（MITM）
 *
 * 做的事：
 *   1. 你打开京东 App，请求经过代理时，脚本从请求头 Cookie 里抓 pt_key / pt_pin
 *   2. 自动去重：同一个 CK 在 minGapMin 分钟内不会重复推
 *   3. 推送到呆呆面板：已有同账号就覆盖，没有就新增，最后强制「启用」
 *   4. 顺带查一次京豆（CK 是否有效一起能看到）
 *   5. 推送结果弹通知
 *
 * 只需要改下面 CFG 里几行，其它不用动。
 */

// ==================== 需要改的配置 ====================
const CFG = {
  // 呆呆面板地址：IPv4/域名直接写；IPv6 要带方括号，例 http://[2408:8207::1]:5700
  panel: "http://192.168.1.10:5700",

  // 鉴权方式："openapi" = AppKey/AppSecret（推荐）；"password" = 面板账号密码
  mode: "openapi",
  appKey: "填你的 AppKey",
  appSecret: "填你的 AppSecret",
  username: "",      // mode=password 时填
  password: "",      // mode=password 时填

  minGapMin: 10,     // 同一个 CK 至少隔多少分钟才重复推送
  pushBean: true,    // 推送后是否顺带查京豆
  notify: true       // 是否弹通知
};
// =====================================================

const ENV_NAME = "JD_COOKIE";
const ORDER = ["pt_key", "pt_pin", "User-Agent", "uuid", "x-api-eid-token",
  "wg-sdk-token", "d_brand", "d_model", "osVersion", "build", "clientVersion"];

/* ---------------- 小工具 ---------------- */

function log(s) {
  console.log("[jd-ck] " + s);
}

/** 取请求头（不分大小写） */
function hdr(headers, name) {
  if (!headers) return "";
  const want = String(name).toLowerCase();
  for (const k in headers) {
    if (k.toLowerCase() === want) return String(headers[k] == null ? "" : headers[k]);
  }
  return "";
}

/**
 * 取 Cookie 里某个键的值。
 * Cookie 按分号切段，所以值不会吃到后面的 Path=/、_gid 之类。
 */
function cookieVal(cookie, key) {
  if (!cookie) return "";
  const want = String(key).toLowerCase();
  const parts = cookie.split(";");
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i].trim();
    const eq = s.indexOf("=");
    if (eq > 0 && s.slice(0, eq).trim().toLowerCase() === want) {
      return s.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  return "";
}

/** UA 只保留到 appBuild/数字 为止 */
function normUa(ua) {
  if (!ua) return "";
  const m = String(ua).match(/^(.*?appBuild\/\d+)/i);
  return (m ? m[1] : String(ua)).trim();
}

/** 从 UA 里取构建号 */
function buildFromUa(ua) {
  const m = String(ua || "").match(/appBuild\/(\d{5,8})(?!\d)/i);
  return m ? m[1] : "";
}

/** pt_pin 是 URL 编码的，解出来给通知用 */
function decodePin(pin) {
  try { return decodeURIComponent(pin); } catch (e) { return pin; }
}

/** 一条 CK 里取 pt_pin */
function pinOf(cookie) {
  return cookieVal(cookie, "pt_pin");
}

/** 一个环境变量可能塞了多条 CK（换行或 & 分隔），拆开 */
function splitCookies(value) {
  if (!value) return [];
  return String(value).split(/[\n&]/).map(function (s) { return s.trim(); })
    .filter(function (s) { return s.indexOf("pt_key=") >= 0 && s.indexOf("pt_pin=") >= 0; });
}

/** 按固定 11 段拼成一条完整 CK（和安卓 App 的格式一致） */
function composeCookie(f) {
  const out = [];
  ORDER.forEach(function (k) {
    let v = (f[k] || "").trim();
    if (!v && k === "build") v = buildFromUa(f["User-Agent"]);
    if (v) out.push(k + "=" + v);
  });
  return out.join(";");
}

/* ---------------- 从请求里收集字段 ---------------- */

function collectFields(req) {
  const headers = (req && req.headers) || {};
  const cookie = hdr(headers, "Cookie");
  const f = {};

  f["pt_key"] = cookieVal(cookie, "pt_key");
  f["pt_pin"] = cookieVal(cookie, "pt_pin");

  const ua = hdr(headers, "User-Agent");
  if (ua) f["User-Agent"] = normUa(ua);

  ["uuid", "x-api-eid-token", "wg-sdk-token", "d_brand", "d_model",
    "osVersion", "clientVersion", "build"].forEach(function (k) {
      const v = hdr(headers, k) || cookieVal(cookie, k);
      if (v) f[k] = v;
    });

  return f;
}

/* ---------------- HTTP ---------------- */

function httpCall(method, url, token, body) {
  return new Promise(function (resolve, reject) {
    const headers = { "Accept": "application/json" };
    const opts = { url: url, headers: headers, timeout: 10 };

    if (body != null) {
      opts.body = body;
      headers["Content-Type"] = "application/json";
    }
    if (token) headers["Authorization"] = "Bearer " + token;

    let fn;
    if (method === "GET") fn = $httpClient.get;
    else if (method === "PUT") fn = $httpClient.put || $httpClient.post;
    else fn = $httpClient.post;

    fn(opts, function (err, resp, data) {
      if (err) return reject(new Error("网络错误：" + err));
      let json = null;
      try { json = JSON.parse(data); } catch (e) { /* 非 JSON 交给调用方看 raw */ }
      resolve({ status: (resp && resp.status) || 0, json: json, raw: data || "" });
    });
  });
}

function baseUrl() {
  return String(CFG.panel || "").trim().replace(/\/+$/, "");
}

function api(path, method, token, body) {
  return httpCall(method, baseUrl() + path, token, body);
}

/** 只要 HTTP 2xx 就算成功，其它把面板返回的错误信息抛出来 */
function ensureOk(r, what) {
  const ok = r.status >= 200 && r.status < 300;
  const j = r.json || {};
  const codeOk = j.code === 200 || j.code === 0 || j.code == null;
  if (ok && codeOk) return r;
  const msg = (j.error || j.message || j.msg || (r.raw || "")).toString().slice(0, 80);
  throw new Error(what + "失败：" + (msg || ("HTTP " + r.status)));
}

/* ---------------- 面板接口 ---------------- */

function getToken() {
  if (CFG.mode === "password") {
    const body = JSON.stringify({ username: CFG.username, password: CFG.password });
    return api("/api/v1/auth/login", "POST", null, body).then(function (r) {
      ensureOk(r, "登录");
      const d = r.json && (r.json.data || r.json);
      const t = d && (d.access_token || d.token || d.accessToken);
      if (!t) throw new Error("登录没有返回 token");
      return t;
    });
  }
  const body = JSON.stringify({ app_key: CFG.appKey, app_secret: CFG.appSecret });
  return api("/api/v1/open-api/token", "POST", null, body).then(function (r) {
    ensureOk(r, "鉴权");
    const d = r.json && (r.json.data || r.json);
    const t = d && (d.access_token || d.token || d.accessToken);
    if (!t) throw new Error("鉴权没有返回 token（检查 AppKey/AppSecret 和 envs 权限）");
    return t;
  });
}

function listJdEnvs(token) {
  return api("/api/v1/envs?all=1&names=" + ENV_NAME, "GET", token).then(function (r) {
    ensureOk(r, "读取环境变量");
    const j = r.json || {};
    let arr = j.data;
    if (arr && !Array.isArray(arr) && Array.isArray(arr.data)) arr = arr.data;
    if (!arr && Array.isArray(j.list)) arr = j.list;
    if (!Array.isArray(arr)) return [];
    return arr.filter(function (e) { return e && e.name === ENV_NAME; });
  });
}

/* ---------------- 京豆 ---------------- */

function queryBean(ptKey, ptPin) {
  return new Promise(function (resolve) {
    $httpClient.get({
      url: "https://me-api.jd.com/user_new/info/GetJDUserInfoUnion",
      headers: {
        "Cookie": "pt_key=" + ptKey + ";pt_pin=" + ptPin,
        "Referer": "https://home.m.jd.com/myJd/newhome.action?sceneval=2&ufc=&",
        "User-Agent": "jdapp;iPhone;15.0.0;;;M/5.0;appBuild/100000"
      },
      timeout: 10
    }, function (err, resp, data) {
      if (err) return resolve("查询失败");
      let j = null;
      try { j = JSON.parse(data); } catch (e) { return resolve("解析失败"); }
      const rc = String(j.retcode);
      if (rc === "1001") return resolve("CK 已失效");
      if (rc !== "0") return resolve("查询失败(" + rc + ")");
      const n = j.data && j.data.assetInfo && j.data.assetInfo.beanNum;
      resolve(n == null ? "CK 有效" : n + " 京豆");
    });
  });
}

/* ---------------- 推送主流程 ---------------- */

function push(fields) {
  const cookie = composeCookie(fields);
  const pin = fields["pt_pin"];
  let token = "";
  let action = "";

  return getToken().then(function (t) {
    token = t;
    return listJdEnvs(token);
  }).then(function (envs) {
    // 找有没有同一个账号
    let hit = null;
    for (let i = 0; i < envs.length; i++) {
      const parts = splitCookies(envs[i].value);
      for (let j = 0; j < parts.length; j++) {
        if (pinOf(parts[j]) === pin) { hit = envs[i]; break; }
      }
      if (hit) break;
    }

    if (hit) {
      // 更新：顺手把 enabled 一起写，多半一步就启用好了
      const body = JSON.stringify({ value: cookie, remarks: pin, enabled: true });
      return api("/api/v1/envs/" + hit.id, "PUT", token, body).then(function (r) {
        ensureOk(r, "更新环境变量");
        action = "已更新";
        return envs.length;
      });
    }

    const body = JSON.stringify([{ name: ENV_NAME, value: cookie, remarks: pin }]);
    return api("/api/v1/envs", "POST", token, body).then(function (r) {
      ensureOk(r, "新增环境变量");
      action = "已新增";
      return envs.length + 1;
    });
  }).then(function () {
    // 兜底：重新拉一遍，确认这条是启用状态（新建默认启用，被禁过的要手动开）
    return listJdEnvs(token).then(function (envs) {
      let hit = null;
      for (let i = 0; i < envs.length; i++) {
        const parts = splitCookies(envs[i].value);
        for (let j = 0; j < parts.length; j++) {
          if (pinOf(parts[j]) === pin) { hit = envs[i]; break; }
        }
        if (hit) break;
      }
      if (!hit || hit.enabled !== false) return true;
      return api("/api/v1/envs/" + hit.id + "/enable", "PUT", token, "{}")
        .then(function (r) { ensureOk(r, "启用"); return true; })
        .catch(function (e) { log(e.message); return false; });
    });
  }).then(function (enabled) {
    if (!CFG.pushBean) return { enabled: enabled };
    return queryBean(fields["pt_key"], pin).then(function (bean) {
      return { enabled: enabled, bean: bean };
    });
  }).then(function (res) {
    const nick = decodePin(pin);
    const lines = [action + (res.enabled ? " · 已启用" : " · ⚠️ 未启用，请去面板手动开")];
    if (res.bean) lines.push("京豆：" + res.bean);
    if (CFG.notify) $notification.post("京东 CK 已推送", nick, lines.join("\n"));
    log(action + " " + nick + " / " + (res.bean || ""));
    return res;
  });
}

/* ---------------- 入口 ---------------- */

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  $done({});            // 放行原请求，不修改它
}

// 兜底：最多挂 15 秒，免得把京东请求卡死
setTimeout(finish, 15000);

(function main() {
  const req = typeof $request !== "undefined" ? $request : {};
  const fields = collectFields(req);
  const ptKey = fields["pt_key"];
  const ptPin = fields["pt_pin"];

  // 大多数京东请求没有登录 Cookie，直接放行
  if (!ptKey || !ptPin) return finish();

  // 去重：同一个 CK 短期内不重复推
  const sig = ptPin + "|" + ptKey.length + "|" + ptKey.slice(-16);
  const lastSig = $persistentStore.read("jdck_sig") || "";
  const lastAt = parseInt($persistentStore.read("jdck_at") || "0", 10) || 0;
  const gap = (CFG.minGapMin || 10) * 60 * 1000;

  if (sig === lastSig && Date.now() - lastAt < gap) return finish();

  log("发现 CK：" + decodePin(ptPin) + "，开始推送");
  push(fields).then(function () {
    $persistentStore.write(sig, "jdck_sig");
    $persistentStore.write(String(Date.now()), "jdck_at");
    finish();
  }).catch(function (e) {
    log("推送失败：" + (e && e.message));
    if (CFG.notify) {
      $notification.post("京东 CK 推送失败", decodePin(ptPin), String((e && e.message) || e));
    }
    finish();
  });
})();
