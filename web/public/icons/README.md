# OpenDot robot icons

## 统一图标源

OpenDot 的机器人图标只维护一份：

`/assets/miniclaw-icon.svg`

页面 Logo 直接导入该 SVG，由 Vite 输出带内容哈希的资源地址，避免继续命中旧 Logo 的长期缓存。Web/PWA 的 PNG、Apple Touch Icon、favicon 和 Electron 图标通过 `npm run generate-icons` 从同一源文件生成。

生成器会同步更新 favicon 与 PWA 图标的内容版本。通知图标也使用带版本的地址。旧的 `loading-logo.svg` 和 `logo-text.svg` 已删除，页面直接使用机器人图标。

## 自动生成

`npm run dev` 和 `npm run build` 的 pre-script 会先执行图标生成，因此浏览器、PWA 与生产构建不会继续使用仓库中旧的缓存 PNG。

需要手工刷新图标时运行：

```bash
cd web
npm run generate-icons
```

生成：

- `icon-48.png` 到 `icon-512.png`
- `icon-512-maskable.png`
- `apple-touch-icon-180.png`
- `logo-1024.png`
- `../favicon.ico`：使用同一 48px PNG 的 ICO 封装，覆盖浏览器默认图标请求
- `../opendot-robot.svg` 与 `../favicon.svg`：机器人 SVG；页面 favicon 使用前者的版本化地址

不要单独编辑这些生成文件；品牌图形调整只修改 `/assets/miniclaw-icon.svg`。

## Electron exports and verification

The same generator writes `electron/assets/miniclaw-icon.png` (1024px) and
`electron/assets/miniclaw.icns` (16–1024px PNG representations). Keep the existing
Electron packaging paths; SVG is the design source, not the native icon input.
Commit regenerated PNG/ICNS files with changes to the canonical SVG. The
`brand-assets.test.ts` suite compares decoded pixels with that source and checks
every ICNS entry, so stale platform exports cannot pass unnoticed. Web predev and
prebuild regenerate the exports without changing dependency versions.

Physical OS launchers, installed PWA icon refresh and signed desktop packages
require separate device/package verification; local format checks do not prove
those behaviors.
