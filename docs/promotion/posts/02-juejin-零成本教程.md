# 掘金教程（选题 1）

> 标题：零成本 AI 网页翻译：用免费大模型 API 搭建自己的翻译插件
> 标签：翻译 / Chrome插件 / DeepSeek / 前端 / 效率工具
> 发布说明：两张演示 GIF 在掘金编辑器直接粘贴/上传即可，此处保留 raw 链接作底稿；「（此处配 XXX 截图）」占位发布时替换。
> 发布前置：先合并 cat→main 并 push（否则文中 raw 链接 404）；建议顺手 `npm run zip` 把产物传到 Releases，下方下载句即成立。

## 正文

看英文文档、刷论文的时候，最想要的就是双语对照：原文在上、译文在下，对照着读。但主流方案要么按月订阅，要么免费额度翻几页就见底。其实大模型厂商为了拉新，早就放出了免费或极低价、按 token 计费的 API。这篇文章教你把一个开源翻译插件和免费模型 API 拼起来，搭一套零成本的网页翻译方案，十分钟左右跑通。

### 先看效果

![整页双语对照翻译演示](https://raw.githubusercontent.com/shen1997-hub/llm-translate-minimal/main/docs/assets/demo-translate.gif)

整页翻译后，译文自动插入原段落下方形成双语对照；插件会智能识别正文区域，导航栏和侧边栏不翻。

### 第一步：安装插件

插件是开源项目「极简翻译」（llm-translate-minimal），暂未上架商店（在排期），从源码构建只要三条命令。前提是本机装有 Node.js（nodejs.org 下载 LTS 版即可，npm 随 Node 一起装好），然后克隆仓库、安装依赖、构建：

```bash
git clone https://github.com/shen1997-hub/llm-translate-minimal.git
cd llm-translate-minimal
npm install && npm run build
```

构建产物在 `.output/chrome-mv3` 目录，然后：

1. 浏览器地址栏打开 `chrome://extensions`
2. 打开右上角「开发者模式」开关
3. 点击「加载已解压的扩展程序」，选择 `.output/chrome-mv3` 目录

（此处配 chrome://extensions 加载扩展截图）

> 不想本地构建的话，如果 Releases 页面已提供打包好的 zip，也可以下载解压后同样走「加载已解压的扩展程序」；没有就按上面三条命令自己构建。

### 第二步：申请一个免费的模型 API

以硅基流动（SiliconFlow）为例，平台上有一批标注「免费」的开源模型，注册即可调用：

1. 打开硅基流动官网（cloud.siliconflow.cn）注册账号并登录
2. 进入控制台 →「API 密钥」→「新建 API 密钥」，复制保存好
3. 在「模型广场」里挑一个标注免费的模型，例如 Qwen 系列的 7B 档位，记下它的完整模型名（下一步配置要填）

> 注意：免费模型名单随平台调整，具体有哪些、限不限速，以硅基流动官网模型广场的当前信息为准。

免费档应对日常文档阅读基本够用。如果想要更强的翻译质量，还有几个低成本备选：

- **DeepSeek**：极低价付费 API，翻一整页长文的成本在几分钱量级，充少量余额即可用很久
- **智谱 GLM**：常有免费额度和低价档位
- **Ollama**：在自己电脑上跑开源模型，完全免费、完全离线，本系列下一篇详细写

### 第三步：配置插件

点击扩展详情页的「扩展程序选项」（或右键工具栏图标 →「选项」），打开设置页，添加一个供应商：

| 字段 | 填写内容 |
| --- | --- |
| 名称 | 硅基流动（自己认得就行） |
| Base URL | `https://api.siliconflow.cn/v1` |
| API Key | 第二步拿到的密钥 |
| 模型 | 你选的免费模型名，例如 `Qwen/Qwen2.5-7B-Instruct` |

（此处配 options 设置页添加供应商截图）

保存后，点工具栏上的扩展图标打开 popup，选中刚配的供应商和模型，目标语言选「简体中文」。

（此处配 popup 选择供应商与模型截图）

插件支持任意 OpenAI 兼容 API，所以之后想换 DeepSeek，只要新增一个供应商：Base URL 填 `https://api.deepseek.com`、模型填 `deepseek-chat`，其余照填。配置支持保存多个供应商，换模型只是 popup 里下拉切换的事。

### 第四步：开始翻译

打开任意英文页面，点扩展图标，再点「翻译本页」。发起请求前 popup 会先预估本次要翻译的段落数和 token 消耗，心里有数再确认。译文逐段出现在原文下方；SPA 页面（比如 X/Twitter）往下滚动时，新加载的内容会自动补翻；个别段落失败可以单独重试，不用整页重来。

日常更常用的是划词翻译：选中任意文本，旁边会出现一个小圆钮，点击弹出浮窗看译文，支持朗读、复制和固定浮窗。目标语言有简中、繁中、英、日、韩等 12 种；划词内容如果中文占比过半，会自动译成英文，不用手动切换方向。设置里还能把小圆钮换成一只猫——选中文字时它会跳到选区边上探出头。

![划词翻译与猫咪助手演示](https://raw.githubusercontent.com/shen1997-hub/llm-translate-minimal/main/docs/assets/demo-cat.gif)

### 为什么这套方案几乎不花钱

除了用免费模型，插件自身也做了三件事帮你省 token：

1. **本地缓存**：译文存在浏览器 IndexedDB 里，按「文本 + 模型 + 目标语言」分键。同一页面再看一遍，命中缓存的段落直接读取，不重复扣 token。
2. **翻译前预估**：popup 先算出段落数和 token 量级再发起请求，不会手滑把一篇长文整本发出去。
3. **并发限流 + 429 退避**：并发请求有上限，撞到供应商限流（HTTP 429）会自动退避重试，不会把免费额度瞬间打爆。

隐私方面也顺带说一句：API Key 只存在浏览器本地的 `chrome.storage.local`，请求只发给你配置的供应商域名，插件自己没有任何服务器。

### FAQ

**Q：支持哪些模型？**
任何提供 OpenAI 兼容 `/chat/completions` 接口的服务都行：DeepSeek、智谱 GLM、OpenAI、Moonshot、本地 Ollama 等，Claude 的接口协议也支持。支持 `response_format: json_object` 的模型体验最佳，不支持的会自动降级，不影响正常使用。

**Q：API Key 存哪？安全吗？**
只存在你自己浏览器的 `chrome.storage.local`，不上传任何服务器；网络请求只发向你配置的那个 Base URL。代码完全开源，每一行网络请求都可以在仓库里审查。

**Q：Firefox 能用吗？**
能。执行 `npx wxt build -b firefox` 构建 Firefox 版本，然后在 `about:debugging` 里加载临时扩展，需要 Firefox 127 及以上。

**Q：如果用付费模型，大概多少钱？**
数量级参考：一篇几千词的英文长文，输入加输出合计大约一两万 token，按 DeepSeek 刊例价折算在几分到一毛钱的量级；日常阅读量一天也就几毛钱。具体数字以 popup 的翻译前预估为准，它会按当前页面实际计算。

### 结尾

项目地址：**https://github.com/shen1997-hub/llm-translate-minimal**，MIT 协议，TypeScript + WXT（Manifest V3）开发。觉得有用欢迎点个 star，踩到坑欢迎提 issue，都会回。

下篇预告：如果连「注册平台拿 API Key」都嫌麻烦，下一篇写 **Ollama 完全离线方案**——在自己电脑上跑模型，不注册、不联网、零花费，配合这个插件照样双语对照。
