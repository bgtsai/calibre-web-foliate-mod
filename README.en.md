# calibre-web-foliate-mod

&nbsp;&nbsp;[繁體中文](README.md)

A Tampermonkey userscript that replaces Calibre-Web's built-in, epub.js-based reader with a self-packaged [foliate-js](https://github.com/johnfactotum/foliate-js) reader. The interface supports Traditional Chinese and English, switching automatically based on your browser's language, with a manual override available in the settings.

![Settings panel (English)](docs/screenshot_en.png)

## Why this exists

Calibre-Web's built-in epub.js reader has limited typography controls (font size, letter spacing, line spacing, and margins are either missing or imprecise), and its interface can't be customized. Without touching Calibre-Web's server-side code, this script uses Tampermonkey to swap out the reader entirely on the browser side, replacing it with foliate-js, which offers much finer typography control and deep visual customization — while keeping Calibre-Web's existing bookmark sync and reading-progress mechanisms intact, so your usual workflow (bookmarks, progress) stays the same; only the rendering engine and interface change.

## Features

- **Fine-grained typography**: font size (up to 300%), letter spacing (up to 0.5em), line spacing (up to 5X), justification, and hyphenation — all independently adjustable and applied instantly.
- **Margin Priority / Content Priority**: independently selectable for the horizontal and vertical axes. Margin Priority sets a fixed margin value; Content Priority sets a fixed content width/height, with the margin automatically absorbing any change in available space — content size stays consistent when toggling fullscreen.
- **Column control**: max columns and gap between columns in paginated mode (locked to 1 column in scroll mode; these two settings are automatically disabled there).
- **Themes**: four built-in themes (Follow System, Light, Dark, Sepia), plus the ability to save your current typography settings as a custom theme. Multiple themes can be reordered by drag-and-drop, and an existing theme can be overwritten with your current settings.
- **Custom colors**: text and background colors can each be entered in HEX / RGB / HSV format (a built-in color picker is also available), with color schemes savable and reorderable by drag-and-drop.
- **Font management**: manually enter the name of a font already installed on your system, or upload a font file (.ttf / .otf / .woff) directly; the font list also supports drag-and-drop reordering.
- **Left/right tap zones**: click zones on either edge of the screen for previous/next page navigation. Enabling the zone (click-to-page) and showing its visual hint are separate toggles; zone width is configurable in pixels. This feature is meaningless in scroll mode and is automatically disabled there.
- **Auto-hide toolbar**: the toolbar and progress bar can slide out of view after a few seconds of inactivity while reading, and wake up on hover or click.
- **Page-turn shortcuts**: customizable keyboard shortcuts for previous/next page, with multiple key combinations recordable per direction.
- **Bookmarks and progress**: uses Calibre-Web's existing server-side bookmark mechanism; reading progress is also remembered locally (saved instantly on every page turn), with an option to auto-sync back to the server bookmark after a configurable idle period.
- **Precise page alignment** (experimental, off by default): when adjusting typography settings or resizing the window, attempts to precisely align the currently-read line to the top of the new layout, reducing visual jumps or lost reading position. There's no "top of page" concept in scroll mode, so this is automatically disabled there.
- **Bilingual interface**: defaults to Traditional Chinese or English based on your browser, with a manual override available in settings (requires a page reload to take effect).

## Requirements

You'll need the [Tampermonkey](https://www.tampermonkey.net/) browser extension (works with Chrome, Firefox, Edge, and other major browsers). Visit the link above and follow the installation steps shown for your specific browser — the regular stable release works fine.

## Usage

1. Install Tampermonkey (see above).
2. Install this script: [calibre-web-foliate-mod.user.js](https://cdn.jsdelivr.net/gh/bgtsai/calibre-web-foliate-mod@main/calibre-web-foliate-mod.user.js)
3. Open any EPUB in Calibre-Web — the reader will automatically switch to the foliate-js version. Click the gear icon in the top-right corner to open the typography settings panel.

## Interface language not as expected?

The interface defaults to Traditional Chinese or English based on your browser's reported "preferred language for web content" — if it starts with `zh`, Chinese is shown; otherwise English. This setting is independent of your browser's own UI language (menus, buttons, etc.) — a browser with a Chinese interface doesn't necessarily report Chinese as the preferred web content language. If the auto-detected result isn't what you want, you can:

- Go to the "語言 / Language" section at the bottom of the settings panel and manually set the display language (a page reload is required for the change to take effect); or
- Adjust your browser's "preferred language for web content" setting (in Firefox: Settings → General → Language → Choose your preferred language for displaying pages, and move Traditional Chinese to the top of the list).
