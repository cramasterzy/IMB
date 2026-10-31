<h1 align="center">IMB — 像 PureRef 一样自由，为视频与 GIF 而生</h1>

<p align="center">
  <strong>PureRef-style freedom, rebuilt for real-time video, GIF, images, and text.</strong><br>
  不只是静态参考板：把动态灵感、声音和逐帧审片一起放进无限画布。
</p>

<p align="center">
  <a href="docs/README.zh-CN.md">中文说明</a> ·
  <a href="docs/README.en.md">English</a> ·
  <a href="https://cramasterzy.github.io/IMB/web/">在线使用 / Open Web App</a> ·
  <a href="../../releases/latest">下载最新版 / Download</a>
</p>

![Infinite Media Board overview](docs/images/board-overview.png)

IMB（Infinite Media Board）是一款从 PureRef 式自由参考板工作流出发、专门强化动态媒体体验的无限画布。它让图片、GIF、视频和文字在同一空间中实时共存，并加入视频声音悬停、逐帧查看、同步播放、多选排版、Figma 风格吸附和跨平台网页分享。

IMB (Infinite Media Board) starts with the freedom of a PureRef-style reference canvas and extends it for motion work. Images, GIFs, videos, and text live together in real time, with hover audio, frame stepping, synchronized playback, multi-item layout, Figma-style snapping, and cross-platform web sharing.

## 为什么选择 IMB？/ Why IMB?

如果你的参考内容主要是静态图片，PureRef 依然是成熟而强大的选择。IMB 的重点不是简单复制 PureRef，而是补上动态视觉工作流：在参考板里直接播放多个视频、听取悬停素材声音、逐帧检查、同步暂停或继续，并把画板分享给没有安装桌面软件的人。

If your references are mainly still images, PureRef remains a mature and powerful choice. IMB focuses on a different gap: motion references, synchronized video review, audio-on-hover, frame stepping, and browser-based sharing for people who do not have the desktop app.

| 能力 / Capability | PureRef 2.x | IMB 0.19 |
| --- | --- | --- |
| 无限图片参考画布 / Infinite image canvas | ✓ | ✓ |
| 动态 GIF / Animated GIF | ✓ | ✓ |
| 多视频实时播放 / Multiple real-time videos | 官方格式说明未列出视频 / Video not listed in official format support | ✓ |
| 悬停单独听声 / Hover audio | — | ✓ |
| 视频逐帧前进、后退 / Video frame stepping | — | ✓ |
| 全部暂停、继续、从头同步 / Global pause, resume, restart | — | ✓ |
| 自包含项目文件 / Embedded project media | 图片可嵌入 / Images can be embedded | 图片、GIF、视频均嵌入 / Images, GIFs, and videos embedded |
| 无需安装的网页使用 / No-install web app | — | ✓ |
| 可编辑与只读网页分享 / Editable & read-only web sharing | — | ✓ |
| 桌面平台 / Desktop platforms | Windows / macOS / Linux | Windows 安装版与便携版 / Windows installer & portable |

PureRef 对比信息依据其[官方功能手册](https://www.pureref.com/handbook/features/)与[官方格式支持说明](https://www.pureref.com/support.php)。PureRef 是其权利人的商标，IMB 与 PureRef 官方无关联。

## 主要功能 / Highlights

- 图片、GIF、视频和文字共存；软件不设置素材数量上限（实际性能取决于硬件）
- Infinite canvas for images, GIFs, videos, and text, with no artificial item limit
- GIF 与视频实时播放；视频默认静音，鼠标悬停时可单独听声
- Real-time GIF/video playback with default mute and hover audio
- Figma 风格边缘、中心与等间距吸附，绿色参考线实时反馈
- Figma-style edge, center, and equal-spacing snapping with green guides
- 框选和多选后整体移动、八方向缩放、复制、层级调整与局部排版
- Box/multi-select, group move, eight-handle resize, duplicate, layer ordering, and partial layout
- `.imb` 文件嵌入全部素材；删除原始文件后，已保存画板仍可完整打开
- Self-contained `.imb` boards embed their media and survive deletion of the source files
- 导出可编辑或只读 HTML，在手机、macOS、Windows 浏览器中查看
- Export editable or read-only HTML for viewing on phones, macOS, and Windows
- 多选素材按原尺寸合并导出 PNG；视频与 GIF 使用当前帧
- Export selected items as one original-resolution PNG using the current video/GIF frame

![Composite export example](docs/images/composite-export.png)

## 三种使用方式 / Three ways to use IMB

| 版本 | 适合谁 | 使用方式 |
| --- | --- | --- |
| 网页版 / Web | macOS、Windows，免安装 | [立即打开 IMB Web](https://cramasterzy.github.io/IMB/web/) |
| Windows 安装版 / Installer | 日常稳定使用、文件关联 | 在 [Releases](../../releases/latest) 下载 Setup EXE |
| Windows 便携版 / Portable | U 盘、临时电脑、免安装 | 在 [Releases](../../releases/latest) 下载 Portable ZIP |

网页版数据默认保存在当前浏览器本地，不会自动上传素材。桌面版提供完整 `.imb` 自包含项目文件与系统级快捷方式。

The web app stores projects and media locally in the current browser by default. The desktop app provides full self-contained `.imb` projects and native Windows integration.

## 快速开始 / Quick start

下载 GitHub Releases 中的安装版，或下载便携版 ZIP 后解压运行 `Infinite Media Board.exe`。

Download the Windows installer, or extract the portable ZIP and run `Infinite Media Board.exe`.

开发版 / Development:

```powershell
npm install
npm start
```

构建 Windows 安装包 / Build the Windows installer:

```powershell
npm run dist
```

## 文档 / Documentation

- [完整中文说明](docs/README.zh-CN.md)
- [Full English guide](docs/README.en.md)
- [发布与版本策略](RELEASE_POLICY.md)

## 许可 / License

本项目目前未采用开源许可证，保留所有权利。详见 [LICENSE](LICENSE)。

This project is currently not distributed under an open-source license. All rights are reserved. See [LICENSE](LICENSE).

> 文档中的界面示意图使用为本项目全新制作的抽象演示素材，不包含用户此前提供的图片。
>
> All screenshots use newly created abstract demo assets and do not contain previously supplied user images.
