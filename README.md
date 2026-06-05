# AV2 GUI Encoder

A web-based GUI for the **AV2 (AVM) reference video codec** with segment-based parallel encoding for full CPU utilization.

## Screenshots

![Dashboard](images/ss_1.png)
![Encoding Progress](images/ss_2.png)

## What It Does

- Splits video into N segments, encodes them in parallel using all CPU cores
- Patches EBML headers to bypass FFmpeg's AV2 codec restrictions
- Merges segments and muxes audio back — losslessly
- **8x–16x faster** than single-threaded `avmenc.exe`

## Quick Start

1. Clone the repo
2. Place your compiled `avmenc.exe` in the `build/` folder
3. Double-click **`launch.bat`**

> The launcher auto-downloads **Node.js** and **FFmpeg** if missing. First run takes ~2 min.

## Features

- **Parallel encoding** — adjustable worker count (1 to max cores)
- **Real-time dashboard** — progress, FPS, ETA via WebSocket
- **Resolution downscaling** — 1080p → 240p on-the-fly
- **Frame limiter** — encode only first N frames for testing
- **Audio control** — copy, transcode to Opus, or strip
- **Native file dialogs** — Windows Open/Save pickers with web fallback

## Project Structure

```
build/avmenc.exe          # AV2 encoder binary (you provide this)
launch.bat                # One-click launcher (auto-installs deps)
av2_gui/
  backend/
    server.js             # Express + WebSocket server
    encoder.js            # Parallel pipeline + EBML patcher
  frontend/
    src/App.jsx           # React dashboard
    src/index.css         # Dark glassmorphism UI
```

## How The Pipeline Works

```
Input → FFmpeg decode → N segment .y4m files
     → N parallel avmenc.exe instances
     → Patch V_AV2 → V_FFV1 (EBML binary hack)
     → FFmpeg concat + audio mux
     → Patch V_FFV1 → V_AV2 (restore)
     → Final .mkv/.webm output
```

## Requirements

- **Windows 10+**
- `avmenc.exe` in `build/` (compile from [AVM source](https://gitlab.com/AOM/avm))
- Everything else is auto-downloaded by `launch.bat`

## Manual Start (Optional)

```bash
cd av2_gui/backend && npm install && npm start
cd av2_gui/frontend && npm install && npm run dev
```

Open `http://localhost:5173`
