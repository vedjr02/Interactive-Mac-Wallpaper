// caldump — print calendar events as JSON, without launching Calendar.app
//
// Scripting Calendar.app sends it an Apple Event, which launches the app if
// it isn't already running. EventKit reads the same store directly, so the
// app is never involved. It also expands recurring events for us, including
// the exceptions Calendar.app's scripting interface won't reveal.
//
//   swiftc -O caldump.swift -o caldump
//   ./caldump [daysBack] [daysForward]

import EventKit
import Foundation

let store = EKEventStore()
let gate = DispatchSemaphore(value: 0)
var granted = false

if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents { ok, _ in granted = ok; gate.signal() }
} else {
    store.requestAccess(to: .event) { ok, _ in granted = ok; gate.signal() }
}
gate.wait()

guard granted else {
    FileHandle.standardError.write(Data("calendar access not granted\n".utf8))
    exit(2)
}

let args = CommandLine.arguments
let back = args.count > 1 ? Int(args[1]) ?? 1 : 1
let fwd = args.count > 2 ? Int(args[2]) ?? 9 : 9

let cal = Calendar.current
let today = cal.startOfDay(for: Date())
guard let from = cal.date(byAdding: .day, value: -back, to: today),
      let to = cal.date(byAdding: .day, value: fwd + 1, to: today) else { exit(3) }

// events(matching:) expands recurrence for us, exceptions and all
let found = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: nil))

let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime]

struct Row: Encodable {
    let id: String
    let title: String
    let location: String
    let allDay: Bool
    let start: String
    let end: String
    let calendar: String
}

let rows = found.map { e -> Row in
    let start = e.startDate ?? Date()
    return Row(
        id: "\(e.calendarItemIdentifier)-\(Int(start.timeIntervalSince1970))",
        title: e.title ?? "(no title)",
        location: e.location ?? "",
        allDay: e.isAllDay,
        start: iso.string(from: start),
        end: iso.string(from: e.endDate ?? start),
        calendar: e.calendar?.title ?? ""
    )
}

FileHandle.standardOutput.write(try JSONEncoder().encode(rows))
