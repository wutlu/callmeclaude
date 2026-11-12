package dev.callmeclaude

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.speech.tts.TextToSpeech
import java.util.Locale

/**
 * Says the hub's short alerts ("acme: task complete.") with the phone's own text-to-speech, in the hub's
 * voice language. Navigation-guidance audio: it ducks music and plays through a connected headset or
 * helmet intercom. The engine starts on first use; texts that arrive before it is ready are queued.
 *
 * No voice for the language (or no engine at all): the alert is shown as a notification with a short
 * sound instead of being read by a voice of another language; see [AlertPlanner]. [shutdown] releases
 * the engine (the hub service calls it when it stops); the next alert starts it again.
 */
class Speaker(private val context: Context) {
    private var tts: TextToSpeech? = null
    private var ready = false
    private val waiting = mutableListOf<Pair<String, String>>()
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    @SuppressLint("UseKtx") // no androidx.core dependency on purpose
    private val planner = AlertPlanner(
        hintShown = { prefs.getBoolean("$HINT_PREFIX$it", false) },
        rememberHint = { prefs.edit().putBoolean("$HINT_PREFIX$it", true).apply() },
    )

    /** Main thread. */
    fun say(text: String, language: String) {
        if (text.isBlank()) return
        if (ready) return speak(text, language)
        waiting += text to language
        if (tts != null) return
        tts = TextToSpeech(context.applicationContext) { status ->
            if (status != TextToSpeech.SUCCESS) {
                AppLog.w(TAG, "text-to-speech unavailable: $status")
                tts?.shutdown()
                tts = null
                waiting.forEach { (t, l) -> deliver(t, l, planner.plan(l, null)) }
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

    /** Main thread. Releases the engine; queued texts are dropped. */
    fun shutdown() {
        tts?.let {
            runCatching { it.stop() }
            it.shutdown()
            AppLog.i(TAG, "text-to-speech released")
        }
        tts = null
        ready = false
        waiting.clear()
    }

    private fun speak(text: String, language: String) {
        val t = tts ?: return
        val locale = Locale.forLanguageTag(language)
        val available = t.isLanguageAvailable(locale)
        // Some engines say "available" and still refuse the voice: setLanguage has the last word.
        val result = if (available >= TextToSpeech.LANG_AVAILABLE) t.setLanguage(locale) else available
        deliver(text, language, planner.plan(language, result))
    }

    private fun deliver(text: String, language: String, plan: AlertPlanner.Plan) {
        when (plan) {
            AlertPlanner.Plan.Speak -> {
                tts?.speak(text, TextToSpeech.QUEUE_ADD, null, "cmc-${System.nanoTime()}")
                AppLog.i(TAG, "announce: $text")
            }
            is AlertPlanner.Plan.Notify -> {
                AppLog.w(TAG, "no text-to-speech voice for $language (${plan.reason}): showing the alert instead")
                notifyAlert(text)
                if (plan.hint) notifyHint(language, plan.reason)
            }
        }
    }

    private fun notifyAlert(text: String) {
        val nm = context.getSystemService(NotificationManager::class.java)
        ensureChannel(nm)
        val n = Notification.Builder(context, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_stat_claude)
            .setContentTitle("CallMeClaude")
            .setContentText(text)
            .setContentIntent(openApp())
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_STATUS)
            .build()
        nm.notify(ALERT_ID, n)
    }

    private fun notifyHint(language: String, reason: AlertPlanner.Reason) {
        val nm = context.getSystemService(NotificationManager::class.java)
        ensureChannel(nm)
        val name = Locale.forLanguageTag(language).getDisplayLanguage(Locale.ENGLISH).ifEmpty { language }
        val title = if (reason == AlertPlanner.Reason.NO_ENGINE) "No text-to-speech engine" else "No $name voice for spoken alerts"
        val text = "Settings › General management › Text-to-speech: pick the preferred engine, open its settings " +
            "and install the $name voice data. Until then alerts appear as notifications."
        val n = Notification.Builder(context, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_stat_claude)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(installVoice())
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .build()
        nm.notify(HINT_ID, n)
    }

    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        context, 0,
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    /** The engine's own "install voice data" screen if it has one, else the system text-to-speech settings. */
    private fun installVoice(): PendingIntent {
        val install = Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val target = if (install.resolveActivity(context.packageManager) != null) install
        else Intent("com.android.settings.TTS_SETTINGS").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return PendingIntent.getActivity(context, 1, target, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun ensureChannel(nm: NotificationManager) {
        // Default importance: the system's short notification sound, no heads-up ring.
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ALERTS, "Spoken alerts", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "\"Task complete\" alerts, shown here when the phone has no voice for the language."
            },
        )
    }

    private companion object {
        const val TAG = "cmc.speak"
        const val PREFS = "speech"
        const val HINT_PREFIX = "hint."
        const val CHANNEL_ALERTS = "alerts"
        const val ALERT_ID = 20
        const val HINT_ID = 21
    }
}
