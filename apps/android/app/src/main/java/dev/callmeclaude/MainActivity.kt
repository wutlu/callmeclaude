package dev.callmeclaude

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import dev.callmeclaude.ui.App
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.distinctUntilChangedBy
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val hub get() = (application as CallMeClaudeApp).hub

    /** A quick entry point asked for a call that needs the home screen first (microphone prompt). */
    private val callRequest = MutableStateFlow(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The app is dark-only (like iOS), so system bar icons stay light regardless of the system theme.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        if (savedInstanceState == null) {
            acceptDebugPairing(intent)
            acceptCallRequest(intent)
        }
        setContent { App(hub, (application as CallMeClaudeApp).calls, callRequest) }
        // Paired → keep the hub connection in the foreground service; unpaired → stop it.
        // Started from here because foreground services can't be started from the background.
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                hub.pairing.distinctUntilChangedBy { it != null }.collect { HubService.sync(this@MainActivity, it != null) }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        acceptDebugPairing(intent)
        acceptCallRequest(intent)
    }

    override fun onStart() {
        super.onStart()
        hub.setActive("ui", true)
        (application as CallMeClaudeApp).lock.check("app opened")
    }

    override fun onStop() {
        super.onStop()
        hub.setActive("ui", false)
    }

    /**
     * Sent by [CallClaudeActivity] when the microphone permission is missing: the home screen runs
     * its own "Call Claude" (ask, then call). Once only: not again from recents or a recreation.
     */
    private fun acceptCallRequest(intent: Intent?) {
        if (intent?.action != ACTION_CALL_CLAUDE) return
        if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        setIntent(Intent(intent).setAction(Intent.ACTION_MAIN))
        if (hub.pairing.value != null) callRequest.value = true
    }

    private fun acceptDebugPairing(intent: Intent?) {
        val text = DebugHooks.pairingText(intent) ?: return
        when (val r = PairingInfo.parse(text)) {
            is PairingResult.Ok -> hub.setPairing(r.info)
            is PairingResult.Invalid -> Toast.makeText(this, r.message, Toast.LENGTH_LONG).show()
        }
    }
}
