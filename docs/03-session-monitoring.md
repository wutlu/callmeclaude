# 03 · Oturum İzleme, Tıkanma Tespiti ve Oturuma Talimat İletme

## 1. Oturumları keşfetme

Üç kaynak birleştirilir:

1. **Hooks (birincil, push):** `cmc setup`, kullanıcı seviyesindeki `~/.claude/settings.json`'a HTTP hook'lar ekler. Böylece terminal, IDE eklentisi veya Desktop içinden başlatılan *her* Claude Code oturumu Hub'a olay yollar.
2. **Transcript tail (içerik):** Hook payload'undaki `transcript_path` dosyası `fs.watch` ile izlenir; son asistan mesajı, son araç çağrısı, token kullanımı buradan okunur.
3. **Süreç keşfi (doğrulama):** Periyodik `ps`/`lsof` ile `claude` süreçleri ve TTY'leri; hook göndermeyen eski/bozuk oturumları ve "öldü mü?" durumunu yakalar.

### Hook yapılandırması (şablon: [`config/claude-hooks.json`](../config/claude-hooks.json))

```jsonc
{
  "hooks": {
    "SessionStart":      [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:47800/hooks/SessionStart", "timeout": 5 }] }],
    "SessionEnd":        [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:47800/hooks/SessionEnd", "timeout": 5 }] }],
    "UserPromptSubmit":  [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:47800/hooks/UserPromptSubmit", "timeout": 5 }] }],
    "Notification":      [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:47800/hooks/Notification", "timeout": 5 }] }],
    "PermissionRequest": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:47800/hooks/PermissionRequest", "timeout": 600 }] }],
    "Stop":              [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:47800/hooks/Stop", "timeout": 600 }] }],
    "StopFailure":       [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:47800/hooks/StopFailure", "timeout": 5 }] }],
    "PostToolUse":       [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:47800/hooks/PostToolUse", "timeout": 3 }] }],
    "SubagentStart":     [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:47800/hooks/SubagentStart", "timeout": 5 }] }],
    "SubagentStop":      [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:47800/hooks/SubagentStop", "timeout": 5 }] }],
    "TaskCompleted":     [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:47800/hooks/TaskCompleted", "timeout": 5 }] }]
  }
}
```

Kurallar:
- Hub kapalıysa HTTP hook bağlantı hatası **bloklamayan** hatadır → Claude Code normal çalışmaya devam eder. Hub hiçbir zaman oturumları kilitlememeli.
- `PermissionRequest` ve `Stop` için uzun timeout, "hold-open" stratejisi içindir (aşağıda). Maksimum hook timeout değeri resmi dokümandan doğrulanmalı ⚠️.
- Hook'lar `Authorization: Bearer $CMC_HOOK_TOKEN` başlığı taşır (`allowedEnvVars`), Hub yalnızca `127.0.0.1` dinler.
- `cmc setup` mevcut hook'ları **birleştirir**, ezmez; `cmc uninstall` yalnızca kendi eklediklerini kaldırır.

## 2. Durum makinesi

```
           SessionStart
                │
                ▼
   ┌──────▶ running ◀──────────────┐
   │         │  │  │               │ UserPromptSubmit / hook "block" yanıtı
   │         │  │  └─ PermissionRequest / Notification(permission_prompt)
   │         │  │          ▼        │
   │         │  │   waiting_permission
   │         │  └─ Stop ─▶ classify(lastMessage) ─┬─▶ done           (iş bitti, rapor)
   │         │                                    ├─▶ waiting_input  (soru soruyor)
   │         │                                    └─▶ blocked        (yapamıyor/engel)
   │         ├─ StopFailure ─▶ errored (rate limit / API hatası)
   │         └─ N dk olay yok + süreç canlı ─▶ stale (takılmış olabilir)
   │
   └── SessionEnd ─▶ ended
```

### Sınıflandırıcı (Stop olayında)
Girdi: son asistan mesajı + son 3 araç çağrısının özeti + kullanıcının son talimatı.
Model: Haiku (Agent SDK üzerinden, kullanıcının planı). Çıktı (JSON):

```json
{
  "state": "blocked",
  "reason_code": "needs_approval",        // needs_approval | missing_credential | captcha | 2fa | tool_refused | error | question | done
  "summary_tr": "Ödeme formu dolduruldu, göndermek için onay istiyor.",
  "suggested_actions": ["oturuma onay ver", "computer-use ile gönder"],
  "risk": "medium",
  "confidence": 0.92
}
```

Hızlı yol: düzenli ifade ön filtresi ("yapamam", "can't", "unable to", "you'll need to", "onayını", "please confirm", "2FA", "CAPTCHA") → sınıflandırıcıyı yalnızca belirsiz durumlarda çağırarak plan kullanımını azalt.

### Bayatlık (stale) tespiti
- `PreToolUse` geldi ama `PostToolUse` X dakikadır gelmedi (örn. takılan `npm run dev`).
- Transcript dosyası N dakikadır değişmedi ve durum `running`.
→ Önce sessizce bilgi topla (süreç CPU'su, son komut), sonra düşük öncelikli bildirim.

## 3. Oturuma talimat iletme (Controller)

Öncelik sırasına göre denenecek stratejiler:

| # | Strateji | Ne zaman | Nasıl |
|---|---|---|---|
| 1 | **Hook yanıtı (hold-open)** | Oturum şu an bir `Stop` veya `PermissionRequest` hook'unda bekliyor | `Stop` → `{"decision":"block","reason":"<developer talimatı>"}` → Claude bu gerekçeyle çalışmaya devam eder. `PermissionRequest` → allow/deny. En temiz, resmi yol. |
| 2 | **Channel** (research preview) | Oturum `cmc` channel'ı ile başlatılmışsa | Hub, MCP channel üzerinden mesaj iter. API değişebilir ⚠️ |
| 3 | **tmux send-keys** | Oturum `cmc run` ile tmux içinde başlatılmışsa | `tmux send-keys -t <pane> "<mesaj>" Enter`; `Escape` ile interrupt. |
| 4 | **Headless resume** | Oturum süreci kapanmışsa | `claude -p --resume <session_id> "<mesaj>"` arka planda; çıktı yeni olay olarak izlenir. |
| 5 | **Computer use** | Oturum çıplak bir Terminal/iTerm penceresinde ve 1-4 mümkün değilse | Pencereyi öne getir, yaz, Enter. Son çare. |

> **Öneri:** Uzun yolculuk öncesi tüm önemli oturumları `cmc run <proje>` ile başlat. Bu, tmux + hook'lar + (destekleniyorsa) channel ile tam kontrol sağlar.

### Hold-open detayları
- Hook isteği geldiğinde Hub hemen karar verebiliyorsa (policy: "bu projede `npm test` her zaman izinli") → anında yanıt.
- Developer'a sorulacaksa: istek açık tutulur, arama başlatılır. Cevap timeout'tan önce gelirse hook yanıtı olarak döner.
- Timeout yaklaşırken (T-10 sn) boş yanıtla serbest bırakılır; karar "bekleyen" olarak kalır ve strateji 2-4 ile iletilir.

### Permission otomasyonu
Developer telefonda *"Bu projede test ve build komutlarına sorma"* diyebilir → Hub, `policy.yaml`'a oturum/proje bazlı kural ekler ve gelecekteki `PermissionRequest`'leri otomatik onaylar (audit'e yazar). Kalıcı izin değişiklikleri (Claude Code'un kendi `permissions.allow` ayarı) yalnızca açık sesli onayla.

## 4. Oturum özeti

Brain, her oturum için şu kısa kartı canlı tutar (brifing için):

```yaml
id: 3f2a…
project: acme-web
state: blocked/needs_approval
goal: "Başvuru formunu doldur ve gönder"
last_progress: "Form alanları dolduruldu"
waiting_since: 12:41
one_liner: "Form hazır, gönderme onayı bekliyor."
```
