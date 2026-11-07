package dev.callmeclaude.ui

import java.time.Duration
import java.time.Instant
import java.time.format.DateTimeParseException

/** Session state labels, same as `SessionStateUI.label` on iOS. */
fun stateLabel(s: String): String = when (s) {
    "running" -> "Working"
    "waiting_permission" -> "Needs permission"
    "waiting_input" -> "Waiting for you"
    "blocked" -> "Stuck"
    "done" -> "Done"
    "errored" -> "Error"
    "stale" -> "Quiet"
    "ended" -> "Closed"
    else -> s
}

/**
 * English short relative time ("5 min. ago"), like iOS's RelativeDateTimeFormatter(.short, en_US).
 * Timestamps come from the computer's clock; a slightly-ahead clock must not read "in 1 sec.".
 */
fun relative(iso: String, now: Instant = Instant.now()): String {
    val t = try {
        Instant.parse(iso)
    } catch (_: DateTimeParseException) {
        return ""
    }
    val a = Duration.between(t, now).seconds.coerceAtLeast(0)
    val (n, unit) = when {
        a < 60 -> a to "sec."
        a < 3_600 -> a / 60 to "min."
        a < 86_400 -> a / 3_600 to "hr."
        a < 7 * 86_400 -> (a / 86_400).let { it to if (it == 1L) "day" else "days" }
        else -> (a / (7 * 86_400)).let { it to "wk." }
    }
    return "$n $unit ago"
}

private val NEEDS_YOU = setOf("waiting_permission", "waiting_input", "blocked", "errored")

/** Finished or quiet sessions older than this fold under "Earlier" (same as the desktop panel). */
const val EARLIER_SECONDS = 6 * 3_600L

/** Sessions that need you first, then working ones, then the rest, newest first; old finished ones go to `earlier`. */
fun <T> orderSessions(list: List<T>, state: (T) -> String, updatedAt: (T) -> String, now: Instant = Instant.now()): Pair<List<T>, List<T>> {
    fun rank(s: T) = when (state(s)) {
        in NEEDS_YOU -> 0
        "running" -> 1
        else -> 2
    }
    val sorted = list.sortedWith(compareBy<T> { rank(it) }.thenByDescending { updatedAt(it) })
    fun old(s: T): Boolean {
        val t = try { Instant.parse(updatedAt(s)) } catch (_: DateTimeParseException) { return false }
        return rank(s) == 2 && Duration.between(t, now).seconds > EARLIER_SECONDS
    }
    return sorted.filterNot(::old) to sorted.filter(::old)
}

/** "24 min" left on a held decision; when it runs out the decision goes back to the computer. */
fun timeLeft(deadline: String, now: Instant = Instant.now()): String {
    val t = try { Instant.parse(deadline) } catch (_: DateTimeParseException) { return "" }
    val s = Duration.between(now, t).seconds.coerceAtLeast(0)
    return if (s >= 60) "${(s + 59) / 60} min" else "$s s"
}
