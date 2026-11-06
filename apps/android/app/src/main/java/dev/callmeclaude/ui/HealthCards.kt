package dev.callmeclaude.ui

import android.annotation.SuppressLint
import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.callmeclaude.HubClient
import dev.callmeclaude.Health
import dev.callmeclaude.LOCAL_NETWORK_RATIONALE
import dev.callmeclaude.Warning
import dev.callmeclaude.calls.CallNotifications

/** Platform state behind the warning cards, re-read on every resume (the user comes back from Settings). */
class HealthState(val health: Health, val dismissBattery: () -> Unit)

@Suppress("UseKtx") // core-ktx is not a dependency
@Composable
fun rememberHealth(hub: HubClient, localNetwork: LocalNetworkState): HealthState {
    val context = LocalContext.current
    val connected by hub.connected.collectAsStateWithLifecycle()
    val invalid by hub.pairingInvalid.collectAsStateWithLifecycle()
    val unreachable by hub.unreachable.collectAsStateWithLifecycle()
    var resumes by remember { mutableIntStateOf(0) }
    LifecycleResumeEffect(Unit) {
        resumes++
        onPauseOrDispose {}
    }
    val prefs = remember { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }
    var dismissed by remember { mutableStateOf(prefs.getBoolean(KEY_BATTERY_DISMISSED, false)) }
    val platform = remember(resumes) { PlatformChecks.read(context) }
    return HealthState(
        health = Health(
            pairingInvalid = invalid,
            connected = connected,
            unreachable = unreachable,
            localNetwork = localNetwork.access,
            notificationsEnabled = platform.notifications,
            fullScreenIntentAllowed = platform.fullScreenIntent,
            ignoringBatteryOptimizations = platform.battery,
            batteryCardDismissed = dismissed,
        ),
        dismissBattery = {
            dismissed = true
            prefs.edit().putBoolean(KEY_BATTERY_DISMISSED, true).apply()
        },
    )
}

private const val PREFS = "ui"
private const val KEY_BATTERY_DISMISSED = "battery_card_dismissed"

@Suppress("UseKtx") // core-ktx is not a dependency
object PlatformChecks {
    data class State(val notifications: Boolean, val fullScreenIntent: Boolean, val battery: Boolean)

    fun read(context: Context) = State(
        notifications = context.getSystemService(NotificationManager::class.java).areNotificationsEnabled(),
        fullScreenIntent = CallNotifications.canUseFullScreenIntent(context),
        battery = isIgnoringBatteryOptimizations(context),
    )

    fun isIgnoringBatteryOptimizations(context: Context): Boolean =
        context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)

    /**
     * The system "Stop optimising battery usage?" dialog: one tap, and it is the exemption the
     * background-start rules check. The settings list (several taps, and the user has to find the
     * app) is only the fallback when a ROM doesn't handle the request.
     */
    @SuppressLint("BatteryLife") // the hub can only ring us over our own socket: no FCM to fall back on
    fun requestBatteryExemption(context: Context) {
        val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
        if (!start(context, direct)) start(context, Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
    }

    fun openFullScreenIntentSettings(context: Context) {
        val ok = Build.VERSION.SDK_INT >= 34 &&
            start(context, Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${context.packageName}")))
        if (!ok) openNotificationSettings(context)
    }

    fun openNotificationSettings(context: Context) {
        val i = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        if (!start(context, i)) openAppSettings(context)
    }

    private fun start(context: Context, i: Intent): Boolean = try {
        context.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
    } catch (_: ActivityNotFoundException) {
        false
    }
}

const val BATTERY_TEXT =
    "Android may pause CallMeClaude in the background to save battery, and then Claude can't call you. " +
        "Let it run unrestricted."
const val SAMSUNG_BATTERY_TEXT =
    "On Samsung phones also check Settings › Battery › Background usage limits: CallMeClaude must not be " +
        "under Sleeping apps or Deep sleeping apps. Adding it to Never sleeping apps is safest."
const val FULL_SCREEN_TEXT =
    "Calls ring over the lock screen only with the full-screen notifications permission. Without it a call " +
        "shows up as a notification you might miss."

/** One card per [Warning]. [onPairAgain] forgets the pairing and goes back to the QR screen. */
@Composable
fun WarningCard(
    w: Warning,
    localNetwork: LocalNetworkState?,
    onPairAgain: () -> Unit,
    onDismissBattery: (() -> Unit)?,
) {
    val context = LocalContext.current
    when (w) {
        Warning.PAIRING_INVALID -> WarningBox(
            "Pairing is no longer valid",
            "Your computer no longer accepts this phone's pairing (its token changed or it was reset). " +
                "Run cmc pair on the computer and scan the new code.",
            tint = Palette.red,
        ) { Button(onClick = onPairAgain) { Text("Pair again") } }

        Warning.LOCAL_NETWORK -> {
            val canAsk = localNetwork?.access == dev.callmeclaude.LocalNetworkAccess.DENIED
            WarningBox(
                "Local network access needed",
                LOCAL_NETWORK_RATIONALE + if (canAsk) "" else " Turn on Nearby devices in the app settings.",
            ) {
                if (canAsk) Button(onClick = localNetwork.request) { Text("Allow") }
                OutlinedButton(onClick = { openAppSettings(context) }) { Text("Open settings") }
            }
        }

        Warning.UNREACHABLE -> WarningBox(
            "Can't reach your computer",
            "Please try pairing again: run cmc pair on the computer and scan the new code. " +
                "Your sessions and settings stay as they are.",
        ) { Button(onClick = onPairAgain) { Text("Pair again") } }

        Warning.NOTIFICATIONS -> WarningBox(
            "Notifications are off",
            "Incoming calls and the connection status are notifications. Without them a call can't ring.",
        ) { Button(onClick = { PlatformChecks.openNotificationSettings(context) }) { Text("Turn on") } }

        Warning.FULL_SCREEN_INTENT -> WarningBox("Calls can't fill the lock screen", FULL_SCREEN_TEXT) {
            Button(onClick = { PlatformChecks.openFullScreenIntentSettings(context) }) { Text("Allow") }
        }

        Warning.BATTERY -> WarningBox(
            "Battery optimisation is on",
            BATTERY_TEXT + if (isSamsung()) "\n\n" + SAMSUNG_BATTERY_TEXT else "",
        ) {
            Button(onClick = { PlatformChecks.requestBatteryExemption(context) }) { Text("Allow") }
            if (onDismissBattery != null) TextButton(onClick = onDismissBattery) { Text("Not now") }
        }
    }
}

fun isSamsung(): Boolean = Build.MANUFACTURER.equals("samsung", ignoreCase = true)

@Composable
private fun WarningBox(
    title: String,
    text: String,
    tint: androidx.compose.ui.graphics.Color = Palette.orange,
    actions: @Composable () -> Unit,
) {
    Card(tint = tint) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Dot(tint, 8)
            Spacer(Modifier.width(8.dp))
            Text(title, style = MaterialTheme.typography.titleSmall)
        }
        Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { actions() }
    }
}
