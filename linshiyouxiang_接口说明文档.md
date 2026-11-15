# linshiyouxiang.net 后端接口分析与复刻说明

> 课程：网络安全专业 · 临时邮箱站点接口分析实验
> 分析对象：`https://www.linshiyouxiang.net/`（临时邮箱 / 临时谷歌邮箱）
> 分析时间：2026-11-15
> 分析方式：Chrome DevTools 抓包 + 首页内联 JS 阅读 + 独立客户端复现（curl_cffi）

> **合规声明**：仅用于课程学习与接口原理研究。所有请求只针对自己刚生成的临时邮箱，未触碰他人邮箱、未做批量注册、**未编写任何验证码识别/绕过代码**。站点在请求过频时会下发图形验证码，这属于其反滥用措施，应当遵守。

---

## 1. 结论速览

| 项 | 值 |
| --- | --- |
| 前端站点 | `https://www.linshiyouxiang.net`（服务端渲染 + 内联 JS，Cloudflare 前置） |
| 后端 API 域名 | **与前端同域**，无独立 API 子域 |
| API Base Path | 根路径（`/get-domains`、`/get-messages`、`/mail/view/...`） |
| 鉴权方式 | **没有传统登录鉴权**；邮箱地址 + `code` 签名放在页面 HTML 里，配合 Cookie |
| 是否需要注册 | 不需要（免费档） |
| 最大特点 | **没有"建箱接口"**——打开首页即是建箱 |
| 主要限制 | 同一 IP 请求过频会弹 4 位图形验证码（`/rate-captcha/page`） |

### 1.1 只看这份文档能不能复刻？

| 能力 | 能否照文档实现 | 依据 |
| --- | --- | --- |
| 建箱（拿到一个可用地址） | ✅ 可以 | `GET /` 返回 HTML 内含 `activeMail` / `activeMailCode`，**实测** |
| 拉收件箱列表 | ✅ 可以 | `POST /get-messages`，有完整真实响应，**实测** |
| 读邮件正文 | ✅ 可以 | `GET /mail/view/{Code}` 的 HTML 里 `const emailContent = \`...\``，已实测匹配到 2436 字符正文并与 iframe 渲染内容一致 |
| 更换域名 | ✅ 可以 | `POST /change-domain`，**实测**返回新地址 |
| 获取可选域名列表 | ✅ 可以 | `GET /get-domains`，**实测** |
| 切换 Gmail 别名 | ✅ 可以（免费档限制见 6.5） | `POST /change-to-gmail`，参数来自前端 JS |
| 删除单封邮件 | ✅ 可以 | `POST /mail/delete/{Code}` → `{"message":"email_deleted","success":true}`，删后列表为空，**实测** |
| 清空全部记录 | ⚠️ 有接口但有人机验证 | `POST /destroy`，实测被 `安全验证` 页拦截 |

---

## 2. 抓包概览（打开首页的全部业务请求）

```
GET  https://www.linshiyouxiang.net/                                    [200]
GET  https://www.linshiyouxiang.net/member/check-login                  [200]
GET  https://www.linshiyouxiang.net/get-domains                         [200]
GET  https://www.linshiyouxiang.net/member/mailbox/check-lock-status?email=xxx@123mails.org [200]
POST https://www.linshiyouxiang.net/get-messages                        [200/403]   ← 首屏加载调用一次
POST https://www.linshiyouxiang.net/get-messages                        [200/403]   ← 点"刷新"后整页 reload 再调
```

两个关键发现：

1. **首页 `GET /` 就是"建箱"**：HTML 里直接内联了本次会话的邮箱和签名 `code`。
2. **没有自动轮询**：`getMessages()` 只在首屏加载时执行一次；点"刷新"按钮是**6 秒倒计时后 `window.location.reload()`**，靠整页重载刷新列表，并不存在 `setInterval` 定时拉取。

---

## 3. 核心机制：邮箱和签名都在 HTML 里

首页是服务端渲染的，`<script>` 中会内联两行常量（真实抓取）：

```js
const activeMail = 'zapuymay@inctart.com';
const activeMailCode = 'c015540fee6f41d692d2e6bb26e1ee1bd593b35f0f664469d444e5cda291e005';
```

- `activeMail`：本次分配的邮箱地址（服务端随机生成，或读取你已选的地址）；
- `activeMailCode`：64 位十六进制（sha256 长度）**签名**，后续所有接口都要带上它；
- 抓包中同一个地址的 code 恒为同一值，说明是**由服务端签发给该邮箱的凭证**，脚本无法自行推算。

所以复刻的第一步不是"建箱接口"，而是：

```
GET /  →  正则提取 activeMail / activeMailCode  →  带着 Cookie 继续调用其它接口
```

### 3.1 Cookie 承担状态

`GET /` 之后站点会下发这些 Cookie（抓包原文）：

| Cookie | 作用 |
| --- | --- |
| `temp_mail` | 当前邮箱地址（URL 编码） |
| `temp_mail_history` | Base64 的历史邮箱记录 |
| `poll_token` | **自定义签名令牌**，负载可见：`{"email":"...","session":"ip:114.x.x.x","ua_hash":"5660f459...","exp":1794742449}` |
| `lang` | 语言 |

`poll_token` 把 **邮箱 + 出口 IP + User-Agent 哈希 + 过期时间** 绑在一起，所以脚本必须：

- 全程使用**同一个 Session**（Cookie 不能丢）；
- **UA 保持一致**（`curl_cffi` 的 `impersonate="chrome"` 生成的 UA 固定即可）；
- 不要中途换代理 IP，否则令牌校验会失败。

---

## 4. 通用约定

| 项 | 说明 |
| --- | --- |
| Base URL | `https://www.linshiyouxiang.net` |
| 鉴权 | Cookie（`temp_mail` + `poll_token`）+ 请求体里的 `code` |
| 请求格式 | `POST` 业务接口统一 `Content-Type: application/json` |
| 响应格式 | JSON（`/get-messages`、`/get-domains`、`/change-*`）；详情页是 **HTML** |
| 成功标识 | JSON 里 `"success": true` |
| 错误标识 | `{"success":false,"error":"..."}`，HTTP 可能是 403/200 |
| 限流 | 请求过频 → 返回 `安全验证` 页（HTTP 200，但内容是 `/rate-captcha/page`） |

错误样例（实测，请求体里的 code 与服务端不匹配时）：

```json
{"code":403,"error":"无效的请求","success":false}
```

---

## 5. 接口清单

| # | 方法 | 路径 | 鉴权 | 作用 | 实测 |
| --- | --- | --- | --- | --- | --- |
| 1 | GET | `/` 或 `/zh` | 无 | 建箱：返回含 `activeMail`/`activeMailCode` 的 HTML | ✅ |
| 2 | POST | `/get-messages` | code + Cookie | 收件箱列表 | ✅ |
| 3 | GET | `/mail/view/{Code}` | Cookie | 邮件详情（HTML，正文在 iframe） | ✅ 实测解析成功 |
| 4 | POST | `/mail/delete/{Code}` | Cookie | 删除单封邮件 | ✅ 200 `email_deleted` |
| 5 | POST | `/change-domain` | Cookie | 换一个域名（新地址） | ✅ |
| 6 | POST | `/change-to-gmail` | Cookie | 切换 Gmail 别名 / 完整 Gmail | 前端调用已确认 |
| 7 | GET | `/get-domains` | 无 | 可选域名分组列表 | ✅ |
| 8 | GET | `/member/check-login` | Cookie | 是否登录（会员功能判断） | ✅ |
| 9 | GET | `/member/mailbox/check-lock-status?email=` | Cookie | 邮箱是否被锁定 | ✅ |
| 10 | POST | `/member/mailbox/lock` | Cookie | 锁定邮箱（会员） | 前端调用已确认 |
| 11 | POST | `/destroy` | Cookie + 人机验证 | 销毁全部记录 | ⚠️ 被验证码拦截 |

---

## 6. 接口详细说明

### 6.1 GET / —— 建箱 & 取签名（第一步）

```
GET https://www.linshiyouxiang.net/
```

**响应 200**：一份约 160 KB 的 HTML，用正则取两行：

```python
import re
mail = re.search(r"const activeMail = '([^']+)'", html).group(1)
code = re.search(r"const activeMailCode = '([^']+)'", html).group(1)
```

实测产出：`zapuymay@inctart.com` + `c015540f...291e005`（64 位十六进制）。

**注意**

- 每个全新 Session（无 Cookie）访问都会分配一个新随机邮箱；
- 同一 Session 再次访问则返回同一个邮箱（读 `temp_mail` Cookie）；
- 无参数、无请求体。

---

### 6.2 POST /get-messages —— 收件箱列表

```
POST https://www.linshiyouxiang.net/get-messages
Content-Type: application/json

{"email":"reeByzak@123mails.org","code":"cb98cf73...9514b3"}
```

可选 `?lang=zh`（只影响错误文案，不影响数据）。

**响应 200（真实收到 QQ 邮件时的抓包）**

```json
{
  "success": true,
  "emails": [
    {
      "Code": "0b9b193df29cd0c645f82c1197102798",
      "FromEmail": "3123272@qq.com",
      "FromName": "Windy.",
      "SendTime": 1794742118,
      "Status": 0,
      "Subject": "1",
      "gmail": false
    }
  ]
}
```

空箱响应：`{"emails":null,"success":true}`（注意是 `null` 不是 `[]`）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `Code` | string | 邮件 ID（32 位十六进制），详情页 URL 用 |
| `FromEmail` | string | 发件人邮箱（明文） |
| `FromName` | string | 发件人显示名 |
| `SendTime` | number | Unix **秒** |
| `Status` | number | 0 = 未读，1 = 已读（**实测**：打开详情页后再查列表，该邮件由 0 变 1） |
| `Subject` | string | 主题 |
| `gmail` | bool | 是否 Gmail 别名邮件 |

> 页面在首屏加载时调用一次；点"刷新"按钮是 6 秒倒计时后**整页 reload**，不是定时轮询。复刻时自己按 5~10s 轮询即可。

---

### 6.3 GET /mail/view/{Code} —— 邮件详情页

```
GET https://www.linshiyouxiang.net/mail/view/0b9b193df29cd0c645f82c1197102798
```

Gmail 别名邮件要加后缀：`/mail/view/{Code}/gmail`（前端 `gmailSuffix`）。

**返回 HTML（约 165 KB），不是 JSON。** 结构：

1. 发件人 / 时间在 `<ul class="list-unstyled">` 里，例如

```html
<li><i class="fa fa-user-o"></i>发件人:
  Windy. &lt;<a href="/cdn-cgi/l/email-protection" class="__cf_email__"
              data-cfemail="a695...">[email&#160;protected]</a>&gt;
</li>
```

> 注意：站点开了 Cloudflare 邮箱混淆，HTML 里的地址是 `data-cfemail` 编码的；**取明文请用 6.2 的 `FromEmail`**，别去解混淆。

2. 正文不在 HTML 里直接可见，而是：

```html
<iframe id="email-iframe" sandbox="allow-same-origin allow-scripts allow-popups"
        style="width:100%;border:none;overflow:hidden;min-height:800px;" scrolling="no"></iframe>
```

3. 同页 JS 把正文塞进模板字符串，再写进 iframe：

```js
const emailContent = `
    <!DOCTYPE html>
    <html>
    <head><style>body{margin:0;padding:10px;font-family:Arial,sans-serif;}</style></head>
    ...
`;
// 之后 iframe.srcdoc = emailContent（或 document.write）
```

**复刻取正文的思路**

```python
m = re.search(r"const emailContent = `([\s\S]*?)`;", view_html)
body_html = m.group(1) if m else None
```

> ✅ **已实测**：在通过的验证码的浏览器会话中打开该详情页，正则匹配成功，`emailContent` 长度 **2436** 字符，开头为 `<!DOCTYPE html><html><head><style>body{margin:0;padding:10px;...}`；`iframe#email-iframe` 渲染出的纯文本为邮件正文 `1`，与列表里的 `Subject` 一致。若正文里出现反引号或 `${`，正则需改用更稳的边界。

**页面上的操作按钮（实测 DOM）**

| 按钮 | 行为 |
| --- | --- |
| 删除 | `onclick="deleteMessage('<Code>')"` → 见 6.3.1 |
| 刷新 / 自定义 / 历史 / 销毁 | 分别对应列表刷新、换域名、历史邮箱、清空记录 |

---

### 6.3.1 POST /mail/delete/{Code} —— 删除单封邮件

从详情页"删除"按钮的内联 JS 原样提取（`deleteMessage` 函数体）：

```js
fetch(`/mail/delete/${code}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
})
.then(response => response.json())
.then(data => {
    if (data.success) { window.location.href = '/'; }
});
```

**接口定义**

```
POST https://www.linshiyouxiang.net/mail/delete/{Code}
Content-Type: application/json
Cookie: temp_mail=...; poll_token=...
```

**响应 200（实测）**

```http
Content-Type: application/json; charset=utf-8

{"message":"email_deleted","success":true}
```

删除后立即再查列表：`{"emails":null,"success":true}`（已清空）。

> 早先用 Python 探测 `POST /mail/delete/<假 ID>` 返回的是 HTML，当时误以为路由不存在 —— 其实那是 `安全验证` 页接管了响应，不是 404。

---

### 6.4 POST /change-domain —— 换域名

```
POST /change-domain
Content-Type: application/json

{"domain":"123mails.org"}
```

**响应 200（实测）**

```json
{"email":"cydwaan27@123mails.org","success":true}
```

- 会把当前邮箱换成"同前缀或新前缀 + 指定域名"，并更新 Cookie；
- 之后重新 `GET /` 即可拿到新的 `activeMail` / `activeMailCode`；
- 域名必须在 6.6 的 normal 列表里，VIP 域名会失败（前端会弹付费框）。

### 6.5 POST /change-to-gmail —— Gmail 别名

前端请求体（从首页 JS 原样抄出）：

```json
// 别名模式：abc+hello@gmail.com
{"type":"gmail_alias","template":"abc+hello@gmail.com"}

// 指定完整地址
{"type":"gmail_full","email":"yourname@gmail.com"}

// 随机完整地址（VIP）
{"type":"gmail_full_random"}
```

响应同样 `{"success":true,...}`；若换得太频繁，会返回 `gmail_limit_reached`。

### 6.6 GET /get-domains —— 域名列表（公开）

```
GET https://www.linshiyouxiang.net/get-domains
```

**响应 200（实测节选）**

```json
[
  {
    "type": "normal",
    "title": "",
    "items": [
      {"is_new": true,  "domain": "agogmail.com",      "type": "domain", "is_vip": false},
      {"is_new": false, "domain": "123mails.org",      "type": "domain", "is_vip": false},
      {"is_new": false, "domain": "gmail.com", "type": "gmail_alias", "is_vip": false, "template": "a.b.c@gmail.com"},
      {"is_new": false, "domain": "gmail.com", "type": "gmail_alias", "is_vip": false, "template": "abc+hello@gmail.com"}
    ]
  },
  {
    "type": "vip",
    "title": "",
    "items": [
      {"domain": "pdf-cutter.com", "type": "domain", "is_vip": true},
      {"domain": "mailsbay.com",   "type": "domain", "is_vip": true},
      {"domain": "gmail.com", "type": "gmail_full_random", "is_vip": true}
    ]
  }
]
```

> 这是**免费公开**接口，和 temp-mail.org 的 `/domains`（需账户 JWT）形成鲜明对比。

### 6.7 销毁记录 POST /destroy

- 前端"销毁所有记录"按钮；
- 实测返回一个 **`安全验证`** 页（4 位图形验证码，`POST /rate-captcha/verify`），不是 JSON；
- 单封删除请用 6.3.1 的 `POST /mail/delete/{Code}`。

---

## 7. 数据模型

```ts
interface Mailbox {            // 由 GET / 的 HTML 下发
  activeMail: string;
  activeMailCode: string;      // 64 位 hex 签名
}

interface MessageItem {
  Code: string;                // 32 位 hex
  FromEmail: string;
  FromName: string;
  SendTime: number;            // Unix 秒
  Status: number;              // 0=未读
  Subject: string;
  gmail: boolean;
}

interface MessagesResponse {
  success: boolean;
  emails: MessageItem[] | null;   // 空箱为 null
}

interface ChangeDomainResponse {
  success: boolean;
  email: string;
  error?: string;
}
```

---

## 8. 最小可运行代码（建箱 + 收信，已实测到"取列表"）

```python
# pip install curl_cffi
import re
from curl_cffi import requests

B = "https://www.linshiyouxiang.net"
s = requests.Session(impersonate="chrome")     # 关键：固定 UA，poll_token 会校验 ua_hash

# 1) 建箱：GET / 并从 HTML 里抠出地址和签名
html = s.get(B + "/", timeout=30).text
mail = re.search(r"const activeMail = '([^']+)'", html).group(1)
code = re.search(r"const activeMailCode = '([^']+)'", html).group(1)
print("邮箱:", mail)

# 2) 拉列表
data = s.post(B + "/get-messages", json={"email": mail, "code": code}, timeout=30).json()
for m in (data.get("emails") or []):
    print(m["SendTime"], m["FromName"], "|", m["Subject"], "|", m["Code"])

# 3) 取正文（解析详情页模板字符串）
if data.get("emails"):
    c = data["emails"][0]["Code"]
    view = s.get(f"{B}/mail/view/{c}", timeout=30).text
    mm = re.search(r"const emailContent = `([\s\S]*?)`;", view)
    print("正文长度:", len(mm.group(1)) if mm else "未匹配")

    # 4) 删除单封（实测：返回 {"message":"email_deleted","success":true}）
    print(s.post(f"{B}/mail/delete/{c}", timeout=30).json())
```

实测输出：

```
邮箱: zapuymay@inctart.com
（列表为空时输出为空）
```

以及收信后的列表：

```json
{"emails":[{"Code":"0b9b193df29cd0c645f82c1197102798","FromEmail":"3123272@qq.com",
"FromName":"Windy.","SendTime":1794742118,"Status":0,"Subject":"1","gmail":false}],
"success":true}
```

---

## 9. 反滥用机制（复刻时必须注意）

| 机制 | 表现 | 应对（也是本实验的边界） |
| --- | --- | --- |
| Cloudflare | 前置 CDN，普通 `requests` 的 TLS 指纹会被拦 | 用 `curl_cffi` 的 `impersonate="chrome"`；**不要写绕过脚本** |
| IP 频率限制 | 短时间多次请求后，任何页面都变成 `安全验证` | 降低频率、串行请求、复用 Session；**不识别验证码** |
| 4 位图形验证码 | `GET /rate-captcha/image`，提交到 `/rate-captcha/verify` | 这是反滥用的人机验证，实验到此为止 |
| `poll_token` 绑定 | 令牌内含 `ip`、`ua_hash`、`exp` | 同一 Session、同一 UA、同一出口 IP |

> 实验中出现过：连续 ~10 次请求后，**浏览器和 curl_cffi 都被限流**，页面跳 `/rate-captcha/page?return_url=...`。
> 人工通过验证码后，**只再发了 3~4 个请求就再次被打回验证码页** —— 说明该限制是按 IP 计、阈值很低、且冷却期较长。复刻时务必串行、低频。

---

## 10. 与 temp-mail.org 的对比（可直接写进报告）

| 维度 | temp-mail.org | linshiyouxiang.net |
| --- | --- | --- |
| 后端域名 | 独立 `web2.temp-mail.org` | 同域，无独立 API 子域 |
| 建箱 | `POST /mailbox` 返回 JWT | **无建箱接口**，`GET /` 即建箱 |
| 鉴权 | `Authorization: Bearer <JWT>` | Cookie（`poll_token`，绑 IP+UA）+ 请求体 `code` |
| 收信 | `GET /messages`（JSON） | `POST /get-messages`（JSON） |
| 读信 | `GET /messages/{id}`（JSON，含 `bodyHtml`） | `GET /mail/view/{Code}`（**HTML**，正文在 iframe 模板串里） |
| 原文 | `GET /messages/{id}/source`（RFC822） | 未发现 |
| 删除 | `DELETE /messages/{id}` | `POST /mail/delete/{Code}`（单封）+ `/destroy`（清空，需人机验证） |
| 域名列表 | 需账户 JWT（匿名 401） | 公开 `GET /get-domains` |
| 自定义前缀 | 不支持（Body 被忽略） | 支持（`/change-domain`、Gmail 别名） |
| 风控 | Cloudflare TLS 指纹 + 10 次配额 | Cloudflare + IP 限流 + 4 位图形码 + UA/IP 绑定 |

---

## 11. 复核清单

1. 为什么说"没有建箱接口"？→ 首页 HTML 直接内联 `activeMail`/`activeMailCode`，抓包中不存在任何 `create` 类请求。
2. `code` 能自己算吗？→ 不能，64 位十六进制由服务端签发，与 Cookie/令牌绑定，改了会 `{"code":403,"error":"无效的请求"}`。
3. 收信是轮询吗？→ **不是**。`getMessages()` 只在首屏加载调用一次；"刷新"是 6 秒倒计时后整页 `location.reload()`。
4. 正文怎么拿？→ 详情页 HTML 里 `const emailContent = \`...\``，前端再写进 `iframe#email-iframe` 的 srcdoc。
5. 为什么脚本会突然全部变成"安全验证"？→ 触发 IP 频率限制，属站点反滥用，不应绕过。
6. 能不能删单封邮件？→ 能。`POST /mail/delete/{Code}` → `{"message":"email_deleted","success":true}`，删后再查列表为 `null`（实测）。另有 `/destroy` 清空全部记录，需人机验证。

---

## 12. 已知未覆盖的点（写报告时建议原样保留）

这份文档覆盖了"建箱 → 拉列表 → 读正文 → 换域名 → 删单封"的完整链路，但下面这些**没有做完**，不要当成已验证：

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 附件下载 | ❌ 未验证 | 站点 FAQ 明确说"有附件的邮件可以在详情页下载"，但**列表 JSON 里没有附件字段**，且本次没有收到带附件的邮件，下载 URL 未知 |
| `/destroy` 成功路径 | ⚠️ 被拦截 | 只看到 `安全验证` 页 |
| Gmail 别名详情页 | ❌ 未测 | `/mail/view/{Code}/gmail` 后缀没有验证 |
| 会员 API | ❌ 未覆盖 | `/member/api-docs` 提供生成邮箱、读信、删信 V2，但需要会员密钥 |
| 历史邮箱 / 自定义前缀 | ❌ 未覆盖 | `/history`、`/change` 页面未分析 |
| 频率限制的具体阈值 | ⚠️ 只知现象 | 实测：约 10 次触发；通过验证码后 3~4 次再次触发。具体算法未知 |

> 本轮已补齐两项：`POST /mail/delete/{Code}` 的真实响应（`email_deleted`）、以及 `Status` 由 0→1 的已读时机。
> 下一步最值得补的是附件下载 —— 需要一封带附件的邮件。
