package dev.callmeclaude

import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock

/**
 * Tells the hub whether the secure lock screen is up. While it is, anyone holding the phone can
 * talk to Claude (the quick settings tile calls over the lock screen), so the hub only lets them
 * ask, not change anything. No PIN/pattern set = never "locked": the lock screen protects nothing.
 *
 * Owned by the Application, so it watches for as long as the process lives (not only while
 * [HubService] runs) and starts again with every new process. The rules are in [LockSignals].
 */
class LockWatcher(context: Context, onChange: (locked: Boolean, why: String) -> Unit) {
    private val context = context.applicationContext
    private val keyguard = context.getSystemService(KeyguardManager::class.java)
    private val power = context.getSystemService(PowerManager::class.java)
    private val main = Handler(Looper.getMainLooper())

    private val signals = LockSignals(
        secure = { keyguard.isDeviceSecure },
        keyguardLocked = { keyguard.isKeyguardLocked },
        interactive = { power.isInteractive },
        now = SystemClock::elapsedRealtime,
        schedule = { ms, block -> main.postDelayed(block, ms) },
        report = onChange,
    )

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
            when (intent.action) {
                Intent.ACTION_SCREEN_OFF -> signals.screenOff()
                Intent.ACTION_USER_PRESENT -> signals.userPresent()
                Intent.ACTION_SCREEN_ON -> signals.screenOn()
            }
        }
    }

    /** Any thread: a fresh reading, e.g. for the hello of a new connection. */
    fun lockedNow(): Boolean = keyguard.isDeviceSecure && keyguard.isKeyguardLocked

    /** Main thread: re-read now (the app came to the foreground, …). */
    fun check(why: String) = signals.check(why)

    fun start() {
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        // EXPORTED on purpose. All three are protected broadcasts (only the system may send them),
        // so no other app can fake them. NOT_EXPORTED only lets in broadcasts from system_server and
        // from this app, and USER_PRESENT is sent by SystemUI under its own uid: with NOT_EXPORTED
        // it never arrived (seen on Android 17 / One UI), so an unlock was never reported.
        if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
        else context.registerReceiver(receiver, filter)
        signals.check("start")
    }
}
