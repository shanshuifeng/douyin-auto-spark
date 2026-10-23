<h1 align="center">🔥 Douyin Auto Spark</h1>

<p align="center">
  <strong>抖音聊天续火脚本 · Playwright 自动化 · Docker / 本地 / GitHub Actions</strong>
</p>

<div align="center">
  <img src="assets/readme/banner.png" alt="Douyin Auto Spark Logo">
</div>
<br>

<div align="center">
  <a href="https://github.com/shanshuifeng/douyin-auto-spark/stargazers"><img src="https://img.shields.io/github/stars/shanshuifeng/douyin-auto-spark?logo=github&color=yellow" alt="Stars"></a>
  <a href="https://github.com/shanshuifeng/douyin-auto-spark/actions/workflows/renew-fire.yml"><img src="https://img.shields.io/github/actions/workflow/status/shanshuifeng/douyin-auto-spark/renew-fire.yml?branch=main&label=%E7%BB%AD%E7%81%AB&logo=githubactions" alt="Spark Status"></a>
  <a href="https://github.com/shanshuifeng/douyin-auto-spark/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-orange" alt="License"></a>
</div>
<br>

> [!IMPORTANT]
> **本仓库是 [bling-yshs/douyin-auto-spark](https://github.com/bling-yshs/douyin-auto-spark) 的 fork**，在上游基础上补充了群聊续火、自定义句子池、发送防错校验等能力。
>
> 上游仓库已标注「**已被风控失效**」，其 README 对三种运行方式的成功率评估如下：
>
> | 运行方式 | 需要自己的设备 | 成功率 | 说明 |
> |:---|:---:|:---:|:---|
> | GitHub Actions | 否 | **低** | 抖音风控严重，基本不可用 |
> | Docker | 是 | 高 | 推荐使用此方式 |
> | 本地运行 | 是 | 高 | 无法使用 Docker 时的备选 |
>
> 另有用户反馈：每跑一次 GitHub Actions，Cookie 就会失效，连浏览器里的抖音登录态也要重新登录。
> **请优先选择 Docker 或本地运行。**

## ✨ 项目简介

本项目是一个基于 **Playwright + TypeScript** 的抖音自动续火脚本。它会携带你配置的抖音 Cookie 打开聊天页，按配置的会话名称依次定位聊天对象（好友或群聊），并从 `assets/yiyan.json` 或自定义句子池中挑选内容发送出去。

支持 **Docker**、**本地运行**、**GitHub Actions** 三种方式。

## 🚀 功能特性

- 🎭 **Cookie 登录** - 通过 `DOUYIN_COOKIE` 注入抖音登录态，无需在脚本中输入账号密码
- 🎯 **多会话发送** - 通过 `DOUYIN_TARGET_NAMES` 配置多个好友
- 👥 **多账号续火** - 支持同时为多个账号配置续火
- 💬 **随机一言** - 每次从 `assets/yiyan.json` 随机挑选一条 `hitokoto`，默认以 `——「出处」` 的格式附上来源
- 🗂️ **群聊续火** - 通过 `DOUYIN_TARGET_GROUPS` 按群名续火，与好友配置并行
- 🎲 **自定义句子池** - 通过 `SPARK_MESSAGES` 配置随机句子池，每次随机挑一条，比单一模板更像真人
- 🛡️ **发送防错校验** - 发送前校验会话标题与目标一致，避免发错人；发送后校验输入框已清空，识别「假成功」
- 🤖 **定时续火** - Docker / 本地可用系统计划任务，GitHub Actions 每天自动运行（注意上方风控提示）

## 🧰 准备工作

在配置任何运行方式之前，都需要先准备抖音 Cookie 和要发送消息的会话名称。

### 1️⃣ 获取抖音 Cookie

1. 使用 Chrome/Edge 打开 [Cookie-Editor 插件页面](https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm)，安装 Cookie-Editor。 [（Edge点我）](https://microsoftedge.microsoft.com/addons/detail/cookieeditor/neaplmfkghagebokkhpjpoebhdledlfi)

2. 打开 [抖音聊天页](https://www.douyin.com/chat)，并登录你的抖音账号。

3. 登录成功后，点击浏览器右上角的 Cookie-Editor 插件图标。

4. 点击 `Export`，选择 `JSON`，复制导出的完整数组内容。

   ![cookie](assets/readme/cookie.png)

导出的内容大概长这样：

```json
[
  {
    "domain": ".douyin.com",
    "expirationDate": 1800175766.87008,
    "hostOnly": false,
    "httpOnly": false,
    "name": "UIFID",
    "path": "/",
    "sameSite": "no_restriction",
    "secure": true,
    "session": false,
    "storeId": null,
    "value": "xxx"
  }
]
```

后面配置 `DOUYIN_COOKIE` 时，需要把整个 JSON 数组填进去。

### 2️⃣ 确认会话名称

- **好友**：填写抖音里的**备注名**最稳，好友改昵称也不影响续火
- **群聊**：群名要与抖音内显示的名称**完全一致**，标点、空格、表情都要一致

## 🐳 Docker 运行（推荐）

Docker 是上游评估成功率最高的方式，也是本仓库的推荐方式。

### 1️⃣ 构建镜像

```bash
docker build -t douyin-auto-spark .
```

镜像基于 `mcr.microsoft.com/playwright:v1.61.0-jammy`，已内置浏览器，无需额外安装。

### 2️⃣ 准备环境变量文件

复制 `.env.example` 为 `.env`，填入真实配置：

```bash
cp .env.example .env
```

### 3️⃣ 运行

```bash
docker run --rm --env-file .env douyin-auto-spark
```

无头模式与自动关闭建议保持默认 `true`：

```dotenv
PLAYWRIGHT_HEADLESS=true
AUTO_CLOSE=true
```

### 4️⃣ 定时执行

用宿主机计划任务调用上面的 `docker run` 即可。Linux 下可用 cron：

```cron
0 9 * * * cd /path/to/douyin-auto-spark && docker run --rm --env-file .env douyin-auto-spark
```

> 仓库内置的 `.cnb.yml` 用于 CNB 平台自动构建并推送镜像，可按需使用。

## 💻 本地运行

### 1️⃣ 安装依赖

本地调试需要 Node.js 20+ 和 pnpm 11：

```bash
pnpm install
```

### 2️⃣ 配置环境变量

```bash
cp .env.example .env
```

核心配置如下：

| 变量 | 必填 | 默认值 | 说明 |
|:---|:---:|:---:|:---|
| `DOUYIN_COOKIE` | ✅ | - | Cookie-Editor 导出的完整 Cookie JSON 数组 |
| `DOUYIN_TARGET_NAMES` | ❌ | - | 要发送消息的好友名称 JSON 数组 |
| `DOUYIN_TARGET_GROUPS` | ❌ | - | 要发送消息的群名称 JSON 数组 |
| `YIYAN_INCLUDE_SOURCE` | ❌ | `true` | 是否携带一言出处，设置为 `false` 时只发送一言正文 |
| `SPARK_MESSAGE_TEMPLATE` | ❌ | - | 自定义火花消息模板，见「✉️ 自定义消息模板」 |
| `SPARK_MESSAGES` | ❌ | - | 自定义随机句子池，见「🎲 自定义随机句子池」 |
| `PLAYWRIGHT_BROWSER_PATH` | ❌ | - | 本机 Chrome / Chromium / Edge 可执行文件路径，不填则使用 Playwright 默认浏览器 |
| `PLAYWRIGHT_HEADLESS` | ❌ | `true` | 是否使用无头模式 |
| `AUTO_CLOSE` | ❌ | `true` | 发送完成后是否自动关闭浏览器 |

> ⚠️ `DOUYIN_TARGET_NAMES` 和 `DOUYIN_TARGET_GROUPS` 至少配置一个，否则启动即报错。

### 3️⃣ 启动项目

```bash
pnpm dev
```

脚本会打开 `https://www.douyin.com/chat`，依次定位配置中的好友/群聊并发送内容。

## ⚙️ GitHub Actions 运行

> ⚠️ **再次提醒**：上游明确标注 GitHub Actions 方式「抖音风控严重，基本不可用」，且会导致 Cookie 失效。仅在你没有其他设备可用时尝试。

### 1️⃣ Fork 项目

点击 GitHub 页面右上角的 `Fork`，把本项目复制到你自己的账号下。

![fork](assets/readme/fork.jpg)

Fork 后进入你自己的仓库，例如：

```text
https://github.com/你的用户名/douyin-auto-spark
```

### 2️⃣ 配置 Secrets

进入你 Fork 后的仓库：

```text
Settings -> Secrets and variables -> Actions -> New repository secret
```

![add-secret](assets/readme/add-secret.jpg)

添加以下 Secrets：

| Secret | 必填 | 说明 |
|:---|:---:|:---|
| `DOUYIN_COOKIE` | ✅ | Cookie-Editor 导出的完整 Cookie JSON 数组 |
| `DOUYIN_TARGET_NAMES` | ❌ | 需要续火的好友名称 JSON 数组，例如 `["暮邵落白"]`，建议填写抖音备注名 |
| `DOUYIN_TARGET_GROUPS` | ❌ | 需要续火的群名称 JSON 数组，例如 `["群名称A"]` |
| `YIYAN_INCLUDE_SOURCE` | ❌ | 是否携带一言出处，默认开启；设置为 `false` 时只发送一言正文 |
| `SPARK_MESSAGE_TEMPLATE` | ❌ | 自定义火花消息模板，见下方「✉️ 自定义消息模板」 |
| `SPARK_MESSAGES` | ❌ | 自定义随机句子池，见下方「🎲 自定义随机句子池」 |

### 3️⃣ 手动运行一次

```text
Actions -> 点击绿色的 I understand my workflows, go ahead and enable them -> 🚀 续一次火 -> Enable workflow -> Run workflow
```

![run-workflow](assets/readme/run-workflow.jpg)

### 4️⃣ 自动运行

默认每天北京时间 `0 点 / 2 点 / 4 点` 各触发一次，并内置「当天已有成功运行则跳过」的判断，因此实际最多只会在成功前重试。由于 GitHub 定时任务会排队，实际执行时间可能延迟。

## 📮 邮件通知配置

邮件通知是可选功能。配置 `MAIL_ADDRESS`、`MAIL_USERNAME` 和 `MAIL_PASSWORD` 后，续火失败会发送提醒邮件并附带失败截图；如果定时任务前一次失败、后续补充执行成功，也会发送补充执行成功邮件。

> 注意：邮件通知由 GitHub Actions 工作流实现，Docker 与本地运行不会发送邮件。

| Secret | 启用邮件时必填 | 说明 |
|:---|:---:|:---|
| `MAIL_ADDRESS` | ✅ | SMTP 发件邮箱地址 |
| `MAIL_USERNAME` | ✅ | SMTP 登录账号，通常与 `MAIL_ADDRESS` 相同 |
| `MAIL_PASSWORD` | ✅ | SMTP 授权码或密码；QQ 邮箱请填写授权码 |
| `MAIL_TO` | ❌ | 收件邮箱，不配置时使用 `MAIL_ADDRESS` |
| `MAIL_HOST` | ❌ | SMTP 服务器地址，默认 `smtp.qq.com` |
| `MAIL_PORT` | ❌ | SMTP 服务器端口，默认 `465` |
| `MAIL_SECURE` | ❌ | 是否使用 SSL，默认 `true` |

如果不需要邮件提醒，不配置这些 Secret 即可。

## 👥 多账号配置

如果你只有一个账号需要续火，那么不需要关注本节。

需要为多个抖音账号续火时，可以配置 `DOUYIN_ACCOUNTS_1`、`DOUYIN_ACCOUNTS_2` … `DOUYIN_ACCOUNTS_10`（编号分片），也可以使用历史变量 `DOUYIN_ACCOUNTS`。GitHub Actions 把它们配置为 Secrets，本地和 Docker 配置为环境变量。

例如先添加 `DOUYIN_ACCOUNTS_1`：

```json
[
  {
    "name": "账号1",
    "cookie": [
      {
        "domain": ".douyin.com",
        "expirationDate": 1800175766.87008,
        "hostOnly": false,
        "httpOnly": false,
        "name": "UIFID",
        "path": "/",
        "sameSite": "no_restriction",
        "secure": true,
        "session": false,
        "storeId": null,
        "value": "xxx"
      }
    ],
    "targetNames": ["好友A", "好友B"],
    "groupNames": ["群名称A"]
  },
  {
    "name": "账号2",
    "cookie": [
      {
        "domain": ".douyin.com",
        "expirationDate": 1800175766.87008,
        "hostOnly": false,
        "httpOnly": false,
        "name": "UIFID",
        "path": "/",
        "sameSite": "no_restriction",
        "secure": true,
        "session": false,
        "storeId": null,
        "value": "xxx"
      }
    ],
    "targetNames": ["好友C"],
    "messages": ["{{friend}}，早安。", "{{friend}}，今天也要开心。"],
    "messageTemplate": "{{friend}}，{{account}} 今天来续火啦\n{{date}} {{weekday}}"
  }
]
```

如果后续账号太多（GitHub 大概一个 Secret 只能写两三万字，Cookie 太长很容易存不进去），就把账号分片：

```text
DOUYIN_ACCOUNTS_1   第一批账号
DOUYIN_ACCOUNTS_2   第二批账号
DOUYIN_ACCOUNTS_3   第三批账号
```

每个账号对象支持的字段：

| 字段 | 必填 | 说明 |
|:---|:---:|:---|
| `name` | ✅ | 当前账号的标识符，账号名称不能重复 |
| `cookie` | ✅ | Cookie-Editor 为这个账号导出的完整 JSON 数组 |
| `targetNames` | ❌ | 这个账号需要发送消息的好友名称数组，建议使用抖音备注名 |
| `groupNames` | ❌ | 这个账号需要发送消息的群名称数组 |
| `messages` | ❌ | 该账号专属随机句子池，优先级高于全局 `SPARK_MESSAGES` |
| `messageTemplate` | ❌ | 消息模板，未配置时继承全局模板 |

> `targetNames` 与 `groupNames` 至少配置一个。
>
> ⚠️ 如果配置了多账号，则会忽略单账号配置。

## ✉️ 自定义消息模板

配置 `SPARK_MESSAGE_TEMPLATE` 可定义所有账号共用的默认消息内容；账号对象中的 `messageTemplate` 可以覆盖它：

```dotenv
SPARK_MESSAGE_TEMPLATE={{friend}}，今天的火花到账啦🔥\n{{yiyan}}\n——「{{from}}」\n{{date}} {{weekday}}
```

支持的占位符：

| 占位符 | 说明 |
|:---|:---|
| `{{account}}` | 当前账号的配置名称 |
| `{{friend}}` | 好友名 / 群名 |
| `{{yiyan}}` | 一言正文 |
| `{{from}}` | 一言出处 |
| `{{date}}` | 日期 `yyyy-MM-dd` |
| `{{time}}` | 时间 `HH:mm` |
| `{{weekday}}` | 星期几 |

## 🎲 自定义随机句子池

配置 `SPARK_MESSAGES`（全局）或账号对象中的 `messages`（账号级），每次发送随机挑一条，比单一模板更像真人说话：

```dotenv
SPARK_MESSAGES='["{{friend}}，早安。晨光熹微，愿君今日心澄如镜。","早安。山高水长，来日可期。"]'
```

- 元素支持字面 `\n` 表示换行
- 与模板共用同一套占位符，未知占位符启动即报错
- 必须是字符串数组，元素非空；空数组视为未配置并回退

**消息来源优先级**：账号级句子池 > 全局句子池 > 账号模板 > 全局模板 > 默认随机一言

## 🔨 开发命令

```bash
# 启动脚本
pnpm dev

# 全量检查（类型 + lint + 格式）
pnpm check

# 单独执行 TypeScript 类型检查
pnpm type-check

# 代码检查
pnpm lint:check

# 格式检查
pnpm format:check

# 自动修复 lint 与格式化
pnpm fix
```

## 📂 项目结构

```text
douyin-auto-spark/
├── .github/workflows/
│   └── renew-fire.yml          # 🚀 GitHub Actions 定时续火任务
├── .husky/                     # 🐶 Git 提交钩子
├── assets/
│   ├── readme/                 # 🖼️ README 资源
│   └── yiyan.json              # 📚 随机消息数据源
├── src/
│   ├── main.ts                 # 🎭 Playwright 自动化入口
│   └── types/
│       ├── douyin-cookie.ts    # 🍪 抖音 Cookie 类型
│       └── yiyan.ts            # 💬 一言数据类型
├── .cnb.yml                    # 📦 CNB Docker 镜像构建配置
├── .dockerignore               # 🐳 Docker 构建忽略规则
├── .env.example                # ⚙️ 环境变量示例
├── .gitignore                  # 🙈 Git 忽略规则
├── .node-version               # 🟢 Node.js 版本声明
├── .oxfmtrc.jsonc              # 🎨 oxfmt 配置
├── .oxlintrc.jsonc             # 🔍 oxlint 配置
├── Dockerfile                  # 🐳 Docker 镜像构建文件
├── LICENSE                     # 📄 GPL v3.0 许可证
├── pnpm-lock.yaml              # 🔒 pnpm 依赖锁文件
├── pnpm-workspace.yaml         # 📦 pnpm 工作区配置
├── tsconfig.json               # 🧩 TypeScript 配置
└── package.json                # 📦 项目依赖与脚本
```

## 🛠️ 本地环境

|  环境   | 版本要求 |
|:-------:|:--------:|
| Node.js |   20+    |
|  pnpm   |    11    |

## 🔗 主要依赖

| 依赖 | 用途 |
|:---|:---|
| `playwright` | 自动打开浏览器、注入 Cookie、定位会话并发送消息 |
| `dotenv` | 读取本地 `.env` 配置 |
| `dayjs` | 模板占位符中的日期与时间处理 |
| `tsx` | 本地通过 `pnpm dev` 运行 TypeScript 脚本 |
| `typescript` | 执行 `pnpm type-check` 类型检查 |
| `oxlint` / `oxfmt` | 代码检查与格式化 |

## ⚠️ 免责声明

- 本项目仅供学习与个人自动化实践，请遵守抖音平台规则，风险自负
- 自动化操作可能导致账号被风控或 Cookie 失效，请勿用于商业用途
- 本仓库为 fork，上游项目版权归原作者 [bling-yshs](https://github.com/bling-yshs) 所有

## 📄 许可证

本项目采用 [GPL v3.0](LICENSE) 开源许可证。
