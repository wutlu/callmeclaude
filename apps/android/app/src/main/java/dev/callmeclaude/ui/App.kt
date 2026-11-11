package dev.callmeclaude.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.flowWithLifecycle
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.filterNotNull
import androidx.compose.foundation.clickable
import dev.callmeclaude.ACCESS_LOCAL_NETWORK
import dev.callmeclaude.Decision
import dev.callmeclaude.HubClient
import dev.callmeclaude.PendingCard
import dev.callmeclaude.SessionCard
import dev.callmeclaude.calls.CallManager
import dev.callmeclaude.homeWarnings

@Composable
fun App(hub: HubClient, calls: CallManager, callRequest: MutableStateFlow<Boolean>) {
    CmcTheme {
        val pairing by hub.pairing.collectAsStateWithLifecycle()
        val call by calls.ui.collectAsStateWithLifecycle()
        var showSettings by rememberSaveable { mutableStateOf(false) }
        when {
            call != null -> CallScreen(calls)
            pairing == null -> PairingScreen(hub)
            showSettings -> {
                BackHandler { showSettings = false }
                SettingsScreen(hub, onDone = { showSettings = false })
            }
            else -> HomeScreen(hub, calls, callRequest, onSettings = { showSettings = true })
        }
    }
}

// region Home

private data class ModeOption(val id: String, val label: String, val hint: String)

private val modes = listOf(
    ModeOption("desk", "Desk", "At the computer. No calls."),
    ModeOption("away", "Away", "Calls when a session is stuck or done."),
    ModeOption("ride", "Ride", "Like Away, extra short sentences."),
    ModeOption("sleep", "Sleep", "Emergencies only."),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HomeScreen(hub: HubClient, calls: CallManager, callRequest: MutableStateFlow<Boolean>, onSettings: () -> Unit) {
    val connected by hub.connected.collectAsStateWithLifecycle()
    val snapshot by hub.snapshot.collectAsStateWithLifecycle()
    val status by hub.status.collectAsStateWithLifecycle()
    val pairing by hub.pairing.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    var confirmPanic by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }

    val localNetwork = rememberLocalNetworkState(recheckKey = status, onGranted = { hub.ensureConnected() })
    AskCallPermissionsOnce { results -> results[ACCESS_LOCAL_NETWORK]?.let(localNetwork.onResult) }
    val health = rememberHealth(hub, localNetwork)
    val cards = homeWarnings(health.health)
    val context = LocalContext.current
    // "Call Claude" needs the microphone; ask first if it's missing, then place the call anyway
    // (without it the hub still gets silence frames and the call stays up).
    val micLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { calls.placeCall() }
    val placeCall = {
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) calls.placeCall()
        else micLauncher.launch(Manifest.permission.RECORD_AUDIO)
    }
    // A shortcut / tile / launcher entry that found the microphone missing: same as tapping the button.
    val requested by callRequest.collectAsStateWithLifecycle()
    LaunchedEffect(requested) {
        if (requested) {
            callRequest.value = false
            placeCall()
        }
    }

    val sessions = snapshot?.sessions.orEmpty()
    val pending = snapshot?.pending.orEmpty()
    val paused = snapshot?.paused == true
    val (recent, earlier) = remember(sessions) { orderSessions(sessions, { it.state }, { it.updatedAt }) }
    var showEarlier by rememberSaveable { mutableStateOf(false) }

    // Hub errors outside a call: shown as the hub sent them, once, then gone.
    // Collected only while the screen is visible, so a notice isn't consumed in the background.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle) {
        calls.notice.flowWithLifecycle(lifecycle).filterNotNull().collect { n ->
            calls.noticeShown(n.id)
            snackbar.showSnackbar(n.message, withDismissAction = true, duration = SnackbarDuration.Long)
        }
    }

    Scaffold(
        containerColor = Palette.bg,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = { Text("CallMeClaude", fontWeight = FontWeight.SemiBold) },
                actions = {
                    OutlinedButton(onClick = onSettings, modifier = Modifier.padding(end = 8.dp)) { Text("Settings") }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.bg),
            )
        },
    ) { inner ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                refreshing = true
                hub.ensureConnected { refreshing = false }
            },
            modifier = Modifier.padding(inner).fillMaxSize(),
        ) {
            LazyColumn(
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 32.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                item {
                    // Tapping the computer's name opens Settings (where Unpair lives), like the button.
                    ConnectionPill(
                        connected = connected,
                        text = if (connected) "Connected to ${pairing?.name ?: "computer"}" else status,
                        onClick = onSettings,
                    )
                }
                items(cards, key = { "w_" + it.name }) { w ->
                    WarningCard(
                        w,
                        localNetwork = localNetwork,
                        onPairAgain = { hub.setPairing(null) },
                        onDismissBattery = health.dismissBattery,
                    )
                }
                if (paused) item { PausedBanner(onResume = hub::resume) }
                // A held decision is why the app was opened: it comes first.
                if (pending.isNotEmpty()) {
                    item { SectionHeader("Needs your decision", pending.size) }
                    items(pending, key = { "p_" + it.id }) { p ->
                        PendingCardView(p, onDecision = { d, note -> hub.resolve(p.id, d, note) })
                    }
                }
                item { CallHero(onCall = placeCall, enabled = pairing != null) }
                item { ModePicker(current = snapshot?.mode ?: "away", onPick = hub::setMode) }
                item { SectionHeader("Sessions", sessions.size) }
                if (sessions.isEmpty()) {
                    item {
                        Card {
                            Text(
                                if (connected) "No open Claude Code sessions." else "Waiting for your computer…",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
                items(recent, key = { "s_" + it.id }) { SessionCardView(it) }
                if (earlier.isNotEmpty()) {
                    item(key = "earlier") {
                        TextButton(onClick = { showEarlier = !showEarlier }) {
                            Text(if (showEarlier) "Hide earlier" else "Earlier (${earlier.size})", color = Palette.accent)
                        }
                    }
                    if (showEarlier) items(earlier, key = { "s_" + it.id }) { SessionCardView(it) }
                }
                if (!paused) {
                    item {
                        OutlinedButton(
                            onClick = { confirmPanic = true },
                            border = BorderStroke(1.dp, Palette.red.copy(alpha = 0.6f)),
                            colors = ButtonDefaults.outlinedButtonColors(contentColor = Palette.red),
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(top = 8.dp),
                        ) { Text("Stop everything") }
                    }
                }
            }
        }
    }

    if (confirmPanic) {
        AlertDialog(
            onDismissRequest = { confirmPanic = false },
            title = { Text("Interrupt all sessions and pause automation?") },
            confirmButton = {
                TextButton(
                    onClick = { confirmPanic = false; hub.panic() },
                    colors = ButtonDefaults.textButtonColors(contentColor = Palette.red),
                ) { Text("Stop everything") }
            },
            dismissButton = { TextButton(onClick = { confirmPanic = false }) { Text("Cancel") } },
        )
    }
}

@Composable
fun Card(tint: Color? = null, onClick: (() -> Unit)? = null, content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(16.dp)
    Column(
        verticalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .background(Palette.card, shape)
            .border(1.dp, tint?.copy(alpha = 0.6f) ?: Palette.stroke, shape)
            .padding(14.dp),
        content = content,
    )
}

@Composable
private fun ConnectionPill(connected: Boolean, text: String, onClick: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .background(Palette.card, CircleShape)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Dot(if (connected) Palette.green else Palette.red, 8)
        Spacer(Modifier.width(8.dp))
        Text(
            text,
            style = MaterialTheme.typography.labelLarge,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Text("›", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
internal fun Dot(color: Color, size: Int) {
    Box(Modifier.size(size.dp).background(color, CircleShape))
}

@Composable
private fun ModePicker(current: String, onPick: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            modes.forEach { m ->
                val selected = current == m.id
                val shape = RoundedCornerShape(12.dp)
                TextButton(
                    onClick = { onPick(m.id) },
                    shape = shape,
                    colors = ButtonDefaults.textButtonColors(
                        containerColor = if (selected) Palette.accent.copy(alpha = 0.22f) else Palette.card,
                        contentColor = if (selected) Palette.accent else MaterialTheme.colorScheme.onSurface,
                    ),
                    border = BorderStroke(1.dp, if (selected) Palette.accent else Palette.stroke),
                    modifier = Modifier.weight(1f).heightIn(min = 52.dp),
                ) { Text(m.label, fontWeight = FontWeight.Medium) }
            }
        }
        Text(
            modes.firstOrNull { it.id == current }?.hint.orEmpty(),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 4.dp),
        )
    }
}

@Composable
private fun PausedBanner(onResume: () -> Unit) {
    Card(tint = Palette.orange) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Automation paused", style = MaterialTheme.typography.titleSmall)
                Text(
                    "Nothing is approved or held automatically.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Button(onClick = onResume) { Text("Resume") }
        }
    }
}

@Composable
private fun SectionHeader(title: String, count: Int) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        if (count > 0) {
            Spacer(Modifier.width(8.dp))
            Text(
                "$count",
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.background(Palette.card, CircleShape).padding(horizontal = 7.dp, vertical = 2.dp),
            )
        }
    }
}

@Composable
private fun SessionCardView(s: SessionCard) {
    var open by rememberSaveable(s.id) { mutableStateOf(false) }
    Card(onClick = { open = !open }) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Dot(Palette.state(s.state), 10)
            Spacer(Modifier.width(8.dp))
            Text(
                s.project,
                style = MaterialTheme.typography.titleSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Text(stateLabel(s.state), style = MaterialTheme.typography.labelMedium, color = Palette.state(s.state))
        }
        Text(
            s.summary,
            style = MaterialTheme.typography.bodyMedium,
            color = if (open) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = if (open) Int.MAX_VALUE else 3,
            overflow = TextOverflow.Ellipsis,
        )
        if (s.subagents.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                s.subagents.take(6).forEach { a ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Dot(if (a.state == "running") Palette.accent else Palette.gray, 6)
                        Spacer(Modifier.width(6.dp))
                        Text(a.type, style = MaterialTheme.typography.labelMedium)
                        Spacer(Modifier.width(6.dp))
                        Text(if (a.state == "running") "working" else "done", style = MaterialTheme.typography.labelSmall, color = Palette.gray)
                        a.summary?.let {
                            Spacer(Modifier.width(6.dp))
                            Text(
                                it,
                                style = MaterialTheme.typography.labelSmall,
                                color = Palette.gray,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
        }
        Text(relative(s.updatedAt), style = MaterialTheme.typography.labelSmall, color = Palette.gray)
    }
}

@Composable
private fun PendingCardView(p: PendingCard, onDecision: (Decision, String?) -> Unit) {
    val hot = p.risk == "high" || p.risk == "critical"
    val ask = p.kind == "permission"
    Card(tint = if (hot) Palette.red else Palette.orange) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(p.project, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
            Text(
                if (ask) p.risk.uppercase() else "QUESTION",
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(if (hot) Palette.red.copy(alpha = 0.3f) else Palette.card, CircleShape)
                    .padding(horizontal = 7.dp, vertical = 3.dp),
            )
        }
        Text(p.summary, style = MaterialTheme.typography.bodyMedium)
        Text(
            "Waits ${timeLeft(p.deadline)} more, then goes back to the computer.",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (ask) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = { onDecision(Decision.APPROVE, null) },
                    colors = ButtonDefaults.buttonColors(containerColor = Palette.green, contentColor = Color.White),
                ) { Text("Approve") }
                OutlinedButton(onClick = { onDecision(Decision.DENY, null) }) { Text("Deny") }
                OutlinedButton(onClick = { onDecision(Decision.RELEASE, null) }) { Text("Let it stop") }
            }
        } else {
            // The session asked something or finished: it needs words, not a bare yes.
            var reply by rememberSaveable(p.id) { mutableStateOf("") }
            OutlinedTextField(
                value = reply,
                onValueChange = { reply = it },
                placeholder = { Text("Reply to Claude…") },
                maxLines = 4,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { if (reply.isNotBlank()) onDecision(Decision.APPROVE, reply.trim()) }),
                modifier = Modifier.fillMaxWidth(),
            )
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = { onDecision(Decision.APPROVE, reply.trim()) },
                    enabled = reply.isNotBlank(),
                    colors = ButtonDefaults.buttonColors(containerColor = Palette.accent, contentColor = Color.White),
                ) { Text("Send") }
                OutlinedButton(onClick = { onDecision(Decision.RELEASE, null) }) { Text("Let it stop") }
            }
        }
    }
}

// endregion
