# movecar · 车主挪车通知系统

基于 Cloudflare Workers 的「挪车提醒」服务：访客打开 H5 页面，一键或发信息，即经**企业微信**把挪车通知推给车主。

## 功能特性

- 挪车提醒 H5 页面（一键通知 / 给车主发信息 / 拨打电话）
- 企业微信应用消息推送（access_token 内存缓存 + 10s 超时控制）
- 按 IP 频率限制（60s / 5 次），防止端点被刷
- 通知含**北京时间戳**、访客**设备信息**、**IP 归属地与运营商**
- 所有配置以 secret 形式注入，仓库不含任何密钥或真实值

## 项目结构

- `movecar.js` — Worker 主逻辑（页面 + 接口 + 企业微信推送）
- `wrangler.toml` — 部署配置（仅基础字段，不含变量值）
- `README.md` — 本文档

## 环境变量

全部为**密钥（secret）**，通过 `wrangler secret put` 或 Cloudflare 控制台设置，**不要写进仓库**（仓库为公开）。

| 变量 | 说明 | 必填 |
| --- | --- | --- |
| `CORP_ID` | 企业微信 CorpId | ✅ |
| `CORP_SECRET` | 企业微信应用 Secret | ✅ |
| `AGENT_ID` | 企业微信应用 AgentId | ✅ |
| `USER` | 接收通知的企业微信账号（touser） | ✅ |
| `PHONE_NUMBER` | 车主手机号，用于页面「拨打电话」（可空，留空则不显示该按钮） | ❌ |
| `BASE_URL` | 企业微信 API 地址，默认 `https://qyapi.weixin.qq.com` | ❌ |

设置方式（六个都需要）：

```bash
wrangler secret put CORP_ID
wrangler secret put CORP_SECRET
wrangler secret put AGENT_ID
wrangler secret put USER
wrangler secret put PHONE_NUMBER
wrangler secret put BASE_URL
```

## 部署

### 自动部署（推荐）
仓库已绑定 Cloudflare Workers Builds：**推送到 `master` 即自动部署**。

```bash
git push origin master
```

### 本地部署
```bash
wrangler deploy
```

## 接口

| 路径 | 方法 | 说明 | 错误码 |
| --- | --- | --- | --- |
| `/` | GET | 挪车提醒 H5 页面 | — |
| `/notify-owner` | POST | 一键通知车主（默认话术），body 可选 `{"deviceInfo":{}}` | 400 / 405 / 429 / 500 |
| `/send-message` | POST | 自定义信息，body `{"message":"...","deviceInfo":{}}`，限 500 字 | 400 / 405 / 429 / 500 |
| `/health` | GET | 健康检查（校验必填变量是否齐全） | 503 变量缺失 |

- 跨域预检 `OPTIONS` 返回 200。
- 非允许方法返回 **405**；请求体非 JSON 返回 **400**；触发限流返回 **429**；内部异常返回 **500**（均不向访客暴露内部细节）。

## 通知内容示例

一键通知：

```
🚗 挪车提醒：

您好，有人需要您挪车，请尽快处理，谢谢🙏

📅 时间：2026-08-14 15:26
📱 设备：iOS · Safari
🌐 IP：203.0.113.5
📍 归属地：中国 Guangdong Shenzhen
🏢 China Telecom
```

访客信息：

```
🚗 挪车提醒：

💬 访客信息：
师傅方便挪下车吗

📅 时间：2026-08-14 15:26
🌐 IP：203.0.113.5
```

## 说明

- **归属地 / 运营商** 来自 Cloudflare 边缘 `request.cf`，零额外请求；`request.cf` 不存在时（如本地开发）自动跳过。
- **频率限制** 为单 isolate 内存级，可挡常规刷量；要做跨 isolate 强限制需引入 KV 绑定。
- 所有环境变量均为 secret，仓库不含真实值。
