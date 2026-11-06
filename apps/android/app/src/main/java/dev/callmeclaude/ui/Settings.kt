package dev.callmeclaude.ui

import android.text.format.DateFormat
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.foundation.BorderStroke
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.callmeclaude.HubClient
import dev.callmeclaude.warnings
import java.util.Date

/** Where the spoken "task complete" alert plays; same words as the desktop app and iOS. */
val doneAlerts = listOf("phone" to "On this phone", "computer" to "On the computer", "off" to "Off")

/** Voice languages (BCP-47), same list as iOS. The app UI stays in English; this is what Claude speaks on calls. */
val languages = listOf(
    "en-US" to "English (US)", "en-GB" to "English (UK)", "tr-TR" to "Türkçe", "de-DE" to "Deutsch",
    "fr-FR" to "Français", "es-ES" to "Español", "it-IT" to "Italiano", "pt-BR" to "Português (Brasil)",
    "nl-NL" to "Nederlands", "pl-PL" to "Polski", "ru-RU" to "Русский", "ar-SA" to "العربية",
    "hi-IN" to "हिन्दी", "ja-JP" to "日本語", "ko-KR" to "한국어", "zh-CN" to "中文 (简体)",
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(hub: HubClient, onDone: () -> Unit) {
    val snapshot by hub.snapshot.collectAsStateWithLifecycle()
    val pairing by hub.pairing.collectAsStateWithLifecycle()
    val connected by hub.connected.collectAsStateWithLifecycle()
    val lastSeen by hub.lastSeen.collectAsStateWithLifecycle()
    val status by hub.status.collectAsStateWithLifecycle()
    val localNetwork = rememberLocalNetworkState(recheckKey = status, onGranted = { hub.ensureConnected() })
    val health = rememberHealth(hub, localNetwork)
    val problems = warnings(health.health)
    var confirmUnpair by remember { mutableStateOf(false) }
    var languageMenu by remember { mutableStateOf(false) }
    var alertMenu by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val uri = LocalUriHandler.current
    val appVersion = remember {
        runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() ?: "—"
    }

    Scaffold(
        containerColor = Palette.bg,
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                actions = { TextButton(onClick = onDone) { Text("Done") } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.bg),
            )
        },
    ) { inner ->
        Column(
            verticalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.padding(inner).fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        ) {
            SectionTitle("Computer")
            Card {
                Labeled("Name", pairing?.name ?: "—")
                Labeled("Status", if (connected) "Connected" else status)
                lastSeen?.let { Labeled("Last seen", DateFormat.getTimeFormat(context).format(Date(it))) }
                OutlinedButton(
                    onClick = { confirmUnpair = true },
                    border = BorderStroke(1.dp, Palette.red.copy(alpha = 0.6f)),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = Palette.red),
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Unpair this computer") }
            }
            Footer("Unpairing forgets this computer. To pair again, run cmc pair on it and scan the code.")

            SectionTitle("This phone")
            if (problems.isEmpty()) {
                Card { Text("Everything Claude needs to reach you is allowed.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            problems.forEach { w ->
                WarningCard(
                    w,
                    localNetwork = localNetwork,
                    onPairAgain = { hub.setPairing(null); onDone() },
                    onDismissBattery = null,
                )
            }
            if (isSamsung() && health.health.ignoringBatteryOptimizations) Footer(SAMSUNG_BATTERY_TEXT)

            SectionTitle("Conversation")
            Card {
                val code = snapshot?.language ?: "en-US"
                Box {
                    Row(Modifier.fillMaxWidth().clickable { languageMenu = true }.padding(vertical = 4.dp)) {
                        Text("Voice language", modifier = Modifier.weight(1f))
                        Text(languages.firstOrNull { it.first == code }?.second ?: code, color = Palette.accent)
                    }
                    DropdownMenu(expanded = languageMenu, onDismissRequest = { languageMenu = false }) {
                        languages.forEach { (c, name) ->
                            DropdownMenuItem(
                                text = { Text(name) },
                                onClick = { languageMenu = false; hub.setLanguage(c) },
                            )
                        }
                    }
                }
            }
            Footer("Claude speaks this language on calls and writes session summaries in it. Takes full effect from the next call.")

            snapshot?.doneAlert?.let { current ->
                SectionTitle("When a session finishes")
                Card {
                    Box {
                        Row(Modifier.fillMaxWidth().clickable { alertMenu = true }.padding(vertical = 4.dp)) {
                            Text("Spoken alert", modifier = Modifier.weight(1f))
                            Text(doneAlerts.firstOrNull { it.first == current }?.second ?: current, color = Palette.accent)
                        }
                        DropdownMenu(expanded = alertMenu, onDismissRequest = { alertMenu = false }) {
                            doneAlerts.forEach { (id, name) ->
                                DropdownMenuItem(text = { Text(name) }, onClick = { alertMenu = false; hub.setDoneAlert(id) })
                            }
                        }
                    }
                }
                Footer("Says \"<project>: task complete.\" in the voice language when a Claude Code session finishes. On this phone it plays through your headset or intercom when one is connected.")
            }

            SectionTitle("About")
            Card {
                Labeled("App version", appVersion)
                Labeled("Hub version", snapshot?.hubVersion?.ifEmpty { null } ?: "—")
                TextButton(onClick = { uri.openUri("https://github.com/wutlu/callmeclaude") }) { Text("Source code (MIT)") }
            }
        }
    }

    if (confirmUnpair) {
        AlertDialog(
            onDismissRequest = { confirmUnpair = false },
            title = { Text("Unpair this computer?") },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmUnpair = false
                        hub.setPairing(null)
                        onDone()
                    },
                    colors = ButtonDefaults.textButtonColors(contentColor = Palette.red),
                ) { Text("Unpair") }
            },
            dismissButton = { TextButton(onClick = { confirmUnpair = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 4.dp, top = 12.dp),
    )
}

@Composable
private fun Footer(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 4.dp),
    )
}

@Composable
private fun Labeled(label: String, value: String, valueColor: Color = MaterialTheme.colorScheme.onSurfaceVariant) {
    Row(Modifier.fillMaxWidth()) {
        Text(label, modifier = Modifier.weight(1f))
        Text(value, color = valueColor)
    }
}
