# Brand asset sources (M15)

All files were copied (never edited in place) from the TraderMatrix brand kit (`frontend/public/{brand,branding}`).
Re-encoded files were produced locally with ffmpeg (libwebp); crop boxes are x:y:w:h in source pixels, then scaled.

| File | Source | Processing |
|---|---|---|
| mark-256.png | brand/mark-256.png | copy (toolbar mark) |
| lockup-on-dark-800.png | brand/lockup-on-dark-800.png | copy (unlock screen, About) |
| wordmark-on-dark.svg | brand/wordmark-on-dark.svg | copy (toolbar wordmark) |
| bg-gold-arcs.webp | branding/full/20261012-154643.webp (backgrounds: dark navy, gold accent, empty left, no text) | scaled to 1280 wide, q70. Unlock screen only |
| bg-wide-navy.webp | branding/full/20261012-162156.webp (backgrounds: ultra-wide deep navy, gold accent, empty left, no text) | scaled to 1280 wide, q70. Empty states only |
| arya-focused-128.webp, arya-focused-256.webp | branding/full/20261012-214014.webp (arya, hero, smile) | crop 520:520:960:60, scaled to 128 / 256, q80. "Thinking" state |
| arya-calm-128.webp, arya-calm-256.webp | branding/full/20261012-214905.webp (arya, after-hours, calm) | crop 480:480:1050:150, scaled to 128 / 256, q80. Idle state |
| arya-wry-128.webp, arya-wry-256.webp | branding/full/20261010-080553.webp (arya, raised eyebrow at camera) | crop 400:400:400:20, scaled to 128 / 256, q80. Greeting (empty state) |

App icon set (`src-tauri/icons/*`, not in this directory): generated with ffmpeg (lanczos) from `brand/mark-512.png`, the largest square mark.
`icon.icns` is the earlier placeholder (no icns encoder here; it is only used by macOS bundles, which this Linux-only app does not build).

The hand-made section of the brand album (`branding/album.json`) is not copied (none of its images). No video or GIF is copied (`branding/video/*` untouched).
