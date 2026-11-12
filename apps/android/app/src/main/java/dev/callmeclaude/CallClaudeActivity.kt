package dev.callmeclaude

import android.Manifest
import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import dev.callmeclaude.calls.CallActivity

/**
 * Invisible trampoline behind every quick way to call: the app shortcut, the quick settings tile
 * and the optional "Call Claude" launcher entry. It decides with
 * [decideQuickCall] and finishes at once. The call goes through [dev.callmeclaude.calls.CallManager.placeCall],
 * the same path as the home screen button.
 *
 * Shown over the lock screen so the tile can call without unlocking; anything that needs the app
 * itself (pairing, the microphone prompt) asks for the unlock first.
 */
class CallClaudeActivity : Activity() {
    private val app get() = application as CallMeClaudeApp

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val hub = app.hub
        val calls = app.calls
        val paired = hub.pairing.value != null
        val call = calls.ui.value
        val decision = decideQuickCall(
            paired = paired,
            callLive = call != null && call.error == null,
            micGranted = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED,
            connected = hub.connected.value,
        )
        AppLog.i(TAG, "quick call (${intent?.action ?: "-"}): $decision")
        // Paired → the foreground service must run, as MainActivity ensures; the app may have been
        // fully stopped. Allowed here because this activity is in the foreground.
        if (paired) HubService.sync(this, true)
        // Started from the lock screen (tile): make sure the hub knows before the call starts.
        app.lock.check("quick call")
        when (decision) {
            QuickCall.OPEN_PAIRING -> openApp(Intent(this, MainActivity::class.java))
            QuickCall.ASK_MICROPHONE -> openApp(Intent(this, MainActivity::class.java).setAction(ACTION_CALL_CLAUDE))
            QuickCall.SHOW_CALL -> showCall()
            QuickCall.PLACE_CALL -> {
                calls.placeCall()
                showCall()
            }
        }
    }

    private fun showCall() {
        // CallActivity finishes itself when there is no call (e.g. Telecom refused it).
        startActivity(
            Intent(this, CallActivity::class.java)
                .setAction(Intent.ACTION_MAIN)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        )
        finish()
    }

    /** MainActivity isn't shown over the lock screen: ask for the unlock first, then open it. */
    private fun openApp(target: Intent) {
        target.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val keyguard = getSystemService(KeyguardManager::class.java)
        if (!keyguard.isKeyguardLocked) {
            startActivity(target)
            finish()
            return
        }
        keyguard.requestDismissKeyguard(
            this,
            object : KeyguardManager.KeyguardDismissCallback() {
                override fun onDismissSucceeded() {
                    startActivity(target)
                    finish()
                }

                override fun onDismissCancelled() = finish()
                override fun onDismissError() = finish()
            },
        )
    }

    companion object {
        private const val TAG = "cmc.quick"

        fun intent(context: Context): Intent =
            Intent(context, CallClaudeActivity::class.java).setAction(ACTION_CALL_CLAUDE)
    }
}
