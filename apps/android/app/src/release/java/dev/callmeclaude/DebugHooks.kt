package dev.callmeclaude

import android.content.Context
import android.content.Intent

/** Release builds never accept pairing from an intent extra. See src/debug. */
object DebugHooks {
    @Suppress("UNUSED_PARAMETER", "FunctionOnlyReturningConstant")
    fun pairingText(intent: Intent?): String? = null

    @Suppress("UNUSED_PARAMETER")
    fun probeSpeech(context: Context, intent: Intent?) = Unit
}
