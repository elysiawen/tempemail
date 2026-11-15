# temp-mail.org 后端接口分析与模拟说明

> 课程：网络安全专业 · 临时邮箱站点接口分析实验
> 分析对象：`https://temp-mail.org/zh/`
> 分析时间：2026-11-15
> 分析方式：Chrome DevTools 抓包 + 前端 JS 逆向 + 独立客户端复现（全部接口均实测）

> **合规声明**：本文仅用于课程学习与接口原理研究。所有请求均打在**自己新申请的临时邮箱**上，未触碰他人邮箱、未做批量注册、未绕过任何付费/登录鉴权。请勿将本文接口用于刷量、采集他人邮件或对抗站点风控。

---

## 1. 结论速览

| 项 | 值 |
| --- | --- |
| 前端站点 | `https://temp-mail.org`（jQuery + 服务端渲染，Cloudflare 防护） |
| 后端 API 域名 | `https://web2.temp-mail.org` |
| API Base Path | **根路径**（`/mailbox`、`/messages`），**不是** JS 里常量写的 `/api/v1` |
| 鉴权方式 | `POST /mailbox` 领取 JWT，之后统一 `Authorization: Bearer <token>` |
| 是否可纯脚本模拟 | **可以**（需处理 Cloudflare TLS 指纹，见第 8 节） |
| 核心接口数 | 7 个（建箱 / 查箱 / 列表 / 详情 / 原文 / 附件 / 删除） |

### 1.1 只看这份文档，能不能复刻？

| 能力 | 能否直接照文档实现 | 依据 |
| --- | --- | --- |
| 建箱、拿地址、拿 token | ✅ 可以 | 路径 / 方法 / 响应字段均实测 |
| 轮询收信、列表 | ✅ 可以 | 有完整真实响应样例 |
| 读邮件详情 / HTML 正文 / 提取验证码 | ✅ 可以 | 有完整真实响应样例 |
| 删除邮件 | ✅ 可以 | 实测 200，删除后再读返回 410 |
| 导出 `.eml` 原始邮件 | ✅ 可以 | 实测 2839 字节源码 |
| 下载附件 | ⚠️ 能写对请求，但字段名靠推断 | 无带附件的真实邮件样本，`attachments[]` 结构来自前端类型定义 |
| 获取可选域名列表 | ❌ 文档帮不了 | `/domains` 需账户 JWT，匿名 token 一律 401 |
| 自定义邮箱前缀 / 指定域名 | ❌ 接口本身不支持 | `POST /mailbox` 的 Body 被服务端忽略 |

> 下表用 **实测** / **推断** 标注每条结论的证据强度，写报告时请勿把「推断」当「实测」。

前端 JS 中打包了一份自动生成的 OpenAPI 客户端（`functions.js`），里面能直接读到接口路径、参数名和鉴权方案：

```
'/mailbox'
'/messages'
'/messages/{messageId}'
'/messages/{messageId}/source'
'/messages/{messageId}/attachment/{attachmentId}'
'/domains/'
```

实测发现其常量 `https://web2.temp-mail.org/api/v1` 只是生成器默认值，真实请求全部落在根路径（`/api/v1/messages` 实测返回 `E_ROUTE_NOT_FOUND`）。

---

## 2. 请求抓包概览

打开 `https://temp-mail.org/zh/` 后，与业务相关的请求只有一个：

```
POST https://web2.temp-mail.org/mailbox          200
```

响应体（真实抓包）：

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1dWlkIjoiZmFmODQxMDlhNmI4NGM3NWJiYTZhNTc2MDZhOTNjMzkiLCJtYWlsYm94IjoieGFtb21vOTEzM0BjaHV3ZWwuY29tIiwiaWF0IjoxNzk0NzQwNDg1fQ.v6IEW8HVl5NGK6RErhlFAoCOTQtPXC3CicjS_GHsqvU",
  "mailbox": "xamomo9133@chuwel.com"
}
```

关键请求头：

```
origin:  https://temp-mail.org
referer: https://temp-mail.org/
content-type: application/json
content-length: 0
```

关键响应头（说明架构与安全策略）：

```
access-control-allow-origin: https://temp-mail.org
access-control-allow-credentials: true
access-control-allow-methods: GET, POST, DELETE, OPTIONS
access-control-allow-headers: DNT, Cache-Control, Cookie, If-Modified-Since, Range, User-Agent, Authorization, Content-Type
x-ratelimit-limit: 10
x-ratelimit-remaining: 9
x-frame-options: DENY
server: cloudflare
```

---

## 3. 认证机制（重点）

### 3.1 JWT 结构

`token` 是标准 HS256 JWT，Base64Url 解码 payload 后只有三个字段：

```json
{
  "uuid": "faf84109a6b84c75bba6a57606a93c39",
  "mailbox": "xamomo9133@chuwel.com",
  "iat": 1794740485
}
```

| 字段 | 含义 |
| --- | --- |
| `uuid` | 该邮箱（会话）的唯一 ID，同时是 `GET /messages/{id}` 返回的 `user` 字段 |
| `mailbox` | 邮箱地址，服务端以此为准定位收件箱 |
| `iat` | 签发时间（Unix 秒） |

**注意：没有 `exp`（过期时间）字段**，签名也不可伪造（见 9.3 实测）。

### 3.2 令牌存放

前端通过 `$.cookie('token', token, {expires: 14, path: '/'})` 把令牌写进 **JS 可读的 Cookie**，有效期 14 天，所以：

- 刷新页面 / 重开标签页仍保持同一邮箱；
- Cookie 不是 HttpOnly，XSS 可直接读走令牌；
- 但**服务端只认 `Authorization` 头，不认 Cookie**（9.2 已实测：仅带 Cookie 会 401）。

### 3.3 鉴权头

```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

---

## 4. 通用约定

| 项 | 说明 |
| --- | --- |
| Base URL | `https://web2.temp-mail.org` |
| 数据格式 | `application/json; charset=utf-8`（`/source` 为 `application/octet-stream`） |
| 鉴权 | 除 `POST /mailbox` 外都需要 Bearer Token |
| 限流 | 响应头 `x-ratelimit-limit: 10`、`x-ratelimit-remaining`（**实测**）；超限应为 `429` + `retry-after`（**推断**，未触发验证） |
| 错误结构 | `{"errorMessage": "...", "errorName": "..."}` |

错误样例：

| 场景 | 状态码 | 响应 |
| --- | --- | --- |
| 无 / 错 Token | 401 | `{"errorMessage":"Unauthorized to access this resource","errorName":"UnauthorizedException"}` |
| 路由不存在 | 404 | `{"errorMessage":"E_ROUTE_NOT_FOUND: Cannot GET:/api/v1/messages","errorName":"HttpException"}` |
| 邮件不存在/已删除 | 410 | `{"errorMessage":"The target resource is no longer available","errorName":"GoneException"}` |
| 附件 ID 非法 | 500 | `{"errorMessage":"Internal Error","errorName":"InternalException"}` |

---

## 5. 接口清单

| # | 方法 | 路径 | 鉴权 | 作用 | 实测 |
| --- | --- | --- | --- | --- | --- |
| 1 | POST | `/mailbox` | 否 | 新建随机临时邮箱，返回 token + 地址 | ✅ 200 |
| 2 | GET | `/mailbox` | 是 | 查询当前 token 对应的邮箱地址 | ✅ 200 |
| 3 | GET | `/messages` | 是 | 收件箱列表 | ✅ 200（排序规律未验证） |
| 4 | GET | `/messages/{messageId}` | 是 | 邮件详情（HTML 正文、附件列表） | ✅ 200 |
| 5 | GET | `/messages/{messageId}/source` | 是 | 原始 RFC822 源码（可存为 .eml） | ✅ 200 |
| 6 | GET | `/messages/{messageId}/attachment/{attachmentId}` | 是 | 下载附件 | ⚠️ 路由存在（非法 ID 返回 500），无附件样本 |
| 7 | DELETE | `/messages/{messageId}` | 是 | 删除邮件 | ✅ 200 |
| — | GET | `/domains?secret=` | 账户 JWT | 查询可选域名 | ⚠️ 匿名邮箱 token 返回 401 |

---

## 6. 接口详细说明

### 6.1 POST /mailbox —— 新建临时邮箱

```
POST https://web2.temp-mail.org/mailbox
```

**请求**

- 无需鉴权。
- Body 可空（`content-length: 0`）。
- **实测：Body 被完全忽略**。传入 `{"domain":"chuwel.com"}`、`{"domain":"nope.invalid"}`、`{"name":"testabc"}` 均返回 200，且域名/前缀仍是随机值，说明域名不可由匿名用户指定。

**响应 200**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "mailbox": "yevop42826@bwingmedia.com"
}
```

**说明**

- 每次调用都会创建一个全新邮箱（旧的 token 依然有效），因此可用于“用完即弃”的收码场景。
- 域名在 `chuwel.com`、`bwingmedia.com`、`fulldiets.com`、`jysnk.com`、`artegin.com`、`jcaton.com` 等之间随机分配。
- 受 `x-ratelimit-limit: 10` 限制。

**curl 示例**（需先解决 Cloudflare，见第 8 节）

```bash
curl -X POST 'https://web2.temp-mail.org/mailbox' \
  -H 'origin: https://temp-mail.org' \
  -H 'referer: https://temp-mail.org/'
```

---

### 6.2 GET /mailbox —— 查询当前邮箱

```
GET https://web2.temp-mail.org/mailbox
Authorization: Bearer <token>
```

**响应 200**

```json
{ "mailbox": "noleko6655@jysnk.com" }
```

用途：Token 持久化后，重新获取邮箱地址（前端刷新页面时先走这一步）。

---

### 6.3 GET /messages —— 收件箱列表

```
GET https://web2.temp-mail.org/messages
Authorization: Bearer <token>
```

**可选参数**：`?mailbox=<地址>`。**实测该参数会被服务端忽略**，返回的永远是 Token 里 `mailbox` 的收件箱（安全结论见 9.1）。

**响应 200（真实收到 Viggle 验证码邮件时的抓包）**

```json
{
  "mailbox": "xamomo9133@chuwel.com",
  "messages": [
    {
      "_id": "6af99288de2c47e2f78c3816",
      "receivedAt": 1794740872,
      "from": "\"Viggle Team\" <noreply@viggle.ai>",
      "subject": "828502 - Viggle.ai - Sign up",
      "bodyPreview": " Welcome to Viggle! You're almost there! Please use the following code to verify your account: 82850",
      "attachmentsCount": 0
    }
  ]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | 邮件 ID（24 位十六进制，后续接口用它） |
| `receivedAt` | number | 接收时间，Unix **秒** |
| `from` | string | 原始 From 头（可能是 `"名字" <地址>` 或仅地址） |
| `subject` | string | 主题 |
| `bodyPreview` | string | 纯文本预览（约 100 字符，前端列表展示用） |
| `attachmentsCount` | number | 附件数量 |

空箱响应：`{"mailbox":"...","messages":[]}`

> **关于实时刷新（未验证）**：抓包窗口内只观察到 `POST /mailbox` 一次业务请求，没有抓到前端定时轮询 `/messages` 的请求（后续浏览器被 Cloudflare 挑战，未能复测）。因此"前端定时轮询"属于**合理推断而非实测**；自己实现时直接 5s 轮询该接口即可，不影响功能。

---

### 6.4 GET /messages/{messageId} —— 邮件详情

```
GET https://web2.temp-mail.org/messages/6af99288de2c47e2f78c3816
Authorization: Bearer <token>
```

**响应 200（字段已全量列出，HTML 已截断）**

```json
{
  "_id": "6af99288de2c47e2f78c3816",
  "receivedAt": 1794740872,
  "user": "faf84109a6b84c75bba6a57606a93c39",
  "mailbox": "xamomo9133@chuwel.com",
  "from": "\"Viggle Team\" <noreply@viggle.ai>",
  "subject": "828502 - Viggle.ai - Sign up",
  "bodyPreview": " Welcome to Viggle! You're almost there! Please use the following code to verify your account: 82850",
  "bodyHtml": "\n<body style=\"margin: 0; padding: 0; background-color: #f0f0f0;\">\n  <table ...>828502</span>...</body>",
  "attachmentsCount": 0,
  "attachments": [],
  "createdAt": "2026-11-15T11:07:52.303Z"
}
```

| 字段 | 说明 |
| --- | --- |
| `user` | 会话 UUID（= JWT 里的 `uuid`） |
| `mailbox` | 收件地址 |
| `bodyHtml` | **完整 HTML 正文**（原样返回，未去广告/未净化，注意 XSS 风险） |
| `attachments` | 附件数组，元素含 `attachmentId`、`filename`、`size`、`mimeType` 等（无附件时为 `[]`） |
| `createdAt` | 入库时间，ISO 8601（UTC） |

**错误**：ID 不存在或被删 → `410 GoneException`。

---

### 6.5 GET /messages/{messageId}/source —— 原始邮件源码

```
GET https://web2.temp-mail.org/messages/6af99288de2c47e2f78c3816/source
Authorization: Bearer <token>
```

**响应 200**：`Content-Type: application/octet-stream; charset=utf-8`，Body 为完整 RFC822 文本，可直接保存为 `.eml`。

真实抓到的头部（QQ 邮箱发来的测试信）：

```
Received: from out203-205-221-249.mail.qq.com (Unknown [10.244.13.251])
	by buildkitsandbox (Haraka/3.2.1) with ESMTP id 9AF6164A-...
	envelope-from <3123272@qq.com>;
	Sun, 15 Nov 2026 11:12:04 +0000
DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=qq.com; s=s201512;
From: "=?utf-8?B?V2luZHku?=" <3123272@qq.com>
To: "=?utf-8?B?bm9sZWtvNjY1NQ==?=" <noleko6655@jysnk.com>
```

> 顺带暴露了后端 MTA：**Haraka 3.2.1**（Node.js 邮件服务器）。

**错误**：ID 不存在 → `410`。

---

### 6.6 GET /messages/{messageId}/attachment/{attachmentId} —— 下载附件

```
GET https://web2.temp-mail.org/messages/{messageId}/attachment/{attachmentId}
Authorization: Bearer <token>
```

- 返回附件二进制（前端用 `Blob` + `saveAs` 下载）。
- 附件 ID 来自 6.4 响应中的 `attachments[].attachmentId`（**推断**：字段名取自前端生成的类型定义，实验中没有收到带附件的邮件，未做端到端验证）。
- 实测：路径存在；传入不存在的附件 ID 返回 `500 InternalException`（而非 404）。

---

### 6.7 DELETE /messages/{messageId} —— 删除邮件

```
DELETE https://web2.temp-mail.org/messages/6af99288de2c47e2f78c3816
Authorization: Bearer <token>
```

**响应 200**，Body 为空。

删除后再查列表即为空；再访问该 ID 返回 `410 GoneException`。

> 顺带测试：`DELETE /mailbox` 返回 404，说明没有公开的“销毁邮箱”接口（前端 JS 里的 `deleteMailbox` 对应的不是该路径）。

---

### 6.8 GET /domains?secret= —— 可选域名（未授权）

```
GET https://web2.temp-mail.org/domains?secret=<secret>
Authorization: Bearer <mailbox token>
```

- 从前端源码可知该方法需要参数 `secret`，并用 **`jwtAuth`**（账户 JWT）而非邮箱 token 鉴权。
- **实测**：用匿名邮箱 token、`secret` 传空、传 `sha256(邮箱地址)`、传 token 本身，全部返回：

```json
{"errorMessage":"Unauthorized to access this resource","errorName":"UnauthorizedException"}
```

- 结论：**域名列表接口只对已登录/付费账户开放**。免费用户看到的域名列表由 `/zh/change` 页面服务端渲染 HTML 下发，属于页面资源而非公开 API（该页同样受 Cloudflare 挑战保护）。

---

## 7. 数据模型

```ts
// 1) 建箱响应
interface NewMailbox {
  token: string;      // JWT
  mailbox: string;    // xxx@domain
}

// 2) JWT payload
interface TokenPayload {
  uuid: string;
  mailbox: string;
  iat: number;
}

// 3) 列表项
interface MessageItem {
  _id: string;
  receivedAt: number;       // Unix 秒
  from: string;
  subject: string;
  bodyPreview: string;
  attachmentsCount: number;
}

// 4) 详情
interface Message extends MessageItem {
  user: string;             // 会话 uuid
  mailbox: string;
  bodyHtml: string;
  attachments: Attachment[];
  createdAt: string;        // ISO 8601
}

// 5) 附件
interface Attachment {
  attachmentId: string;
  filename: string;
  size: number;
  mimeType: string;
}

// 6) 统一错误
interface ApiError {
  errorMessage: string;
  errorName: string;
}
```

---

## 8. 纯脚本模拟的关键点（Cloudflare）

直接用 `requests` / Node `fetch` 请求 `web2.temp-mail.org` 会得到 **403 + Cloudflare “Attention Required!” 页面**：

```
POST /mailbox -> 403  <!DOCTYPE html>... <title>Attention Required! | Cloudflare</title>
```

原因：站点启用了 Cloudflare Bot Management，会校验 **TLS/HTTP2 指纹**，而 Python/Node 默认指纹与浏览器不一致。

**解决：使用 `curl_cffi` 的浏览器指纹模拟（无需任何绕过脚本、无需 Cookie）**

```python
from curl_cffi import requests
s = requests.Session(impersonate="chrome")       # 实测 chrome / chrome124 / safari 均可
r = s.post("https://web2.temp-mail.org/mailbox")  # -> 200
```

实测结果：

```
chrome    200 {"token":"eyJ...","mailbox":"havodo9949@jysnk.com"}
chrome124 200 {"token":"eyJ...","mailbox":"cifit86820@chuwel.com"}
safari    200 {"token":"eyJ...","mailbox":"rakobo59085@artegin.com"}
```

### 8.1 最小可运行代码（复制即可跑，已实测）

```python
# pip install curl_cffi
from curl_cffi import requests
import time

BASE = "https://web2.temp-mail.org"
s = requests.Session(impersonate="chrome")        # 关键：通过 Cloudflare TLS 指纹校验

# 1) 建箱
mb = s.post(f"{BASE}/mailbox").json()
token, addr = mb["token"], mb["mailbox"]
H = {"Authorization": f"Bearer {token}"}
print("邮箱:", addr)

# 2) 轮询收信
seen = set()
for _ in range(60):                                # 最多轮询 60 次（约 5 分钟）
    msgs = s.get(f"{BASE}/messages", headers=H).json()["messages"]
    for m in msgs:
        if m["_id"] in seen:
            continue
        seen.add(m["_id"])
        print("新邮件:", m["from"], "|", m["subject"])

        # 3) 详情（含 bodyHtml）
        d = s.get(f"{BASE}/messages/{m['_id']}", headers=H).json()
        print("  详情字段:", list(d.keys()))

        # 4) 原始源码（可直接存 .eml）
        raw = s.get(f"{BASE}/messages/{m['_id']}/source", headers=H).content
        open(f"{m['_id']}.eml", "wb").write(raw)

        # 5) 删除
        s.delete(f"{BASE}/messages/{m['_id']}", headers=H)
    time.sleep(5)
```

实测输出（建箱段）：

```
邮箱: cififen790@bwingmedia.com
当前邮件数: 0
OK
```

> 附件下载把 URL 换成 `/messages/{id}/attachment/{attachmentId}` 即可（`attachmentId` 取自详情里的 `attachments[]`）。

其他工程要点：

1. **不要带 `Origin` 也无所谓**：服务端 CORS 只影响浏览器；脚本直连不需要 Origin，加上也不报错。
2. **令牌持久化**：把 `token` + `mailbox` 存本地，下次直接用 `GET /mailbox` 校验。
3. **限流退避**：`POST /mailbox` 有明显配额（`x-ratelimit-limit: 10`），批量调用需按 `retry-after` 等待。
4. **轮询间隔**：模拟前端时建议 ≥ 5s，避免触发风控。

---

## 9. 安全性观察（课程分析重点）

### 9.1 不存在 `mailbox` 参数越权（已验证）

```http
GET /messages?mailbox=xamomo9133@chuwel.com
Authorization: Bearer <另一个邮箱的 token>
```

响应始终是 **Token 自己**的邮箱：

```json
{"mailbox":"yerevep217@chuwel.com","messages":[]}
```

说明服务端以 JWT 内的 `mailbox` 为唯一依据，`mailbox` 查询参数被忽略，**无 IDOR**。

### 9.2 仅 Cookie 无法通过鉴权（无 CSRF 面）

```http
GET /messages
Cookie: token=eyJ...
```

→ `401 UnauthorizedException`。服务端只接受 `Authorization: Bearer`，因此传统 Cookie 型 CSRF 不成立。

### 9.3 JWT 签名校验有效

篡改 payload（把 `mailbox` 改成他人地址）但保留原签名：

```
打码后的 payload -> 401 UnauthorizedException
```

### 9.4 令牌 = 全部身份（主要风险点）

- JWT **无 `exp`**，且前端存入 **JS 可读 Cookie（14 天）**；
- 只要 token 泄露（XSS、日志、分享链接），即可在任意位置长期读取该邮箱全部邮件；
- 邮箱寿命令人担忧：临时邮箱本身设计如此，但不设过期时间放大了风险。

### 9.5 其他可记录的点

| 观察 | 说明 |
| --- | --- |
| 私信正文原样返回 HTML | `bodyHtml` 未净化，前端需自行 `sanitizeHtml`，存在 XSS 面 |
| 后端 MTA 指纹泄露 | `/source` 的 `Received` 头暴露 `Haraka/3.2.1` 与内网 IP `10.244.x.x` |
| 错误信息偏详细 | 会回显框架级错误名（`E_ROUTE_NOT_FOUND`、`UnauthorizedException`） |
| 限流仅见 `POST /mailbox` | 读接口未见限流头，批量轮询成本低 |
| CORS 白名单严格 | 仅 `https://temp-mail.org`，并 `allow-credentials: true` |

---

## 10. 模拟客户端（配套脚本）

仓库内脚本：[tempmail_client.py](file:///d:/CodeSpace/tempemail/tempmail_client.py)

```bash
pip install curl_cffi

python tempmail_client.py new        # 建箱，保存 token 到 .tempmail_session.json
python tempmail_client.py me         # 查当前地址
python tempmail_client.py inbox      # 收件箱列表
python tempmail_client.py watch      # 轮询等新邮件，并自动提取验证码
python tempmail_client.py read <id>  # 邮件详情
python tempmail_client.py source <id> -o mail.eml
python tempmail_client.py attachment <id> <attachmentId> -o a.bin
python tempmail_client.py delete <id>
python tempmail_client.py domains    # 预期 401（需账户 JWT）
```

### 实测记录（2026-11-15）

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 建箱 | `new` | `noleko6655@jysnk.com`，200 |
| 收信 | 用 QQ 邮箱投递一封测试信 | `inbox` 返回 1 封，发件人 `"Windy." <3123272@qq.com>` |
| 读信 | `read 6af99386e54bb1fcb68e91d8` | 主题 `1`、`bodyPreview` 为 ` 1 `、`bodyHtml` 长度 116 |
| 原文 | `source ... -o mail.eml` | 保存 2839 字节，头部含 QQ 的 DKIM 签名 |
| 删除 | `delete 6af99386e54bb1fcb68e91d8` | 200；再查 `inbox` 为 0 封；再读返回 `410 GoneException` |

另一组收信证据（浏览器抓包，Viggle 注册验证码）：

```
subject: "828502 - Viggle.ai - Sign up"
bodyPreview: " Welcome to Viggle! ... use the following code to verify your account: 82850"
```

---

## 11. 完整调用时序

```
客户端                                    web2.temp-mail.org
  |  POST /mailbox                              |
  |-------------------------------------------->|  生成 mailbox + 签 JWT
  |<--- {token, mailbox} ------------------------|
  |                                             |
  |  GET /messages  (Bearer token)              |
  |-------------------------------------------->|  查收件箱
  |<--- {mailbox, messages:[...]} ---------------|
  |                                             |
  |  GET /messages/{id}  (Bearer token)         |
  |-------------------------------------------->|  取详情（bodyHtml/attachments）
  |<--- {_id, from, subject, bodyHtml, ...} -----|
  |                                             |
  |  GET /messages/{id}/source                  |
  |-------------------------------------------->|  取原始 RFC822
  |<--- application/octet-stream ----------------|
  |                                             |
  |  GET /messages/{id}/attachment/{aid}        |
  |-------------------------------------------->|  取附件二进制
  |<--- binary ----------------------------------|
  |                                             |
  |  DELETE /messages/{id}                      |
  |-------------------------------------------->|  删除
  |<--- 200 (empty) -----------------------------|
```

---

## 12. 复核清单（老师可能会问）

1. 后端域名怎么来的？→ 首页唯一的业务 XHR `POST https://web2.temp-mail.org/mailbox`。
2. 为什么不用 Cookie 鉴权？→ 实测仅带 Cookie 返回 401，只认 `Authorization: Bearer`。
3. 域名列表能不能直接调？→ 不能，`/domains` 需要账户级 `jwtAuth`，匿名 token 一律 401。
4. 能不能指定想要的邮箱前缀/域名？→ 不能，`POST /mailbox` 的 Body 被忽略（实测 3 组参数均无效）。
5. 收信是不是 WebSocket/SSE？→ 不是，只有 HTTP 接口 `GET /messages`（前端是否轮询未实测，但无 WS/SSE 连接）。
6. 脚本为什么必须用 `curl_cffi`？→ Cloudflare 校验 TLS 指纹，普通 `requests` 直接 403。
