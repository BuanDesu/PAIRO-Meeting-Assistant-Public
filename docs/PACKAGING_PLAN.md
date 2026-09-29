# Native Packaging Plan

## Goal
Produce a Windows x64 portable executable and an Android installable APK from the existing P2P Meeting Copilot web app, while retaining WebRTC media/data and the mobile-side LLM request path.

## Selected packaging architecture

- **Windows desktop:** Electron shell around the existing Vite build. The main process will start the existing ephemeral WebSocket signaling service on port 8787, register OS-level Alt+Shift+S/M/A hotkeys, and configure Electron screen capture with the native system picker where available. A fallback picker must let the user choose a screen/window; never silently share the first source. Windows loopback audio is requested only when the renderer asks for capture audio. Windows uses an in-app source picker; Electron's useSystemPicker is currently macOS-only experimental. electron-builder creates the unpacked Windows app; a locally installed NSIS 3.12 wrapper produces the self-extracting portable .exe without relying on electron-builder's remote NSIS bundle.
- **Android phone:** Capacitor 8 Android wrapper around the same built web assets. Android opens directly in phone role; it receives WebRTC audio/video and data, uses mobile text input/speech playback, and calls the configured HTTPS LLM endpoint. No screen-capture permission is requested on phone.
- **Shared application:** Vite output becomes relative-path compatible for Electron and Capacitor. Browser mode remains supported. API Key stays in page memory.
- **Distribution:** keep build outputs in release/ (ignored by Git); commit packaging code/config/docs and provide local artifacts. APK is expected to be debug-signed for sideload testing; a production signing keystore is not created or committed. Consider a CI workflow for reproducible artifact builds.

## Host facts

- Windows x64, Node.js 24.16.0 and Java/JDK 21 are present.
- Android Studio 2026.1.4.7, Android command-line tools, platform-tools, Android platform 36, and build-tools 36.0.0 are installed under LocalAppData. JDK 21 is available.
- Capacitor 8.5.2 project creation and Gradle APK build are currently running; portable EXE packaging is also being checked.

## Acceptance checks

1. Existing web tests and Vite production build pass.
2. Desktop packaging creates a portable .exe and packaged main process starts the local signaling server; screen capture remains user-selected and hotkeys reach the renderer.
3. Capacitor sync creates Android project and Gradle assembles an installable debug APK.
4. Document exact output paths, local install steps, mobile/desktop network setup, and unverified physical-device behavior.
5. Push packaging source/config/docs and progress update to the existing GitHub repository; do not push secrets, keystores, node_modules, or raw binaries as text source.

## Official references

- Electron screen capture: https://www.electronjs.org/docs/latest/api/desktop-capturer
- Electron global shortcuts: https://www.electronjs.org/docs/latest/api/global-shortcut
- Electron Builder Windows targets: https://www.electron.build/win
- Capacitor Android platform: https://capacitorjs.com/docs/android
