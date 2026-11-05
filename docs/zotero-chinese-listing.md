# 投稿 Zotero 中文社区插件商店

- 投稿仓库：[zotero-chinese/zotero-plugins](https://github.com/zotero-chinese/zotero-plugins)
- 方式：新建 Issue（也可提 PR 改 `src/plugins.ts`，条目按仓库名排序）
- 状态：待提交

## 前置条件（仓库侧）

| 项目 | 状态 |
|---|---|
| 公开 GitHub 仓库 | ✅ https://github.com/Rsuiyi/Zotero_PaperLoom |
| 正式 release + XPI 附件 | ✅ `2.3tag` → `paperloom.xpi`（108,707 字节） |
| 开源许可 | ✅ MIT（`LICENSE`） |
| 更新源 `updates.json` | ✅ 已补（此前 `update_url` 指向的地址 404） |

`updates.json` 必须推到 `main`，manifest 里的 `update_url` 才会生效；以后每次发版都要在里面追加一条版本记录。

## Issue 标题

```
新插件收录：PaperLoom（文脉）——会记住你的阅读偏好、并跨论文连成知识图谱的 Zotero 助手
```

## Issue 正文

```markdown
## 新插件收录申请：PaperLoom（文脉）

- 仓库：https://github.com/Rsuiyi/Zotero_PaperLoom
- 正式发布：https://github.com/Rsuiyi/Zotero_PaperLoom/releases/tag/2.3tag
- XPI 下载：https://github.com/Rsuiyi/Zotero_PaperLoom/releases/download/2.3tag/paperloom.xpi
- 开源许可：MIT
- 插件 ID：`paperloom@hackathon.local`

### 功能简介

现有 Zotero AI 插件大多是「把当前论文塞进 prompt，问一句答一句」：无状态、单文档、不主动。PaperLoom 把三件事做成一个闭环——对话自动抽取记忆与跨论文知识图谱，下一轮再把它们注回上下文。

- **右侧常驻对话面板**：挂在主窗口右侧，随选中条目自动切换；另有工具栏按钮与阅读器工具栏按钮。
- **记忆**：从对话里抽取阅读偏好（例如「这篇我没读过，讲简单点」），后续回答真正生效；记忆可手动增删改，卡片上标注是模型抽取还是用户锁定。
- **跨论文知识图谱**：节点是概念/论断，边是关系，每条边可点回原文页码；支持点选、Ctrl/Shift 累加选择、空白处框选、右键拖动平移、Delete 删除（带确认）。含主题分层着色。
- **引用与定位**：回答附原文摘录与页码，点击后在 PDF 里高亮对应句子并居中滚动。
- **多模态**：可选把论文前 N 页渲染成截图随文本发送，让模型直接读公式与图表；模型不支持图像输入时自动退回纯文本。
- **模型管理**：像 PDF2zh 那样新增服务商、从该接口真实拉取 `GET /models` 列表、分别指定对话模型与图谱抽取模型；面板显示 token 用量与缓存命中。
- 设置页可内嵌在 Zotero 偏好里，也能独立窗口打开；字号、推理强度、上下文预算均可调。

数据全部本地存储，仅把选中的上下文发往用户自己配置的 LLM 接口。

### 版本及收录信息

当前最新稳定版为 **2.3.0**。XPI manifest 声明 Zotero 版本范围为 `7.0` 至 `10.99.99`；这是安装约束，并非声称已对上述每个版本逐一实机验证——开发与回归主要在 Zotero 10 上完成，代码内用能力探测（`content/scripts/compat.js`）而非版本号分支来适配 7/8/9/10，缺失 API 时自动降级。

建议中文简介：记住阅读偏好、并把多篇论文连成知识图谱的 Zotero 对话助手。

建议检索词：Zotero AI、对话、记忆、知识图谱、阅读助手、多模态、引用定位、LLM、chat、memory、knowledge graph。

XPI SHA256：`067e669d35f3976a3ddad1b19a15bf56c7a911b49f34aaa1e51101c019ea8acd`

希望将此插件纳入目录，感谢维护！
```

## 可选：PR 方式

在 `src/plugins.ts` 里按仓库名排序加入：

```ts
const plugin = {
  repo: 'Rsuiyi/Zotero_PaperLoom',
  releases: [],
  tags: ['ai', 'chat', 'reader'],
  discoverReleases: true,
  nameZh: '文脉',
  summaryZh: '记住阅读偏好、并把多篇论文连成知识图谱的 Zotero 对话助手',
  keywords: ['Zotero AI', '知识图谱', '记忆', '多模态', '引用定位'],
}
```

`discoverReleases: true` 让采集器自动取最新正式版；`releases` 暂留空，将来要兼容更老的 Zotero 版本再补历史 tag 与附件名。
