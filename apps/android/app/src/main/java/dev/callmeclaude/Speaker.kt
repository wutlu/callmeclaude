package dev.callmeclaude

import android.content.Context
import android.media.AudioAttributes
import android.speech.tts.TextToSpeech
import java.util.Locale

/**
 * Says the hub's short alerts ("acme: task complete.") with the phone's own text-to-speech, in the hub's
 * voice language. Navigation-guidance audio: it ducks music and plays through a connected headset or
 * helmet intercom. The engine starts on first use; texts that arrive before it is ready are queued.
 */
class Speaker(private val context: Context) {
    private var tts: TextToSpeech? = null
    private var ready = false
    private val waiting = mutableListOf<Pair<String, String>>()

    /** Main thread. */
    fun say(text: String, language: String) {
        if (text.isBlank()) return
        if (ready) return speak(text, language)
        waiting += text to language
        if (tts != null) return
        tts = TextToSpeech(context.applicationContext) { status ->
            if (status != TextToSpeech.SUCCESS) {
                AppLog.w(TAG, "text-to-speech unavailable: $status")
                tts = null
                waiting.clear()
                return@TextToSpeech
            }
            ready = true
            tts?.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            waiting.forEach { (t, l) -> speak(t, l) }
            waiting.clear()
        }
    }

    private fun speak(text: String, language: String) {
        val t = tts ?: return
        val locale = Locale.forLanguageTag(language)
        if (t.isLanguageAvailable(locale) >= TextToSpeech.LANG_AVAILABLE) t.language = locale
        else AppLog.w(TAG, "no text-to-speech voice for $language, using the default")
        t.speak(text, TextToSpeech.QUEUE_ADD, null, "cmc-${System.nanoTime()}")
        AppLog.i(TAG, "announce: $text")
    }

    private companion object {
        const val TAG = "cmc.speak"
    }
}
