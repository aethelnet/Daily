# Daily Mobile — Android & iOS (Capacitor + Offline-First Sync)

Diese native Wrapper-App nutzt exakt das gleiche schlanke Frontend (`../static`) offline auf dem Gerät und synchronisiert idempotent via `POST /api/sync` + `X-Daily-Token` mit deinem lokalen Daily-Server (inkl. TabPFN v2 auf Linux).

## 1. Sofort heute nutzbar (Android & iOS — ohne Build!)
1. In Daily auf dem Desktop: **Setup & Routing → Geräte & Sync**.
2. QR-Code mit dem Handy scannen (WLAN `http://<LAN-IP>:8090/?token=...` oder über Tailscale).
3. **iOS Safari:** *Teilen → Zum Home-Bildschirm*. **Android Chrome:** *App installieren*.
4. Funktioniert offline (Offline-Warteschlange in `localStorage` + Service Worker) und synct automatisch bei Verbindung.

## 2. Nativer Android-Build (`.apk`)
Voraussetzung: Android Studio / Android SDK + JDK 17+.
```bash
cd mobile
npm run cap:sync
cd android && ./gradlew assembleDebug
# Output: android/app/build/outputs/apk/debug/app-debug.apk
```
In der App unter **Setup & Routing → Geräte, Backup & Sync → Eigener Server / Sync-Token** einmal deine Linux-Server-URL (z. B. `http://192.168.x.x:8090` oder deine Tailscale-IP) + Sync-Token eintragen.

## 3. Nativer iOS-Build (`.ipa`)
Voraussetzung: macOS + Xcode + CocoaPods (Apple erlaubt iOS-Builds & Signierung ausschließlich unter macOS).
```bash
cd mobile
npm run ios:open
# In Xcode: Signing Team auswählen → Run auf iPhone oder Product → Archive
```
