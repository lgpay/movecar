# movecar · 车主挪车通知系统

基于 Cloudflare Workers 实现的「挪车提醒」服务：访客打开 H5 页面，点击按钮即通过**企业微信**给车主推送挪车通知。

- `movecar.js` — Worker 主逻辑（挪车提醒 H5 页面 + `/notify-owner`、`/send-message` API + 企业微信消息推送）
- `wrangler.toml` — 部署配置（变量绑定 + compatibility_date）

## 环境变量

`wrangler.toml` 中**不内置任何变量值**，部署前需自行配置全部变量。

| 变量名 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `CORP_ID` | 明文 | ✅ | 无 | 企业微信 CorpId（我的企业 → 企业信息） |
| `CORP_SECRET` | **密钥** | ✅ | 无 | 企业微信应用 Secret（应用管理 → 对应应用）。**须手动添加，禁止写入仓库** |
| `AGENT_ID` | 明文 | ✅ | 无 | 企业微信应用 AgentId |
| `USER` | 明文 | ✅ | 无 | 接收通知的企业微信账号（touser，多个用 `\|` 分隔） |
| `PHONE_NUMBER` | 明文 | 否 | 无 | 车主手机号，用于 H5「拨打电话」按钮；留空则不显示该按钮 |
| `BASE_URL` | 明文 | 否 | `https://qyapi.weixin.qq.com` | 企业微信 API 地址；一般无需修改 |

### 配置方式

**明文变量**（`CORP_ID` / `AGENT_ID` / `USER` / `PHONE_NUMBER` / `BASE_URL`）：
打开 `wrangler.toml`，取消 `[vars]` 注释并填入你自己的值，例如：

```toml
[vars]
AGENT_ID = "你的企业微信应用 AgentId"
BASE_URL = "https://qyapi.weixin.qq.com"   # 一般无需修改
CORP_ID = "你的企业微信 CorpId"
PHONE_NUMBER = "车主手机号(可选)"
USER = "接收通知的企业微信账号"
```

**密钥 `CORP_SECRET`（必做）**：

```bash
# 方式一：命令行（推荐）
wrangler secret put CORP_SECRET
# 按提示粘贴企业微信应用 Secret

# 方式二：Cloudflare Dashboard
# Worker → movecar → Settings → Variables and Secrets → Add secret
# 名称填 CORP_SECRET，值填真实 Secret
```

> ⚠️ **安全提示**：`CORP_SECRET` 是敏感密钥，仓库（含 `wrangler.toml`）中**不得**出现其真实值。

## 部署

### 本地部署
```bash
wrangler deploy
```

### 自动部署（Workers Builds）
1. 在 Dashboard → Worker → **Settings → Build** → Connect Git repository，绑定本仓库。
2. 构建命令设为 `wrangler deploy`（单文件无构建步骤）。
3. 之后 `git push` 到主分支即自动部署。
4. **注意**：连上 Git 后，`wrangler.toml` 成为配置唯一权威来源，Dashboard 中的变量编辑将变为只读，改配置请改 toml 后 push。

## 接口

| 路径 | 方法 | 作用 |
| --- | --- | --- |
| `/` | GET | 返回挪车提醒 H5 页面 |
| `/notify-owner` | POST | 一键通知车主挪车（默认话术） |
| `/send-message` | POST | 发送自定义消息（body: `{ "message": "...", "deviceInfo": {} }`） |
| `/health` | GET | 健康检查，校验必填变量是否齐全 |
