# Mac Agent (Hub)

TypeScript (Node 22.5+), `tsx` ile kaynak koddan çalışır. launchd servisi (Linux'ta systemd `--user` servisi) + `cmc` CLI. Linux kurulumu: [INSTALLATION.md › Linux hub](../../INSTALLATION.md#linux-hub).

| Dosya | Görev |
|---|---|
| `src/hookServer.ts` | Claude Code HTTP hook'ları (127.0.0.1:47800). `Stop` ve `PermissionRequest` olaylarını **açık tutar** (hold), geliştirici cevap verince yanıtlar. Ayrıca `cmc` için `/control/*` API'si. |
| `src/state.ts` | Oturum kayıtları, bekleyen kararlar, hold'lar, kuyruktaki talimatlar (`~/.callmeclaude/state.json`) |
| `src/classifier.ts` | Duran oturumu sınıflandırır: regex + Claude Haiku (kullanıcının kendi planı, Agent SDK) |
| `src/controller.ts` | Talimat iletme: hold yanıtı → tmux send-keys → `claude -p --resume` → meşgul oturum için kuyruk (sonraki hook'ta `additionalContext`) → boştaki oturum için `--fork-session` ile headless kopya |
| `src/calls.ts`, `src/apns.ts` | Ne zaman aranacağı (öncelik, toplama, modlar, tekrar) + doğrudan APNs VoIP push |
| `src/voice/` | Gemini Live köprüsü, ses modeli araçları, telefon dostu sistem prompt'u ve brifing |
| `src/brain.ts` | Claude Agent SDK: bilgisayar görevleri (Claude in Chrome + Peekaboo + cliclick; Linux'ta masaüstüne göre scrot/spectacle/grim + xdotool/ydotool) ve transcript soruları |
| `src/appServer.ts` | Telefon WebSocket sunucusu (0.0.0.0:47801, token ile) |
| `src/install.ts` | Hook birleştirme/kaldırma, servis kurulumu (platform katmanı üzerinden) |
| `src/platform/` | OS'a özel her şey: `darwin.ts` (Keychain, launchd, Peekaboo) ve `linux.ts` (libsecret, systemd `--user`, doctor kontrolleri); `computerUse.ts` Linux sürücü seçimi. Bkz. [ADR-0006](../../docs/adr/0006-linux-hub.md), [ADR-0008](../../docs/adr/0008-linux-computer-use.md) |
| `scripts/desk-phone.mts` | Linux masaüstü test telefonu: PipeWire ile arama sesi taşır (bkz. [CONTRIBUTING.md](../../CONTRIBUTING.md#desk-phone-linux)) |

```bash
pnpm install
node bin/cmc.mjs help
pnpm test        # uçtan uca hook/hold/arama testleri (izole CMC_HOME)
```
