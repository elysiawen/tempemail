# MailHub · 临时邮箱聚合台

把 **temp-mail.org**、**temp-mail.io**、**linshiyouxiang.net** 三家临时邮箱聚合到同一个界面，可自由选择平台创建邮箱、收信、读信、换域名，像使用原站一样操作。

后端基于 FastAPI + curl_cffi（模拟 Chrome TLS 指纹以通过 Cloudflare），前端为原生 HTML/CSS/JS，无需构建，数据用 SQLite 持久化。

## 功能

- 三个平台随时切换，统一邮箱地址、邮件列表与阅读界面
- 建箱、复制地址、自动轮询收信、邮件详情、删除单封邮件
- temp-mail.io：自定义前缀、指定域名、删除整箱
- linshiyouxiang.net：公开域名列表、一键换域名
- temp-mail.org / temp-mail.io：导出 EML、附件下载
- 多邮箱历史记录，刷新或重启后自动恢复会话
- 邮件正文在沙箱 iframe 中渲染，脚本、表单、事件属性均被移除
- 深色三栏桌面布局 + 手机端抽屉与全屏阅读

## 运行

需要 Python 3.10+。

```bash
pip install -r requirements.txt
python -m uvicorn server.main:app --host 127.0.0.1 --port 8000
```

或直接双击 `start.bat`（首次会自动安装依赖），然后打开 <http://127.0.0.1:8000>。

接口文档：<http://127.0.0.1:8000/api/docs>

## 平台差异

| 平台 | 自定义前缀 | 指定/切换域名 | EML | 附件 | 删除整箱 | 自动刷新 |
| --- | --- | --- | --- | --- | --- | --- |
| temp-mail.org | - | - | 支持 | 支持 | - | 6s |
| temp-mail.io | 支持 | 支持 | 支持 | 支持 | 支持 | 9s |
| linshiyouxiang.net | - | 支持 | - | - | - | 默认关闭 |

linshiyouxiang.net 限流较严（连续约 10 次请求会触发图形验证码），因此默认关闭自动刷新；触发限流时界面会明确提示。

## 目录结构

```
server/                 后端
  main.py               FastAPI 入口与 REST API
  database.py           SQLite 会话与历史持久化
  sessions.py           邮箱运行时与 Cookie 管理
  providers/            三个平台的适配器
web/                    前端（index.html / styles.css / app.js）
data/                   运行时数据库（已忽略）
start.bat               Windows 一键启动
```

## 说明

- 邮箱会话保存在 `data/mailhub.db`，该目录不会提交到仓库。
- 部分平台接口（如附件下载）依赖真实邮件验证，遇到平台改版时可能需要同步调整解析逻辑。
- 本项目仅用于学习与接口研究，请遵守各平台的服务条款。
