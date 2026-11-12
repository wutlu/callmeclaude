package dev.callmeclaude

import android.content.Context
import android.content.Intent
import android.speech.tts.TextToSpeech
import java.util.Locale

/**
 * Debug builds only (the release source set has a no-op twin). Lets tests pair without a camera:
 *   adb shell am start -n dev.callmeclaude/.MainActivity --es pairing '<json>'
 * and check whether the phone has a text-to-speech voice for a language, without speaking:
 *   adb shell am start -n dev.callmeclaude/.MainActivity --es ttsProbe tr-TR
 *   adb logcat -s cmc.debug
 */
object DebugHooks {
    fun pairingText(intent: Intent?): String? = intent?.getStringExtra("pairing")

    fun probeSpeech(context: Context, intent: Intent?) {
        val language = intent?.getStringExtra("ttsProbe") ?: return
        var tts: TextToSpeech? = null
        tts = TextToSpeech(context.applicationContext) { status ->
            val t = tts
            if (status != TextToSpeech.SUCCESS || t == null) {
                AppLog.i(TAG, "tts probe: engine unavailable ($status)")
            } else {
                val locale = Locale.forLanguageTag(language)
                val voices = runCatching { t.voices.orEmpty().filter { it.locale.language == locale.language } }.getOrDefault(emptyList())
                AppLog.i(
                    TAG,
                    "tts probe: engine=${t.defaultEngine} $language available=${t.isLanguageAvailable(locale)} " +
                        "voices=${voices.size} installed=${voices.count { "notInstalled" !in it.features }}",
                )
            }
            t?.shutdown()
        }
    }

    private const val TAG = "cmc.debug"
}
