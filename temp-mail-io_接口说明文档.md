# temp-mail.io 后端接口分析与复刻说明

> 课程：网络安全专业 · 临时邮箱站点接口分析实验
> 分析对象：`https://temp-mail.io/zh`（页面标题「一次性临时电子邮件 - Temp Mail」）
> 分析时间：2026-11-15
> 分析方式：Chrome DevTools 抓包 + Nuxt 前端 JS 逆向 + 独立客户端复现（Python requests / curl_cffi）

> **合规声明**：本文仅用于课程学习与接口原理研究。所有请求只打在自己新申请的临时邮箱上，未读取他人邮箱、未批量注册、未绕过任何付费或登录鉴权。文中涉及的「建箱配额」「连接被断开」等现象是站点自身的反滥用措施，实验时已按低频串行方式调用。

---

## 1. 结论速览

| 项 | 值 |
| --- | --- |
| 前端站点 | `https://temp-mail.io/zh`（Nuxt 3 SSR + 客户端 hydration） |
| 后端 API 域名 | **`https://api.internal.temp-mail.io`**（注意是 `api.internal`，不是官方文档里的 `api.temp-mail.io`） |
| API Base Path | `/api`，业务前缀 `/api/v3`、`/api/v4` |
| 鉴权方式 | **默认无鉴权**；只有「删除」类接口需要在请求体里带 `token`，`token` 由建箱接口直接返回 |
| 是否需要注册 | 不需要（免费档） |
| 是否需要过 Cloudflare | **不需要**（实测普通 `requests` 直接 200；这与 temp-mail.org 必须伪造 TLS 指纹形成鲜明对比） |
| 主要限制 | 单 IP 建箱数量有隐性配额；超限后新箱仍可读但删除报 `Email not found`（详见第 9 节） |

### 1.1 只看这份文档能不能复刻？

| 能力 | 能否照文档实现 | 依据 |
| --- | --- | --- |
| 建箱、拿地址和 token | ✅ 可以 | `POST /v3/email/new`，有完整真实请求/响应，**实测** |
| **自定义前缀和域名** | ✅ 可以 | body 里加 `name` / `domain`，实测生成 `cs_test001@tanpony.com` |
| 拿可选域名列表 | ✅ 可以 | `GET /v4/domains`，公开无鉴权，**实测** |
| 轮询收信、拿列表 | ✅ 可以 | `GET /v3/email/{email}/messages`，**实测收到真实 QQ 邮件** |
| 读正文（HTML + 纯文本） | ✅ 可以 | **列表接口本身就带 `body_html` / `body_text`**，无需再请求详情 |
| 读单封详情 | ✅ 可以 | `GET /v3/message/{id}`，**实测** |
| 导出 `.eml` 原始邮件 | ✅ 可以 | `GET /v3/message/{id}/source_code?download=1`，实测 2577 字节，`filename=tempmail_download.eml` |
| 删除单封邮件 | ✅ 可以 | `DELETE /v3/message/{id}` + `{"token":...}`，实测 200，删后列表为 `[]` |
| 删除整个邮箱 | ⚠️ 能写对请求，但服务端有隐性配额 | 早期创建的邮箱删除 200 成功；短时间建箱过多后一律 `Email not found`（用官方前端点「删除」同样失败，已抓包确认） |
| 下载附件 | ⚠️ 请求写对了，但无成功样本 | 路径/参数取自前端源码，只实测了「附件不存在」的 400 |
| 登录 / 已保存邮件 / 转发规则 | ❌ 文档帮不了 | 需要账户会话 Cookie，匿名调用一律 `{"code":108,"message":"Session is empty"}` |

> 下文用 **实测** / **推断** 标注证据强度，写报告时不要把「推断」当「实测」。

---

## 2. 抓包概览

打开 `https://temp-mail.io/zh` 后，与业务相关的请求只有三条：

```
POST https://api.internal.temp-mail.io/api/v3/email/new                      [200]
GET  https://api.internal.temp-mail.io/api/v3/email/{email}/messages         [200]
GET  https://api.internal.temp-mail.io/api/v3/email/{email}/messages         [200]  ← 之后每 9 秒一次
```

抓包 25 分钟共记录到 **655 条**请求，其中 600+ 条是同一个 `/messages` 轮询——这就是它的「实时收信」实现方式（见 3.3）。

建箱请求 `POST /v3/email/new` 的完整抓包：

**请求头（节选，实测原文）**

```
application-name: web
application-version: 4.0.0
x-cors-header: iaWg3pchvFx48fY
content-type: application/json
origin: https://temp-mail.io
referer: https://temp-mail.io/
content-length: 43
```

**请求体**

```json
{"min_name_length":10,"max_name_length":10}
```

**响应 200**

```json
{"email":"t8cpimp2sw@tanpony.com","token":"i8c0y9odUpy8A7LEkyxV"}
```

响应头说明架构：

```
server: nginx/1.31.7
access-control-allow-origin: https://temp-mail.io
access-control-allow-credentials: true
access-control-allow-headers: Content-Type,Application-Name,Application-Version,x-cors-header
access-control-allow-methods: POST, GET, PUT, DELETE, OPTIONS, PATCH
```

> 没有 `x-ratelimit-*` 之类的限流头（对比 temp-mail.org 有 `x-ratelimit-limit: 10`）。

---

## 3. 核心机制

### 3.1 API 地址不是写死在 JS 里的

前端所有请求都走同一个封装函数（从 `_nuxt/CzGZKZ14.js` 反混淆得到，原文节选）：

```js
const isApiError = e => e instanceof Object && "request_id" in e;

const useApi = ({ url, method = "GET", payload = {}, signal = null }) => {
  const config = useRuntimeConfig();
  if (method === "GET" && isObject(payload) && Object.keys(payload).length > 0)
    url += `?${new URLSearchParams(omitBy(payload, isNil)).toString()}`;
  return fetch(url.includes("http") ? url : `${config.public.apiUrl}${url}`, {
    method,
    credentials: "include",
    body: method === "GET" ? null : JSON.stringify(payload),
    headers: { "Content-Type": "application/json", /* Application-Name 等 */ }
  });
};
```

所以 JS 里搜不到 `api.internal.temp-mail.io` 这个字符串。真实地址在运行时配置里，浏览器控制台可直接读到（实测）：

```js
window.__NUXT__.config.public
// {
//   apiUrl: "https://api.internal.temp-mail.io/api",
//   mobileTestingHeader: "iaWg3pchvFx48fY",     ← 就是 x-cors-header 的值
//   turnstileSiteKey: "0x4AAAAAAB_SSHi6TnI89KMz",
//   internalRequestMaxTimeout: 2000,
//   ...
// }
```

因此：**Base URL = `https://api.internal.temp-mail.io/api`**，且 `x-cors-header` 是一个写死的常量，不是动态签发的令牌。

### 3.2 三个自定义头其实可以不要

`application-name` / `application-version` / `x-cors-header` 看起来像「客户端指纹校验」，实测：

- 只带 `Content-Type: application/json`，`POST /v3/email/new` → 200 正常建箱；
- 只带 `Content-Type`，`GET /v3/email/{email}/messages` → 200 正常返回。

结论：**这三个头没有任何校验作用**，去掉不影响功能（保留只是为了和浏览器行为一致）。

真正必需的是 `Content-Type: application/json`——不带它建箱会 415：

```json
{"message":"Unsupported Media Type","request_id":"01M7FGF4QP12MGZ50D4EE4KTG2"}
```

### 3.3 「实时收信」= 9 秒轮询

前端收件箱组件里写死了轮询间隔（`_nuxt/CzGZKZ14.js`）：

```js
EMAIL_CHECKER_INTERVAL = 9e3;   // 9000 ms

Fe = () => {
  V.value && clearInterval(V.value);
  V.value = setInterval$1(() => {
    if (!isLoading && !isForwarding && view !== Views.SAVED) refresh();
  }, EMAIL_CHECKER_INTERVAL);
};
```

抓包也印证了：`GET /v3/email/{email}/messages` 每 9 秒左右一条，直到页面关闭。

### 3.4 会话状态存在 localStorage 而不是 Cookie

实测 `localStorage`（浏览器控制台原文）：

```json
// key: emails
[{"email":"t8cpimp2sw@tanpony.com","token":"i8c0y9odUpy8A7LEkyxV","current":true}]

// key: historyEmail
[{"date":1794742994615,"email":"t8cpimp2sw@tanpony.com","token":"i8c0y9odUpy8A7LEkyxV","uuid":534698,"inactive":true}]
```

含义：

- `emails`：当前浏览器里保存的邮箱列表（可切换多个），每个都带 `token`；
- `historyEmail`：历史上用过的地址，带创建时间戳 `date`（毫秒）和 `uuid`。

服务端**不依赖 Cookie 识别会话**——邮箱和 token 就是全部凭证，这也是它能在无痕窗口/脚本里直接复刻的原因。

---

## 4. 通用约定

| 项 | 说明 |
| --- | --- |
| Base URL | `https://api.internal.temp-mail.io/api` |
| 请求格式 | `POST/PATCH` 必须 `Content-Type: application/json`，body 为 JSON |
| 响应格式 | JSON（`source_code?download=1` 与附件为二进制流） |
| 鉴权 | 默认无；删除接口在 body 里带 `{"token": "<建箱返回的 token>"}` |
| 成功标识 | HTTP 200；删除类接口 body 为空字符串 |
| 限流头 | **无** |
| 错误结构 | `{"code": <int>, "message": "<英文>", "request_id": "<ULID>"}` 或 `{"message": "...", "request_id": "..."}` |

### 4.1 实测错误码对照表

| 场景 | HTTP | 响应体 |
| --- | --- | --- |
| 邮箱不存在 / 已被删除 | 400 | `{"code":101,"message":"Email not found","request_id":"..."}` |
| 附件 ID 不存在 | 400 | `{"code":102,"message":"Attachment not found","request_id":"..."}` |
| 删除时 token 错 / 缺失 | 400 | `{"code":106,"message":"Token is invalid","request_id":"..."}` |
| 登录密码错 | 400 | `{"code":107,"message":"Invalid password","request_id":"..."}` |
| 需要登录的接口匿名调用 | 400 | `{"code":108,"message":"Session is empty","request_id":"..."}` |
| 消息 ID 不存在（路由存在） | 404 | **空 body** |
| 路由/方法不存在 | 404 / 405 | `{"message":"Not Found"}` / `{"message":"Method Not Allowed"}` |
| 缺 `Content-Type: application/json` | 415 | `{"message":"Unsupported Media Type","request_id":"..."}` |
| 重复删除同一封邮件 | 500 | `{"message":"account: message not found","request_id":"..."}` |

---

## 5. 接口清单

| # | 方法 | 路径 | 鉴权 | 作用 | 实测 |
| --- | --- | --- | --- | --- | --- |
| 1 | POST | `/api/v3/email/new` | 无 | 新建临时邮箱，返回地址 + token | ✅ 200 |
| 2 | GET | `/api/v4/domains` | 无 | 可选域名列表（公开） | ✅ 200 |
| 3 | GET | `/api/v3/email/{email}/messages` | 无 | 收件箱列表（含正文） | ✅ 200，收到真实邮件 |
| 4 | GET | `/api/v3/message/{id}` | 无 | 单封邮件详情 | ✅ 200 |
| 5 | GET | `/api/v3/message/{id}/source_code` | 无 | 原始邮件（JSON 包装） | ✅ 200 |
| 6 | GET | `/api/v3/message/{id}/source_code?download=1` | 无 | 下载 `.eml` | ✅ 200，2577 字节 |
| 7 | GET | `/api/v3/attachment/{attachmentId}?download=1` | 无 | 下载附件 | ⚠️ 仅实测 400 分支 |
| 8 | GET | `/api/v3/attachment/{attachmentId}?preview=1` | 无 | 附件预览 | ⚠️ 同上 |
| 9 | DELETE | `/api/v3/message/{id}` | token | 删除单封邮件 | ✅ 200 |
| 10 | DELETE | `/api/v3/email/{email}` | token | 删除整个邮箱 | ⚠️ 部分成功，见 9.2 |
| 11 | POST | `/api/v3/features` | 无 | 功能开关 | ✅ 200 `{"features":{}}` |
| 12 | GET | `/api/v3/shop/pricing` | 无 | 套餐价目 | ✅ 200 |
| 13 | POST | `/api/v3/user/login` | 无 | 账户登录 | ⚠️ 只实测了密码错误分支 |
| 14 | GET | `/api/v3/user/inbox/messages` | 会话 | 已保存邮件列表 | ⚠️ 匿名 400 `Session is empty` |
| 15 | POST | `/api/v3/user/inbox/messages` | 会话 | 保存邮件（body `{"message_id":"..."}`） | 前端源码 |
| 16 | POST | `/api/v3/user/inbox/messages/{id}/unstar` | 会话 | 取消保存 | 前端源码 |
| 17 | POST | `/api/v3/user/settings.get` / `settings.set` / `logout` | 会话 | 账户设置 | 前端源码 |
| 18 | POST | `/api/v4/forward_email/send_confirmation` 等 | 会话 | 邮件转发 | 前端源码 |

> 第 13~18 项属于登录/付费功能，本次未注册账户，只验证了匿名调用的错误响应，**不代表真实成功返回结构**。

---

## 6. 接口详细说明

### 6.1 POST /v3/email/new —— 建箱（核心）

```
POST https://api.internal.temp-mail.io/api/v3/email/new
Content-Type: application/json

{"min_name_length":10,"max_name_length":10}
```

**响应 200**

```json
{"email":"t8cpimp2sw@tanpony.com","token":"i8c0y9odUpy8A7LEkyxV"}
```

| 字段 | 说明 |
| --- | --- |
| `email` | 新邮箱地址，前缀为小写字母+数字，域名从 `public` 池随机 |
| `token` | 20 字符左右的 base64url 随机串，**只在 DELETE 时用** |

**可自定义（实测逐条验证）**

| 请求体 | 实际结果 |
| --- | --- |
| `{"min_name_length":10,"max_name_length":10}` | `t8cpimp2sw@tanpony.com`（10 位随机） |
| `{"min_name_length":6,"max_name_length":6}` | `zs6ts1@olipii.com`（6 位） |
| `{"name":"helloworld12"}` | `helloworld12@ruutukf.com`（前缀被采用） |
| `{"name":"cs_test001","domain":"tanpony.com"}` | `cs_test001@tanpony.com`（前缀+域名都生效） |
| `{"domain":"nope.invalid"}` | `43qwfcy6ch@ooynib.com`（非法域名 → 静默回落随机） |
| `{"name":"a"}` | `a@ooynib.com`（没有强制最小长度） |
| `{"name":"ThisIsAVeryLongNameOverLimit123456"}` | `thisisaverylongnameoverlimit123456@olipii.com`（自动转小写，未截断） |
| `{}`（空 body） | 正常建箱 |

**注意**

- `name` 会被服务端强制转小写；
- 方法限制宽松：`PATCH /v3/email/new` 实测同样能建箱（返回 200），`GET` 则是 405；
- 前端点「随机」按钮调用的就是 `{min_name_length:10,max_name_length:10}`。

### 6.2 GET /v4/domains —— 域名列表（公开）

```
GET https://api.internal.temp-mail.io/api/v4/domains
```

**响应 200（实测节选）**

```json
{
  "domains": [
    {"name":"bwmyga.com","type":"public","forward_available":true,"forward_max_seconds":7776000},
    {"name":"lnovic.com","type":"public","forward_available":true,"forward_max_seconds":7772400},
    {"name":"ruutukf.com","type":"public","forward_available":true,"forward_max_seconds":7772400},
    {"name":"gmeenramy.com","type":"public","forward_available":true,"forward_max_seconds":7776000},
    {"name":"olipii.com","type":"public","forward_available":true,"forward_max_seconds":7776000},
    {"name":"ooynib.com","type":"public","forward_available":true,"forward_max_seconds":7776000},
    {"name":"tanpony.com","type":"public","forward_available":true,"forward_max_seconds":7776000}
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `name` | 域名 |
| `type` | 实测只有 `public`（推断付费档还有其它类型，未验证） |
| `forward_available` | 是否支持「转发到真实邮箱」 |
| `forward_max_seconds` | 转发最长有效期（秒），约 90 天 |

> 这是**完全公开**的接口，无 Cookie、无 token、无自定义头都能拿到（实测）。

### 6.3 GET /v3/email/{email}/messages —— 收件箱列表（关键）

```
GET https://api.internal.temp-mail.io/api/v3/email/t8cpimp2sw@tanpony.com/messages
```

**空箱响应 200**

```json
[]
```

注意是**裸数组**，不是 `{"messages": []}`（这点和官方 v1 API 不同）。

**有邮件时的真实响应（用户从 QQ 邮箱投递的测试信，原文未改动）**

```json
[
  {
    "id": "16a9f465-442f-4ab9-b50f-2da5608ad3c8",
    "from": "\"Windy.\" <3123272@qq.com>",
    "to": "7easkktf9x@olipii.com",
    "cc": null,
    "subject": "1",
    "body_text": "1",
    "body_html": "<div style=\"font-family: -apple-system, system-ui; font-size: 14px; color: rgb(0, 0, 0); line-height: 1.43;\">1</div>",
    "created_at": "2026-11-15T11:53:33.965343Z",
    "attachments": []
  }
]
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | UUID v4（36 位带横线），后续详情/删除都用它 |
| `from` | string | 原始 From 头，可能是 `"名字" <地址>` |
| `to` | string | 收件地址 |
| `cc` | string \| null | 抄送，常见为 `null` |
| `subject` | string | 主题 |
| `body_text` | string | 纯文本正文 |
| `body_html` | string | HTML 正文（**列表里就给全了**） |
| `created_at` | string | ISO 8601 UTC，**带微秒**（`...33.965343Z`） |
| `attachments` | array | 附件数组，无附件为 `[]` |

**重要：列表已经把正文带回来了。** 前端点开邮件时并不会再请求详情，而是直接把列表里的对象传给弹窗组件（`_nuxt/Cqi6A01f.js` 里 `props: { message: Object }`）。所以复刻收信只需要这一个接口。

**错误**

- 邮箱不存在或已过期 → 400 `{"code":101,"message":"Email not found",...}`
- **不需要 token**：只要知道邮箱地址就能读（这是该站的设计前提——临时邮箱本身是公开的，但也意味着地址可被枚举读取，见 9.3）

### 6.4 GET /v3/message/{id} —— 单封详情

```
GET https://api.internal.temp-mail.io/api/v3/message/16a9f465-442f-4ab9-b50f-2da5608ad3c8
```

**响应 200**：与列表里的单个元素**字段完全一致**（实测逐字段比对相同）。

**错误**：ID 不存在 → `404`，**响应体为空**（不是 JSON）。注意与「路由不存在」区分：路由不存在时 404 会返回 `{"message":"Not Found","request_id":"..."}`。

### 6.5 GET /v3/message/{id}/source_code —— 原始邮件

```
GET https://api.internal.temp-mail.io/api/v3/message/{id}/source_code
```

**响应 200**：`application/json`，原始 RFC822 源码被包在 `data` 字段里：

```json
{"data":"DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=qq.com; s=s201512;\n\tt=1794743611; ...\nFrom: ...\nTo: ...\nSubject: ...\n"}
```

**加 `?download=1` 才变成文件下载**

```
GET /api/v3/message/{id}/source_code?download=1
→ 200 application/octet-stream
→ content-disposition: attachment; filename=tempmail_download.eml
```

实测下载 2577 字节，可直接存成 `.eml` 用邮件客户端打开。

> 前端「下载留言」按钮的实现就是 `window.open(\`${apiUrl}/v3/message/${id}/source_code?download=1\`,"_blank")`（源码原文）。

### 6.6 GET /v3/attachment/{attachmentId} —— 附件

```
GET /api/v3/attachment/{attachmentId}?download=1     // 下载
GET /api/v3/attachment/{attachmentId}?preview=1      // 预览（图片/img/视频直接用）
```

来源（`_nuxt/Cqi6A01f.js` 原文）：

```js
i = s => `${m.public.apiUrl}/v3/attachment/${s}?preview=1`,   // 图片 src
y = s => `${m.public.apiUrl}/v3/attachment/${s}?download=1`,  // <a href>
// 模板里：r("a", { href: y(l.id), ... , "data-qa": "attachment-download" })
```

即 `{s}` 是 `attachments[].id`。

**实测部分**：传不存在的附件 ID → `400 {"code":102,"message":"Attachment not found","request_id":"..."}`，说明路由与参数名正确。

**未验证**：本次没有带附件的真实邮件（按要求跳过附件实验），成功下载的文件流/响应头未取到。

### 6.7 DELETE /v3/message/{id} —— 删除单封邮件

```
DELETE https://api.internal.temp-mail.io/api/v3/message/16a9f465-442f-4ab9-b50f-2da5608ad3c8
Content-Type: application/json

{"token":"5upD1Plusb0REFuuQNxi"}
```

**响应 200**：body 为空字符串。

**验证链路（实测）**

1. 删除前列表 1 条；
2. 删除 → 200；
3. 再查列表 → `[]`；
4. 再查详情 → 404（空 body）；
5. 再删一次 → `500 {"message":"account: message not found","request_id":"..."}`。

**错误**

- 不带 token / token 错 → `400 {"code":106,"message":"Token is invalid","request_id":"..."}`

> 注意：前端界面上根本**没有**单封删除按钮（`removeMessageById` 只改本地数组、不发请求），但接口确实存在且可用——这是靠 `DELETE /v3/message/{id}` 的 `code:106` 报错反推出来的。

### 6.8 DELETE /v3/email/{email} —— 删除整个邮箱

```
DELETE https://api.internal.temp-mail.io/api/v3/email/7easkktf9x@olipii.com
Content-Type: application/json

{"token":"5upD1Plusb0REFuuQNxi"}
```

**成功响应 200**：body 为空；随后 `GET /v3/email/{email}/messages` → `400 {"code":101,"message":"Email not found"}`。

**这是一个有坑的接口**，详见 9.2：同一个 token、同样的请求，老邮箱删得掉、刚建的新邮箱删不掉。

---

## 7. 数据模型

```ts
// ---------- 1) 建箱 ----------
interface NewEmailResponse {
  email: string;   // "t8cpimp2sw@tanpony.com"
  token: string;   // "i8c0y9odUpy8A7LEkyxV"，仅 DELETE 时使用
}

// ---------- 2) 域名 ----------
interface DomainInfo {
  name: string;                 // "tanpony.com"
  type: "public" | string;      // 实测仅见 public
  forward_available: boolean;
  forward_max_seconds: number;  // 7776000 ≈ 90 天
}

// ---------- 3) 邮件（列表项 / 详情 / 全字段一致） ----------
interface Message {
  id: string;                 // UUID v4
  from: string;               // "\"Windy.\" <3123272@qq.com>"
  to: string;                 // "7easkktf9x@olipii.com"
  cc: string | null;
  subject: string;
  body_text: string;
  body_html: string;
  created_at: string;         // ISO8601 UTC，带微秒："2026-11-15T11:53:33.965343Z"
  attachments: Attachment[];  // 无附件时 []
}

// ---------- 4) 附件（字段名取自前端源码，成功样本未采集） ----------
interface Attachment {
  id: string;      // 用于 /v3/attachment/{id}
  name: string;    // 文件名，前端用 name.split(".").pop() 判断类型
  size?: number;   // 推断，未验证
  type?: string;   // 推断：前端 ./types/${type}.vue 决定预览组件
  content?: string;// 推断：文本类附件直接内联内容
}

// ---------- 5) 错误 ----------
interface ApiError {
  code?: number;      // 101/102/106/107/108
  message: string;    // "Email not found"
  request_id: string; // ULID
}
```

**服务端标识**：所有错误里都有 `request_id`（ULID 格式，26 字符），前端用 `"request_id" in err` 判断是否为 API 错误——可用于工单排查。

---

## 8. 最小可运行代码

完整脚本见同目录 [`tempmailio_client.py`](file:///d:/CodeSpace/tempemail/tempmailio_client.py)，核心只有几十行：

```python
import json, time, requests

API = "https://api.internal.temp-mail.io/api"
H = {"Content-Type": "application/json",
     "Origin": "https://temp-mail.io",
     "Referer": "https://temp-mail.io/"}
s = requests.Session()

# 1) 建箱（可带 name / domain）
box = s.post(f"{API}/v3/email/new",
             data=json.dumps({"min_name_length": 10, "max_name_length": 10}),
             headers=H, timeout=20).json()
email, token = box["email"], box["token"]
print("地址:", email)          # 例：7easkktf9x@olipii.com

# 2) 轮询收信（服务端不带推送，只能自己拉）
while True:
    msgs = s.get(f"{API}/v3/email/{email}/messages", timeout=20).json()
    if msgs:
        m = msgs[0]
        print("主题:", m["subject"])
        print("发件人:", m["from"])
        print("正文:", m["body_text"])
        print("HTML:", m["body_html"][:120])
        break
    time.sleep(9)              # 与前端一致，9 秒一次

# 3) 导出 .eml（注意要加 ?download=1）
r = s.get(f"{API}/v3/message/{m['id']}/source_code", params={"download": 1}, timeout=20)
open("mail.eml", "wb").write(r.content)

# 4) 删除单封邮件（必须带 token）
s.request("DELETE", f"{API}/v3/message/{m['id']}",
          data=json.dumps({"token": token}), headers=H, timeout=20)

# 5) 删除整个邮箱
s.request("DELETE", f"{API}/v3/email/{email}",
          data=json.dumps({"token": token}), headers=H, timeout=20)
```

**实测运行结果**（`tempmailio_client.py` 冒烟测试）

```
domains: ['bwmyga.com', 'lnovic.com', 'ruutukf.com', 'gmeenramy.com']
new: {'email': 'r6n2eodwnb@tanpony.com', 'token': '5gbSXkDg-i-eWUQ1-Lp6'}
msgs: []
```

建箱、列表、域名、删除单封、导出 eml 全部通过；删除整箱受 9.2 的配额影响，在「建箱过多之后」会返回 `Email not found`（脚本会如实抛错，不做重试）。

---

## 9. 反滥用机制与实测异常（重点）

### 9.1 没有鉴权 = 没有 CSRF 风险，但有「邮箱即可读」风险

`GET /v3/email/{email}/messages` 和 `GET /v3/message/{id}` **完全不需要凭证**。任何人只要知道临时邮箱地址就能读信；而临时邮箱地址是随机但可枚举的（10 位小写字母+数字，且域名池只有 7 个）。

这就是站点不设 token 校验的原因——它把「临时邮箱」当成公开信箱。**副作用是：不能用它接收敏感信息**。

### 9.2 建箱配额：超限后新箱「读得到、删不掉」

这是本次实验最值得记的现象。

| 时间点 | 操作 | 结果 |
| --- | --- | --- |
| 实验早期（本 IP 只建过 1~2 个箱） | 建箱后立刻 `DELETE /v3/email/{email}` | **200 成功** |
| 实验中期（约 20 分钟前建的箱） | `DELETE` 同一个箱 | **200 成功** |
| 实验后期（本 IP 累计建箱十余个） | 新建箱 → 立刻 `DELETE` | **400 `{"code":101,"message":"Email not found"}`** |
| 实验后期 | 新建箱 → 等 33 秒 → `DELETE` | 仍然 400 |
| 实验后期 | 新建箱 → 等 4 分钟 → `DELETE` | 仍然 400 |
| 实验后期 | **用官方前端**点「随机」建箱，再点「删除」 | **同样 400**（已从 DevTools 抓到该请求，请求体 `{"token":"GWcYMRNzSNdH02t98OeP"}`，响应 `{"code":101,"message":"Email not found"}`） |

关键点：**用官方页面点删除也失败**，说明不是脚本参数写错，而是服务端状态问题。

**推断（未从服务端证实）**：站点对单出口 IP 的建箱数量有隐性配额。超限后接口仍会返回 `email` + `token`、`GET /messages` 也能正常返回 `[]`，但这些新箱并未真正落到主库（或落在某种临时/影子存储里），因此依赖主库的 `DELETE` 查不到记录。也可能是建箱写主库存在异步延迟，而本 IP 恰好触发了降级路径。

**实践建议**：复刻时把「删除邮箱」当成**可选清理**而非必需步骤；临时邮箱本身有 TTL，不删也会自动过期。

### 9.3 高频调用会被直接断连

连续快速 `DELETE`（约每 5 秒一次，连发 8 次）后，出现：

```
requests.exceptions.ConnectionError: ('Connection aborted.',
  RemoteDisconnected('Remote end closed connection without response'))
```

即服务端在 nginx 层直接关闭连接，不返回任何响应体。这与 linshiyouxiang.net 弹图形验证码属于同一类反刷措施，只是手段更粗暴。

### 9.4 没有图形验证码 / 没有 Turnstile

与另外两个站点不同：

- 没有 `/rate-captcha` 之类的图形验证；
- 配置里虽然有 `turnstileSiteKey`（Cloudflare Turnstile），但**网页端建箱流程没有触发**（实测建箱请求里没有任何 turnstile token 字段）。

因此纯脚本复刻不需要处理人机验证——但也请遵守 9.3 的频率限制，别把反滥用机制逼到更严格的档位。

---

## 10. 与另外两个站点的对比

| 维度 | temp-mail.org | linshiyouxiang.net | **temp-mail.io** |
| --- | --- | --- | --- |
| 后端域名 | `web2.temp-mail.org` | 与前端同域 | **`api.internal.temp-mail.io`** |
| 鉴权 | JWT（`Authorization: Bearer`） | Cookie + HTML 内联签名 `code` | **基本无鉴权，仅删除带 token** |
| 是否有建箱接口 | ✅ `POST /mailbox` | ❌ 打开首页即建箱 | ✅ `POST /v3/email/new` |
| 能否自定义地址 | ❌ Body 被忽略 | 只能换域名 | ✅ **`name` + `domain` 都能指定** |
| 是否需过 Cloudflare 指纹 | ✅ 必须（curl_cffi） | ✅ 必须 + 还会弹验证码 | ❌ **普通 requests 即可** |
| 正文在哪 | 详情接口 `bodyHtml` | 详情页 HTML 里的模板字符串 | **列表接口直接给 `body_html`** |
| 实时刷新 | 未抓到（推断轮询） | 6 秒倒计时后整页 reload | **9 秒 setInterval 轮询** |
| 原始邮件 | `/source`（octet-stream） | 无 | `/source_code`（JSON 包装，`?download=1` 才是文件） |
| 删单封邮件 | ✅ `DELETE /messages/{id}` | ✅ `POST /mail/delete/{Code}` | ✅ `DELETE /v3/message/{id}` + token |
| 公开域名列表 | ❌ 需账户 JWT | ✅ `GET /get-domains` | ✅ `GET /v4/domains` |
| 消息 ID 形态 | 24 位十六进制 | 32 位十六进制 | **UUID v4（带横线）** |

一句话总结：**temp-mail.io 是三者里最好复刻的**——没有 Cloudflare、没有验证码、正文在列表里、还能自定义地址；唯一麻烦是文档全在前端 JS 里，以及删除有隐性配额。

---

## 11. 复核清单

复刻完可以用下面几条自检：

- [ ] Base URL 用的是 `https://api.internal.temp-mail.io/api`（不是 `api.temp-mail.io`，那是官方付费 v1）
- [ ] 建箱请求带 `Content-Type: application/json`，否则 415
- [ ] `token` 保存下来了（删除时要）
- [ ] 邮件 ID 按 UUID 处理（36 位，别按 24/32 位十六进制去截断）
- [ ] `created_at` 按 ISO8601 **带微秒**解析（Python `datetime.fromisoformat` 需处理 `Z`）
- [ ] 正文直接读列表里的 `body_html` / `body_text`，不必额外请求详情
- [ ] 下载 `.eml` 记得加 `?download=1`，否则拿到的是 `{"data": "..."}` JSON
- [ ] 删除单封邮件要 `{"token": ...}`，且删第二次会 500
- [ ] 轮询间隔别小于 5 秒（站点自身是 9 秒），连续 DELETE 会被断连
- [ ] `attachments: []` 时不要报错（无附件就是空数组）

---

## 12. 未覆盖 / 存疑项

1. **附件成功下载未验证**：`/v3/attachment/{id}` 的路径、参数、`attachment.id` 来源都取自前端源码，且实测了「附件不存在 → 400 code 102」，但没有带附件的真实邮件样本，成功响应的 `Content-Type` / `Content-Disposition` / 文件流结构未知。
2. **建箱配额的确切成因未知**：「超限后新箱删不掉」是现象级结论，是否与 IP、时间窗、创建次数有关未做量化实验（也不宜继续刷）。
3. **邮箱 TTL 未测**：页面文案说「长时间不收信会被删除」，具体时长（10 分钟？几天？）没有实测。
4. **`type` 为 `public` 之外的域名**：`/v4/domains` 只见到 public，付费档的自定义域名（custom-domains 页面）返回结构未知。
5. **账户/付费接口**：`/v3/user/*`、`/v3/shop/pricing`、`/v4/forward_email/*` 只确认了路由存在与匿名调用错误，成功返回结构未验证（需注册 + 付费）。
6. **官方 v1 API 与内部 v3 API 的差异**：官方文档 `https://docs.temp-mail.io` 描述的是 `https://api.temp-mail.io/v1`，需要 `X-API-Key` 且要付费账户；本文分析的是网页端使用的 v3/v4 内部接口，两者**不是同一套**，字段也有差异（v1 返回 `{"messages":[...]}`，v3 返回裸数组）。
7. **轮询上限**：长时间挂着页面每 9 秒请求一次，是否会被计入某个隐藏配额，未做长时观察。
