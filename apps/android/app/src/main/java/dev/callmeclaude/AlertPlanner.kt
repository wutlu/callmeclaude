package dev.callmeclaude

/**
 * Decides how one spoken alert ("acme: görev tamamlandı.") reaches the user. Pure.
 *
 * Text-to-speech reports per language (TextToSpeech.isLanguageAvailable / setLanguage):
 * >= 0 the voice is there; -1 its data is missing; -2 the engine doesn't support the language.
 * Reading Turkish text with an English voice is unintelligible, so a missing voice never falls
 * back to the default one: the alert becomes a notification with a short sound, and the first
 * time for each language a second notification says how to install the voice.
 */
class AlertPlanner(
    private val hintShown: (language: String) -> Boolean,
    private val rememberHint: (language: String) -> Unit,
) {
    sealed interface Plan {
        data object Speak : Plan

        /** Notification + sound instead of speech; [hint] = also show (once) how to get the voice. */
        data class Notify(val hint: Boolean, val reason: Reason) : Plan
    }

    enum class Reason { MISSING_DATA, NOT_SUPPORTED, NO_ENGINE }

    /** [availability] is the engine's answer for [language], or null if text-to-speech could not start. */
    fun plan(language: String, availability: Int?): Plan {
        if (availability != null && availability >= LANG_AVAILABLE) return Plan.Speak
        val reason = when (availability) {
            null -> Reason.NO_ENGINE
            LANG_MISSING_DATA -> Reason.MISSING_DATA
            else -> Reason.NOT_SUPPORTED
        }
        val key = key(language)
        val hint = !hintShown(key)
        if (hint) rememberHint(key)
        return Plan.Notify(hint, reason)
    }

    companion object {
        // Same values as TextToSpeech.LANG_*; repeated so the planner stays free of android.*.
        const val LANG_AVAILABLE = 0
        const val LANG_MISSING_DATA = -1

        /** One hint per language, not per region ("tr-TR" and "tr" share it). */
        fun key(language: String): String = language.substringBefore('-').lowercase().ifEmpty { "und" }
    }
}
