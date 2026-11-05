package dev.callmeclaude

import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build

/**
 * Tells the hub whether the secure lock screen is up. While it is, anyone holding the phone can
 * talk to Claude (the quick settings tile calls over the lock screen), so the hub only lets them
 * ask, not change anything. No PIN/pattern set = never "locked": the lock screen protects nothing.
 *
 * Screen off counts as locked right away (the keyguard may only engage a few seconds later);
 * "user present" (unlocked) and screen on re-read the keyguard.
 */
class LockWatcher(private val context: Context, private val onChange: (Boolean) -> Unit) {
    private val keyguard = context.getSystemService(KeyguardManager::class.java)

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
            onChange(
                when (intent.action) {
                    Intent.ACTION_SCREEN_OFF -> keyguard.isDeviceSecure
                    Intent.ACTION_USER_PRESENT -> false
                    else -> lockedNow()
                },
            )
        }
    }

    fun lockedNow(): Boolean = keyguard.isDeviceSecure && keyguard.isKeyguardLocked

    fun start() {
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        // System broadcasts only; other apps can't send these to us.
        if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        else context.registerReceiver(receiver, filter)
        onChange(lockedNow())
    }

    fun stop() {
        runCatching { context.unregisterReceiver(receiver) }
    }
}
