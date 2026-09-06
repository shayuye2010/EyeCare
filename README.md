# EyeCare 亮睛睛

一个 Windows 优先的绿色版护眼桌面小程序。界面基于 `C:\Users\Administrator\Desktop\eyecare_app_prototype.html` 重构，前端完全离线，不依赖 CDN。

## 开发

环境要求：Node.js 20+、Rust stable、Windows WebView2 Runtime。

```bash
npm install
npm run dev       # 浏览器预览
npm run test      # 状态逻辑测试
npm run build     # 前端静态构建
npm run tauri dev # 桌面开发运行
```

## 构建绿色版

```bash
npm run tauri build
```

Tauri 默认会生成 NSIS 安装包。绿色版可从 `src-tauri/target/release/eyecare.exe` 和 `dist/` 资源整理为压缩包，推荐保留同目录的 `README.txt`。程序使用系统 Evergreen WebView2，不把运行时打进压缩包，因此体积较小；目标电脑需要预装 WebView2。对于未安装 WebView2 的机器，请使用官方 Evergreen Bootstrapper 或改用 NSIS 安装包的引导安装模式。

应用不要求管理员权限。设置与统计当前保存在 WebView 的浏览器存储中；写入失败时会保留内存状态并提示用户。绿色版复制目录不会自动携带这份数据，正式发布时仍需将存储桥接到绿色目录旁的 `data/`，目录不可写时回退到 `%LOCALAPPDATA%\\EyeCare`。

## 已实现

- 20-20-20、番茄护眼、自定义 1–180 分钟
- 基于截止时间的计时，后台或睡眠唤醒后不会按秒漂移
- 智能分级提醒：先显示角落卡片，再升级边缘光晕，最后显示多显示器右下角桌面卡片，全程不抢焦点
- 托盘隐藏/恢复、关闭窗口隐藏到托盘
- 设置和每日统计持久化（按本地日期切日，损坏数据会安全归一化）
- 多显示器桌面提醒卡片、重复动作幂等及失败清理（不会锁住桌面操作）
- 检测到全屏应用时自动顺延提醒，避免打断演示、游戏或视频
- Windows 开机启动和前台全屏应用检测
- 键盘 Escape、读屏 live region、减少动效偏好和窄窗口滚动支持

## 发布前检查

需要在 Windows 真机验证：WebView2 缺失、锁屏/睡眠唤醒、多显示器和 DPI、全屏应用避让、非阻塞提醒不抢焦点、托盘单实例、复制绿色目录后运行，以及杀毒软件对未签名二进制的提示。
