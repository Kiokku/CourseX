# CourseX 本地课程学习平台

已实现本地课程目录、视频与课件同时显示、Pi Agent 流式问答、章节主画布、独立草稿画板、知识卡片、课件选文、问答保存与提炼、证据引用、本地持久化、结构化 ZIP 导出与同版本导入恢复。另提供稳定章节链接、跨章节卡片引用、知识查找整理和 React 18 Keyed Diff 实验。

```bash
npm install
cp .env.example .env  # 已有 .env 时直接修改其中的 COURSEX_LIBRARY
npm run dev
```

打开 `http://localhost:4310`；同局域网可使用部署电脑的 IP。模型在页面“模型设置”中配置。生产画板需要有效 tldraw 许可。

[完整使用与网络方案](docs/local-web.md) · [P0 范围](docs/p0-scope.md) · [验证记录](docs/p0-verification.md)

[学习成果导出说明](docs/export.md)：可导出当前课程或全部成果，选择个人备份/分享范围；[导入恢复](docs/import.md)先预览、再新增无冲突内容。

[章节链接与知识查找](docs/navigation.md) · [Keyed Diff 实验](docs/keyed-diff.md) · [企划完成情况](docs/proposal-status.md)

底层数据协议与升级说明见 [数据契约](docs/data-contract.md)。升级后首次启动会备份并迁移旧学习状态；课程目录内新增身份文件，用于保持改名后的关联。

课程库独立存放在 `/Volumes/Steam/CourseXLibrary`，由 `.env` 中的 `COURSEX_LIBRARY` 指定。应用和 `./download.sh` 共用该配置；下载器的 `--output` 可单独覆盖某门课程的输出目录。直接运行 Python 脚本时需自行导出 `COURSEX_LIBRARY`；未配置时回退到项目内的 `library/`。

## 课程视频与 Markdown 课件批量下载

## 从 0 实现 React 18

```bash
cd /Volumes/Steam/ProjectLibrary/CourseX
./download.sh --course react18

# 只下载课件和图片
./download.sh --course react18 --docs-only

# 只处理第 2 课的三段视频和各自课件
./download.sh --course react18 --lessons 2

# 只生成完整目录
./download.sh --course react18 --plan
```

默认保存到配置的课程库下：`/Volumes/Steam/CourseXLibrary/从0实现 React 18/`。仍然每个视频一个文件夹，含 `视频.mp4`、`课件.md`、`images/`、`来源.md`；课程清单和下载结果放在课程根目录。分段编号保留，例如 `02-01 实现JSX`、`02-02 实现JSX的打包`。`--lessons` 按主课号选择，包含该课所有分段；省略时包含课程介绍和全部视频。

2026-10-11 登录后检查 [React 18 专栏](https://appjiz2zqrn2142.h5.xiaoeknow.com/p/course/column/p_638035c1e4b07b05581d25db?product_id=p_638035c1e4b07b05581d25db)：分页目录共 63 个视频，包含课程介绍和第 1–23 课的分段。

课件没有独立网站。视频页“介绍”下的 `.xe-preview__content` 展示富文本正文；接口 `xe.course.business_go.get.detail/2.0.0` 接收 `bizData[resource_id]`、`bizData[product_id]`，返回 `data.org_content` HTML。逐一核对了全部 63 页：62 页有正文，“课程介绍”为空；该文件夹的 Markdown 说明没有课件正文。正文由各视频自身的资源 ID 获取，不按主课号复制，因此保留分段页面的差异，也保留原文中的课号笔误。

转换保留图片、外部资料及本节 GitHub 代码链接；将代码里的 `<br>` 和不换行空格转换为正常换行与空格，移除代码块装饰。原始代码未标注语言时不猜测语言。React 18 不访问独立课件站，无需 `--insecure-docs`。播放地址仍通过登录浏览器正常加载获得。

2026-10-11 已保存全部 62 篇正文、124 张本地图片和课程介绍的无正文说明；逐一检查 Markdown 的本地图片引用与代码块闭合，未发现缺失。7 项测试通过；AI 课程的原有测试继续通过。React 18 全部视频已启动后台串行下载，运行日志在 `.coursex/react18-download.log`，进程号在 `.coursex/react18-download.pid`，成功或失败写入课程目录的 `下载结果.json`。启动记录不代表全部视频已下载完成。

```bash
# 查看本次后台下载的进度
tail -f .coursex/react18-download.log
```

后台任务结束后如有失败，重新运行 `./download.sh --course react18` 即可重试。已有完整文件会跳过；不要与仍在运行的同课程任务同时执行。

首个视频“课程介绍”已完整下载：99.987 秒、1280×720 H.264 视频与 AAC 音频，14,331,470 字节。开头、中间、结尾的音视频解码通过。批量任务继续下载后续视频，完整状态以 `下载结果.json` 和后台日志为准。

## 前端 + AI 转型探索营

默认保存到配置的课程库下：`/Volumes/Steam/CourseXLibrary/前端+AI转型探索营/`，每个视频独立文件夹，含 `视频.mp4`、`课件.md`、`images/` 和 `来源.md`。

```bash
cd /Volumes/Steam/ProjectLibrary/CourseX
./download.sh --insecure-docs
```

本机已安装依赖，并保存了本次手动登录的状态。首次在其他机器运行会安装 Python 依赖和 Chromium，然后打开浏览器等待手动登录；需要 Python 3.9+，以及 `ffmpeg` / `ffprobe`（macOS 可用 `brew install ffmpeg`）。不需要填写密码或复制 Cookie。

常用命令：

```bash
# 登录失效时重新登录，完成后回到终端按回车
./download.sh --login

# 只查看目录和课件配对；写入课程清单.json，不下载正文或视频
./download.sh --plan --insecure-docs

# 先下载指定课程；43 会处理两段视频
./download.sh --lessons 1,6,43 --insecure-docs

# 只下载所有课件及图片
./download.sh --docs-only --insecure-docs

# 显示浏览器，便于排查登录或播放问题
./download.sh --headed --lessons 6 --insecure-docs
```

完成文件会跳过；失败项记录在 `下载结果.json`，下一次运行重试。FFmpeg 先写入 `视频.part.mp4`，验证存在视频流、时长不短于站点标记时长 5 秒以上后才改名为 `视频.mp4`。中断的视频下次重新下载，暂不支持分片断点续传。串行处理，单项失败后继续其他内容，发生失败时退出码为 1。

`--insecure-docs` 是课件站当前过期 HTTPS 证书的兼容选项，仅对 `doc.iamkasong.com` 生效。站点证书修复后可以去掉。账号登录、视频下载继续校验证书。

登录状态和含时效播放地址的 FFmpeg 日志保存在 `.coursex/`，权限仅限当前用户，已加入 `.gitignore`。不要分享该目录；公开匹配清单不保存 Cookie、播放签名或视频密钥。

## 页面结构与匹配规则

2026-10-10 登录后实际检查结果：

- [课程专栏](https://appjiz2zqrn2142.h5.xiaoeknow.com/p/course/column/p_673d5557e4b023c058a79b7d?type=3&channel_id=)为动态页面。未登录时跳转到商品介绍；登录后使用 `xe.course.business_go.column.items.get/2.0.0` 分页读取目录。请求为表单 `bizData[column_id/page_index/page_size/sort]`，返回 `data.list` / `data.total`。每页 8 条，脚本根据 total 读取全部页。
- 共 51 条：49 个视频、2 篇图文（课程需知、后续课程更新计划）。本脚本按要求下载视频，图文只记录在清单中。
- 49 个视频包含课号 1–46，第 43、45 课各分成两段，另有项目演示视频。`resource_type=3` 为视频；`jump_url` 为真实播放页入口。
- 播放页返回 `xe.course.business_go.video.detail_info.get/2.0.0`，含完整播放权限、视频时长等信息。浏览器随后请求带时效签名的 HLS `.m3u8`；已检查第 6 课使用标准 AES-128 HLS。脚本使用当前会话正常加载出来的地址，通过 FFmpeg 标准 HLS 支持下载合并，不修改授权返回值。保存的是网页默认清晰度，不保证最高画质。
- [课件站](https://doc.iamkasong.com/)为 VitePress 1.6.4 静态站。首页“课程文档”链接进入第一课，侧栏 `.VPSidebar a[href]` 提供 46 篇编号课件，正文在 `main .vp-doc`。直接请求 `.md` 返回 `NoSuchKey`，因此脚本将网页正文转换为 Markdown，而非下载原始 Markdown 源码。
- 使用两站明确标注的课号匹配，保留各自标题。第 3、20、39–42 课的标题表述略有差异，但课号对应；第 43、45 课两段分别复制同一篇课件。演示视频没有独立课件，在 `来源.md` 标明。代码块保留语言、图片下载为相对路径；正文外的侧栏、翻页、导航不写入课件。

全量对应关系见输出目录的 `课程清单.json`。网站接口或布局变化时，脚本会报错，需要重新检查结构。

运行验证：

```bash
.venv/bin/python -m unittest discover -s tests -v
```

2026-10-11 验证：4 项测试通过；实际下载第 6 课，MP4 时长 991.446 秒（播放列表 991.4 秒），1280×720 H.264 视频 + AAC 音频，60,812,213 字节；开头、中间、结尾的音视频解码通过。对应 Markdown 和 5 张图片已保存；再次运行同一课时，视频和课件均跳过，本次失败数为 0。其余视频尚未批量下载验证。
