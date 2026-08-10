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

enum WatcherBadgeKind {
  case attention
  case working
  case finished
  case hidden
}

struct WatcherSummary {
  let attentionThreads: [WatchedThread]
  let workingThreads: [WatchedThread]
  let finishedThreads: [WatchedThread]
  let readyThreads: [WatchedThread]

  var baselinePetState: PetAnimationState {
    workingThreads.isEmpty ? .idle : .running
  }

  var badge: (count: Int, kind: WatcherBadgeKind) {
    if !attentionThreads.isEmpty {
      return (attentionThreads.count, .attention)
    }
    if !workingThreads.isEmpty {
      return (workingThreads.count, .working)
    }
    if !finishedThreads.isEmpty {
      return (finishedThreads.count, .finished)
    }
    return (0, .hidden)
  }

  func transitionAnimation(from previousStatuses: [String: String]) -> PetAnimationState? {
    let enteredStatuses = Set((attentionThreads + finishedThreads).compactMap { thread in
      previousStatuses[thread.key] == thread.status ? nil : thread.status
    })
    if enteredStatuses.contains("failed") { return .failed }
    if !enteredStatuses.isDisjoint(with: ["approval", "input"]) { return .waiting }
    if enteredStatuses.contains("plan_ready") { return .review }
    if enteredStatuses.contains("finished") { return .waving }
    return nil
  }

  init(snapshot: WatcherSnapshot) {
    attentionThreads = snapshot.threads.filter {
      ["approval", "input", "plan_ready", "failed"].contains($0.status)
    }
    workingThreads = snapshot.threads.filter { ["starting", "running"].contains($0.status) }
    finishedThreads = snapshot.threads.filter { $0.status == "finished" }
    readyThreads = snapshot.threads.filter { $0.status == "ready" }
  }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let t3CodeURL = URL(fileURLWithPath: "/Applications/T3 Code (Nightly).app")
  private var petOverlay: PetOverlayController!
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
    petOverlay = PetOverlayController()
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
    let summary = WatcherSummary(snapshot: next)
    let petTransition = hasLoadedSnapshot
      ? summary.transitionAnimation(from: previousStatuses)
      : nil
    notifyTransitions(in: next)
    snapshot = next
    petOverlay.update(summary: summary, transition: petTransition)
    render(next, summary: summary)
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

  private func render(_ snapshot: WatcherSnapshot, summary: WatcherSummary? = nil) {
    let summary = summary ?? WatcherSummary(snapshot: snapshot)
    renderTitle(snapshot, summary: summary)
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
      threads: summary.attentionThreads
    )
    addGroup(to: menu, title: "WORKING", threads: summary.workingThreads)
    addGroup(to: menu, title: "FINISHED", threads: summary.finishedThreads)
    addGroup(to: menu, title: "READY", threads: summary.readyThreads)

    if snapshot.threads.isEmpty {
      menu.addItem(.separator())
      menu.addItem(disabledItem("No unsettled threads", color: .secondaryLabelColor))
    }
    menu.addItem(.separator())
    addPetControls(to: menu)
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

  private func addPetControls(to menu: NSMenu) {
    let toggle = NSMenuItem(title: "Show Pet", action: #selector(togglePet), keyEquivalent: "")
    toggle.target = self
    toggle.state = petOverlay.isEnabled ? .on : .off
    toggle.isEnabled = !petOverlay.pets.isEmpty
    menu.addItem(toggle)

    guard !petOverlay.pets.isEmpty else {
      menu.addItem(disabledItem("No pets found in ~/.codex/pets", color: .secondaryLabelColor))
      return
    }
    let choose = NSMenuItem(title: "Pet", action: nil, keyEquivalent: "")
    let submenu = NSMenu(title: "Pet")
    for pet in petOverlay.pets {
      let item = NSMenuItem(title: pet.displayName, action: #selector(selectPet(_:)), keyEquivalent: "")
      item.target = self
      item.representedObject = pet.id
      item.state = pet.id == petOverlay.selectedPetID ? .on : .off
      submenu.addItem(item)
    }
    choose.submenu = submenu
    menu.addItem(choose)

    let size = NSMenuItem(title: "Pet Size", action: nil, keyEquivalent: "")
    let sizeMenu = NSMenu(title: "Pet Size")
    for option in PetOverlayController.sizePresets {
      let item = NSMenuItem(title: option.name, action: #selector(selectPetSize(_:)), keyEquivalent: "")
      item.target = self
      item.representedObject = Double(option.width)
      item.state = abs(petOverlay.petWidth - option.width) < 1 ? .on : .off
      sizeMenu.addItem(item)
    }
    size.submenu = sizeMenu
    menu.addItem(size)
  }

  private func renderTitle(_ snapshot: WatcherSnapshot, summary: WatcherSummary) {
    guard snapshot.watcher == "live" else {
      statusItem.button?.image = WatcherMark.image()
      statusItem.button?.attributedTitle = NSAttributedString(
        string: " ?",
        attributes: [.foregroundColor: NSColor.systemOrange]
      )
      statusItem.button?.toolTip = "T3 Watcher is disconnected"
      return
    }

    let attention = summary.attentionThreads.count
    let running = summary.workingThreads.count
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
    threads: [WatchedThread]
  ) {
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

  @objc private func togglePet() {
    petOverlay.setEnabled(!petOverlay.isEnabled)
    if let snapshot { render(snapshot) }
  }

  @objc private func selectPet(_ sender: NSMenuItem) {
    guard let id = sender.representedObject as? String else { return }
    petOverlay.selectPet(id: id)
    if let snapshot { render(snapshot) }
  }

  @objc private func selectPetSize(_ sender: NSMenuItem) {
    guard let width = sender.representedObject as? Double else { return }
    petOverlay.setSize(width: width)
    if let snapshot { render(snapshot) }
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
