# CourseX 底层数据契约 v1

更新：2026-11-08。已实现 M0 基础层、B01 章节主画布、B02 知识卡片与课件选文、B03 问答保存/提炼、B04 证据引用、C01/C02/C04 结构化导出和 C03 同版本导入恢复。已新增 B05 跨章节引用、B06 查找与整理、B07 Keyed Diff 实验，以及 A05 稳定章节链接。导出协议与范围见 [export.md](export.md)，恢复边界见 [import.md](import.md)。

## 稳定课程与课节身份

课程和课节目录各持有 `.coursex-id.json`：`{ "schemaVersion": 1, "id": "…" }`。课程名称与课节标题继续取目录名称，但不再作为身份。`Course.id`、`Lesson.id` 及 `Lesson.courseId` 是后续关联依据。企划书 Chapter 对应现有 Lesson，不新增视频主课号层级。

首次扫描时课程生成 UUID；课节将原来的“课程名/课节名”哈希固化为 ID，因此既有 `chats`、`progress`、`lastLesson` 无需换键。完成首次登记后，课程库根目录移动、课程/课节改名以及课节移动均保留身份。首次登记之前发生过的改名无法自动推断原身份。

目录必须可写，文件系统需支持硬链接：身份文件先完整写入临时文件，再以硬链接发布，避免并发扫描读到半个 JSON 或覆盖另一扫描器的 ID。原目录和身份文件一起备份、移动；不要删除身份文件来处理普通改名。应用仍按单个服务进程拥有课程库和学习数据运行，不支持多进程同时修改状态文件。

发现重复课程/课节 ID 时扫描失败并提示冲突（HTTP 409），不悄悄合并两个目录；无效身份文件返回 422。若要把复制目录作为全新课程，请只在副本中移除课程及各课节的身份文件，再扫描生成新身份；副本不会继承原学习数据。故障中途遗留的 `.coursex-id.json.*.tmp` 不作为身份读取。

## 学习状态和兼容迁移

`.coursex-data/state.json` 增加 `schemaVersion: 1`，继续使用串行更新及临时文件原子替换。不更换数据库。

无版本字段的旧文件视为 v0。首次启动先以权限 600 保存原始字节到 `state.v0.backup.json`（不覆盖既有备份），然后补充新字段并写回 v1。旧画板、图形快照、图片、问答文本、未完成标记、播放进度、模型配置和最后课节均保留。未知版本拒绝加载，不能降级覆盖。

备份和状态文件均含模型密钥；它们是私有恢复数据，不是未来可公开分享的导出包。回退旧程序前停止服务，保留当前 v1 状态，再使用 v0 备份恢复；恢复到备份会舍弃升级后新增内容。

## 语义内容与画布布局分层

| 字段 | 内容 |
|---|---|
| `boards` | 原有画板 ID、名称、revision、tldraw document，以及可选 session（视口、当前页面、选中对象等） |
| `primaryBoards` | Lesson ID → 主画板 ID 的关系表，按需创建，重复请求返回同一主画布 |
| `cards` | 独立卡片 ID、课节、类型、标题、Markdown 正文、草稿/已验证、时间和证据引用 |
| `excerpts` | 主动保存的会话片段、来源课节、消息 ID 与选中正文快照 |
| `evidence` | 稳定证据 ID、来源类型、URI 和可选版本 |

以上语义集合以稳定 ID 为键，布局变化不修改卡片正文。后续自定义 shape 通过 `cardId` 等引用语义实体，不从任意普通文本图形反向解析知识。普通旧图形仍作为原生画板内容，不自动转换或附加课节归属。

章节主画布通过 GET/POST `/api/lessons/:id/board` 读取/按需创建。主画布返回独立 cards、evidence、excerpts 数组；PUT `/api/boards/:id` 将这些内容与 document、session 一起提交，在同一 revision 检查和 Store update 中写入。自定义 `knowledge-card` shape 只持有 cardId 与尺寸，正文由 React 上下文读取。

删除最后一个 shape 引用时删除该章节的对应卡片；本次页面会话内撤销删除可恢复正文。重复 shape 引用同一 cardId 时共享正文。原生跨章节粘贴正文卡片仍不支持；可创建 type=reference 的只读链接卡片，target 保存目标 lessonId/cardId；缺失正文引用、跨章覆盖、把知识卡片写入草稿画板会拒绝保存。验证失败和 revision 冲突均不提交任何修改。

卡片创建/修改时间由服务端管理；只移动形状时不更新语义内容的 updatedAt。前端提供笔记、问题、结论、来源和对话类型及待验证/已验证标记，状态由用户选择。切课/切画板等待当前画布和卡片保存完成，失败时保留当前编辑。

问答保存新增“对话”类型卡片。POST `/api/lessons/:id/conversation-draft` 生成不落盘的预览：用 answerId 定位原消息和问题，可选 selectedText 必须是原回答中非空的连续片段。原时间、消息 ID、未完成标记、模型名及课件摘要保存在 excerpt 中。mode=conversation 不依赖模型配置；mode=distill 通过当前 Pi 模型提炼正文，最多等待 60 秒，默认 draft。提炼不会追加课节聊天消息，不会自动标为 verified。

前端先完成当前画板保存，再生成预览；必要时创建/打开本课主画布，插入卡片和引用后一起提交。失败时不产生单独的已保存 excerpt。新 excerpt 在提交时重新核对原消息；既存 excerpt 是只读快照，不随卡片正文编辑改变。删除最后一个卡片引用会清理对应证据与摘录；本次页面撤销时可从本地保留的数据恢复。

证据拥有稳定 ID、sourceType、uri、可选 version，允许多个卡片引用。来源支持课程章节、网页、commit、文件路径和测试结果。HTTP/HTTPS 链接可点击，其他来源仅展示文本，不执行命令或打开任意本地文件。网页来源拒绝无效协议和含凭据的 URL。修改证据或关联会更新引用卡片的 updatedAt；只移动布局不会。不能覆盖其他章节的证据和摘录。

GET `/api/export/options` 返回范围内卡片/画板数量及已保存问答列表。POST `/api/export` 接收 courseId（可选）、mode、excerptIds、includeAssets，等待排队写入后克隆一次已提交状态，显式选取字段生成 ZIP，不能直接导出 state.json。固定序列化与压缩时间保证 Git 稳定性，只有 manifest 的导出时间随本次操作变化。

POST `/api/import/preview` 接收 application/zip，验证导出协议、索引、语义引用、tldraw 文档 schema/对象属性、视口与图片摘要，返回逐项新增/冲突/章节未匹配/空数据结果及预览 token，不写文件。POST `/api/import/confirm` 再次提交同一 ZIP 和 `X-CourseX-Import-Preview`；包或项目状态变化要求重新预览。只新增完整无冲突章节/独立草稿，确认事务内再次核对；图片以新文件名暂存、提交失败清理，绑定、正文、来源、进度与布局同一次 Store update 提交。保存的问答只恢复 excerpt 快照，不伪造完整聊天历史。

POST `/api/lessons/:id/handout-draft` 生成课件选文草稿，尚不落盘。新卡片提交时再次校验局部文字与课件摘要；handoutSource 记录原文与版本且不可随正文修改。选文与问答共用画布插入、版本检查和原子提交路径。

画板现在保存 document 和 session；纯平移、缩放、换页面和选中对象也触发防抖保存。旧画板没有 session 时正常加载。跨设备仍共享最后保存的视口，不提供多人实时协作。

## 问答消息身份

新消息由服务端生成 `id`、`lessonId`、ISO `createdAt`。回答的 `replyTo` 指向问题 ID，`context` 记录模型名和当时课件文本的 SHA-256 摘要。摘要用于辨识课件版本，不包含课件原文，也不代表可独立重建完整模型输入。

流式接口增加 `start` 事件，返回问题和回答的身份；前端使用服务端 ID 展示消息，最终持久化使用同一 ID。后续片段引用不再依赖数组下标。

旧消息迁移时只生成一次 ID，`createdAt` 为 null，缺失来源上下文不伪造。原有未完成回答仍保留。历史消息自身没有可靠的模型名与时间，无法追溯补齐。

## 验证

`npm test` 包括目录身份的并发创建、改名、移动、重启、重复/无效文件；v0 备份和迁移幂等、未知版本拒绝；知识正文与布局独立持久化；流式消息身份与最终记录一致；画板 session 保存和既有播放/问答回归。`npm run build` 检查前后端 TypeScript 和生产构建。

本轮自动验证不替代真实浏览器中的视口恢复、真实云模型和独立设备验收。

## 导航、引用和交互实验

GET `/api/cards?q=...` 按标题/正文搜索语义卡片，仅返回标题、课节、课程和可用性；GET `/api/navigation?courseId=...` 下载无内容/凭据的课程导航。前端路由使用 `lesson`、`card` 和 `view=board`，源/目标切换仍等待保存。详见 [navigation.md](navigation.md)。

reference 卡片正文为空，target 是稳定 ID 链接，不复制来源；服务端验证新引用目标，既存失效链接可保留。GET 画板时 targets 是派生的最新目标摘要，不作为持久化正文提交。导出和恢复包含 target，分享时排除目标未包含的引用。

experiment 卡片携带 `{kind:"keyed-diff", version:1, reactVersion:"18.2.0", before, after}`。前后端共享纯函数校验，保存失败不提交，正文时间只在输入/语义变化时更新。模型边界见 [keyed-diff.md](keyed-diff.md)。原 knowledge-card shape 继续只保存 cardId 和尺寸，没有新增 tldraw shape 类型；state schemaVersion 仍为 1，旧卡片不需要转换。
