import AppKit
import Foundation
import UserNotifications

struct WatcherSnapshot: Codable {
  let watcher: String
  let watcherName: String
  let sourceUpdatedAt: String?
  let lastCheckedAt: String
  let error: String?
  let threads: [WatchedThread]
}

struct WatchedThread: Codable {
  let key: String
  let projectTitle: String
  let title: String
  let status: String
  let updatedAt: String
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let t3CodeURL = URL(fileURLWithPath: "/Applications/T3 Code (Nightly).app")
  private var streamTask: Task<Void, Never>?
  private var previousStatuses: [String: String] = [:]
  private var hasLoadedSnapshot = false
  private var snapshot: WatcherSnapshot?
  private let watcherURL: URL = {
    let configured = ProcessInfo.processInfo.environment["T3_WATCHER_URL"]
      ?? Bundle.main.object(forInfoDictionaryKey: "T3WatcherURL") as? String
      ?? "http://100.70.142.26:4173"
    return URL(string: configured)!
  }()

  func applicationDidFinishLaunching(_ notification: Notification) {
    configureStatusItem()
    UNUserNotificationCenter.current().delegate = self
    Self.requestNotificationPermission()
    connect()
  }

  func applicationWillTerminate(_ notification: Notification) {
    streamTask?.cancel()
  }

  private func configureStatusItem() {
    guard let button = statusItem.button else { return }
    button.image = WatcherMark.image()
    button.image?.accessibilityDescription = "T3 Watcher"
    button.imagePosition = .imageLeading
    button.imageScaling = .scaleProportionallyDown
    button.toolTip = "T3 Watcher"
    showConnecting()
  }

  private func showConnecting() {
    statusItem.button?.image = WatcherMark.image()
    statusItem.button?.attributedTitle = NSAttributedString(string: " …")
    let menu = NSMenu()
    menu.addItem(disabledItem("T3 Watcher"))
    menu.addItem(disabledItem("Connecting to mintbox…", color: .secondaryLabelColor))
    menu.addItem(.separator())
    menu.addItem(quitItem())
    statusItem.menu = menu
  }

  private func connect() {
    streamTask?.cancel()
    streamTask = Task { [weak self] in
      guard let self else { return }
      var delay: UInt64 = 1
      while !Task.isCancelled {
        do {
          try await self.consumeEvents()
          delay = 1
        } catch is CancellationError {
          return
        } catch {
          NSLog("T3 Watcher connection failed: %@", error.localizedDescription)
          self.showDisconnected(error.localizedDescription)
          try? await Task.sleep(for: .seconds(delay))
          delay = min(delay * 2, 30)
        }
      }
    }
  }

  private func consumeEvents() async throws {
    let eventsURL = watcherURL.appending(path: "api/events")
    let (bytes, response) = try await URLSession.shared.bytes(from: eventsURL)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
      throw URLError(.badServerResponse)
    }
    NSLog("T3 Watcher connected to %@", eventsURL.absoluteString)

    var eventBuffer = Data()
    for try await byte in bytes {
      try Task.checkCancellation()
      eventBuffer.append(byte)
      if eventBuffer.suffix(2) == Data([0x0A, 0x0A]) {
        if let block = String(data: eventBuffer, encoding: .utf8),
           let dataLine = block.split(separator: "\n").first(where: { $0.hasPrefix("data:") }) {
          let payload = dataLine.dropFirst(5).trimmingCharacters(in: .whitespaces)
          let decoded = try JSONDecoder().decode(WatcherSnapshot.self, from: Data(payload.utf8))
          apply(decoded)
        }
        eventBuffer.removeAll(keepingCapacity: true)
      }
    }
    throw URLError(.networkConnectionLost)
  }

  private func apply(_ next: WatcherSnapshot) {
    NSLog("T3 Watcher received %d unsettled threads", next.threads.count)
    UserDefaults.standard.set(next.threads.count, forKey: "lastThreadCount")
    UserDefaults.standard.set(Date(), forKey: "lastSnapshotAt")
    UserDefaults.standard.set(next.watcher, forKey: "lastWatcherState")
    notifyTransitions(in: next)
    snapshot = next
    render(next)
  }

  private func notifyTransitions(in next: WatcherSnapshot) {
    if hasLoadedSnapshot {
      for thread in next.threads where previousStatuses[thread.key] != thread.status {
        guard ["approval", "input", "plan_ready", "failed", "finished"].contains(thread.status) else {
          continue
        }
        let content = UNMutableNotificationContent()
        content.title = notificationTitle(for: thread.status)
        content.body = "\(thread.title) · \(thread.projectTitle)"
        content.sound = .default
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
      }
    }
    previousStatuses = Dictionary(uniqueKeysWithValues: next.threads.map { ($0.key, $0.status) })
    hasLoadedSnapshot = true
  }

  private func render(_ snapshot: WatcherSnapshot) {
    renderTitle(snapshot)
    let menu = NSMenu()
    menu.addItem(disabledItem("T3 Watcher"))
    let connection = snapshot.watcher == "live"
      ? "Live · \(snapshot.watcherName)"
      : "Unavailable · \(snapshot.watcherName)"
    menu.addItem(disabledItem(connection, color: snapshot.watcher == "live" ? .systemGreen : .systemOrange))
    if let error = snapshot.error, snapshot.watcher != "live" {
      menu.addItem(disabledItem(error, color: .systemRed))
    }

    addGroup(
      to: menu,
      title: "NEEDS YOU",
      statuses: ["approval", "input", "plan_ready", "failed"],
      snapshot: snapshot
    )
    addGroup(to: menu, title: "WORKING", statuses: ["starting", "running"], snapshot: snapshot)
    addGroup(to: menu, title: "FINISHED", statuses: ["finished"], snapshot: snapshot)
    addGroup(to: menu, title: "READY", statuses: ["ready"], snapshot: snapshot)

    if snapshot.threads.isEmpty {
      menu.addItem(.separator())
      menu.addItem(disabledItem("No unsettled threads", color: .secondaryLabelColor))
    }
    menu.addItem(.separator())
    let notifications = NSMenuItem(
      title: "Enable Notifications",
      action: #selector(enableNotifications),
      keyEquivalent: ""
    )
    notifications.target = self
    menu.addItem(notifications)
    let reconnect = NSMenuItem(title: "Reconnect", action: #selector(reconnect), keyEquivalent: "r")
    reconnect.target = self
    menu.addItem(reconnect)
    menu.addItem(quitItem())
    statusItem.menu = menu
  }

  private func renderTitle(_ snapshot: WatcherSnapshot) {
    guard snapshot.watcher == "live" else {
      statusItem.button?.image = WatcherMark.image()
      statusItem.button?.attributedTitle = NSAttributedString(
        string: " ?",
        attributes: [.foregroundColor: NSColor.systemOrange]
      )
      statusItem.button?.toolTip = "T3 Watcher is disconnected"
      return
    }

    let attention = snapshot.threads.filter {
      ["approval", "input", "plan_ready", "failed"].contains($0.status)
    }.count
    let running = snapshot.threads.filter { ["starting", "running"].contains($0.status) }.count
    let title = NSMutableAttributedString()
    if attention > 0 {
      statusItem.button?.image = WatcherMark.image()
      append(" !\(attention)", to: title, color: .systemOrange)
      statusItem.button?.toolTip = "T3 Watcher: \(attention) thread\(attention == 1 ? "" : "s") need attention"
    } else if running > 0 {
      statusItem.button?.image = WatcherMark.image()
      append(" ●", to: title, color: .systemBlue)
      statusItem.button?.toolTip = "T3 Watcher: work is moving"
    } else {
      statusItem.button?.image = WatcherMark.image()
      append(" ✓", to: title, color: .systemGreen)
      statusItem.button?.toolTip = "T3 Watcher: all clear"
    }
    statusItem.button?.attributedTitle = title
  }

  private func append(_ value: String, to title: NSMutableAttributedString, color: NSColor = .labelColor) {
    title.append(NSAttributedString(string: value, attributes: [.foregroundColor: color]))
  }

  private func addGroup(
    to menu: NSMenu,
    title: String,
    statuses: Set<String>,
    snapshot: WatcherSnapshot
  ) {
    let threads = snapshot.threads.filter { statuses.contains($0.status) }
    guard !threads.isEmpty else { return }
    menu.addItem(.separator())
    menu.addItem(disabledItem("\(title) · \(threads.count)", color: .secondaryLabelColor))
    for thread in threads {
      menu.addItem(threadItem(thread))
      menu.addItem(disabledItem("    \(thread.projectTitle) · \(relativeTime(thread.updatedAt))", color: .secondaryLabelColor))
    }
  }

  private func threadItem(_ thread: WatchedThread) -> NSMenuItem {
    let title = "\(statusLabel(thread.status)) · \(thread.title)"
    let item = NSMenuItem(title: title, action: #selector(openT3Code), keyEquivalent: "")
    item.target = self
    item.attributedTitle = NSAttributedString(
      string: title,
      attributes: [.foregroundColor: statusColor(thread.status)]
    )
    return item
  }

  private func disabledItem(_ title: String, color: NSColor = .labelColor) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    item.isEnabled = false
    item.attributedTitle = NSAttributedString(string: title, attributes: [.foregroundColor: color])
    return item
  }

  private func quitItem() -> NSMenuItem {
    let item = NSMenuItem(title: "Quit T3 Watcher", action: #selector(quit), keyEquivalent: "q")
    item.target = self
    return item
  }

  nonisolated private static func requestNotificationPermission() {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    Task { @MainActor [weak self] in
      self?.openT3Code()
    }
    completionHandler()
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound])
  }

  private func notificationTitle(for status: String) -> String {
    switch status {
    case "approval": return "T3 approval needed"
    case "input": return "T3 thread needs input"
    case "plan_ready": return "T3 plan is ready"
    case "failed": return "T3 thread failed"
    default: return "T3 thread finished"
    }
  }

  private func statusLabel(_ status: String) -> String {
    switch status {
    case "approval": return "Approval needed"
    case "input": return "Awaiting input"
    case "plan_ready": return "Plan ready"
    case "failed": return "Failed"
    case "starting": return "Starting"
    case "running": return "Working"
    case "finished": return "Finished"
    default: return "Ready"
    }
  }

  private func statusColor(_ status: String) -> NSColor {
    switch status {
    case "approval": return .systemOrange
    case "input": return .systemIndigo
    case "plan_ready": return .systemPurple
    case "failed": return .systemRed
    case "starting", "running": return .systemBlue
    case "finished": return .systemGreen
    default: return .secondaryLabelColor
    }
  }

  private func relativeTime(_ value: String) -> String {
    let formatter = ISO8601DateFormatter()
    guard let date = formatter.date(from: value) else { return value }
    let relative = RelativeDateTimeFormatter()
    relative.unitsStyle = .short
    return relative.localizedString(for: date, relativeTo: Date())
  }

  private func showDisconnected(_ message: String) {
    if let snapshot {
      let stale = WatcherSnapshot(
        watcher: "stale",
        watcherName: snapshot.watcherName,
        sourceUpdatedAt: snapshot.sourceUpdatedAt,
        lastCheckedAt: snapshot.lastCheckedAt,
        error: message,
        threads: snapshot.threads
      )
      render(stale)
    } else {
      statusItem.button?.attributedTitle = NSAttributedString(string: " ?")
    }
  }

  @objc private func reconnect() {
    showConnecting()
    connect()
  }

  @objc private func enableNotifications() {
    UNUserNotificationCenter.current().getNotificationSettings(
      completionHandler: Self.handleNotificationSettings
    )
  }

  nonisolated private static func handleNotificationSettings(_ settings: UNNotificationSettings) {
    switch settings.authorizationStatus {
    case .notDetermined:
      requestNotificationPermission()
    case .denied:
      Task { @MainActor in openNotificationSettings() }
    default:
      break
    }
  }

  private static func openNotificationSettings() {
    guard let url = URL(
      string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
    ) else { return }
    NSWorkspace.shared.open(url)
  }

  @objc private func openT3Code() {
    Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(100))
      self?.activateT3Code()
    }
  }

  private func activateT3Code() {
    let runningApp = NSRunningApplication
      .runningApplications(withBundleIdentifier: "com.t3tools.t3code")
      .first { $0.bundleURL?.standardizedFileURL == t3CodeURL.standardizedFileURL }
    if let runningApp {
      if runningApp.isHidden { runningApp.unhide() }
      runningApp.activate(options: [.activateAllWindows])
      return
    }

    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    NSWorkspace.shared.openApplication(
      at: t3CodeURL,
      configuration: configuration,
      completionHandler: nil
    )
  }

  @objc private func quit() {
    NSApplication.shared.terminate(nil)
  }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
withExtendedLifetime(delegate) {
  application.run()
}
