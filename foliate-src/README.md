# foliate-src/

此資料夾存放從 `calibre-web-foliate-mod.user.js` 解出來的 foliate-js bundle 原始碼，供直接閱讀與修改使用。

## 檔案

| 檔案 | 說明 |
|------|------|
| `bundle.js` | 從腳本的 `BUNDLE_SOURCE` 解出的 foliate-js 原始碼（可直接閱讀和編輯） |

---

## Workflow 說明

### Unbundle Foliate JS（解包）

**檔案**：`.github/workflows/unbundle-foliate.yml`  
**觸發方式**：GitHub Actions 頁面手動執行（Run workflow）

**用途**：把 `calibre-web-foliate-mod.user.js` 第 133 行的 `BUNDLE_SOURCE` 字串解 JSON 跳脫，存成 `foliate-src/bundle.js`，方便直接閱讀和修改 foliate-js 原始碼。

**執行後**：`foliate-src/bundle.js` 會被 commit 進 repo。

---

### Rebundle Foliate JS（打包）

**檔案**：`.github/workflows/rebundle-foliate.yml`  
**觸發方式**：GitHub Actions 頁面手動執行（Run workflow）

**用途**：把修改過的 `foliate-src/bundle.js` 重新 JSON 編碼，寫回 `calibre-web-foliate-mod.user.js` 第 133 行的 `BUNDLE_SOURCE`。

**執行後**：`calibre-web-foliate-mod.user.js` 會被 commit 進 repo，可直接安裝使用。

---

## 標準工作流程

```
1. 執行 Unbundle Foliate JS
   → foliate-src/bundle.js 出現（可讀的 JS 原始碼）

2. 直接編輯 foliate-src/bundle.js
   → 在 GitHub 網頁介面或 clone 下來修改後 push

3. 執行 Rebundle Foliate JS
   → BUNDLE_SOURCE 更新，calibre-web-foliate-mod.user.js 可安裝
```

---

## 移植說明（供 Docker 專案複用）

移植到 `calibre-web-foliate-docker` 或其他衍生專案時：

1. **兩個 workflow 可直接複製**，不依賴任何外部 Action 或 Secret，只需要 `permissions: contents: write`（由 `GITHUB_TOKEN` 自動提供）
2. **唯一需要調整的**是腳本路徑（`calibre-web-foliate-mod.user.js`）和 `BUNDLE_LINE`（目前是第 133 行，0-indexed 為 132）——如果目標專案的腳本結構不同，把這兩個值改對即可
3. **`BUNDLE_SOURCE` 的格式**：單行 JSON 字串，格式為 `    const BUNDLE_SOURCE = "...";`，Python 的 `json.dumps()` / `json.loads()` 直接處理，不需要額外工具
