import AppKit
import CoreGraphics
import Foundation
import ImageIO

private struct PetManifest: Decodable {
  let id: String
  let displayName: String
  let spritesheetPath: String
}

struct PetDefinition {
  let id: String
  let displayName: String
  let spritesheetURL: URL
}

enum PetLibrary {
  static let rootURL = FileManager.default.homeDirectoryForCurrentUser
    .appending(path: ".codex/pets", directoryHint: .isDirectory)

  static func installed() -> [PetDefinition] {
    let decoder = JSONDecoder()
    let directories = (try? FileManager.default.contentsOfDirectory(
      at: rootURL,
      includingPropertiesForKeys: nil,
      options: [.skipsHiddenFiles]
    )) ?? []

    return directories.compactMap { directory in
      let manifestURL = directory.appending(path: "pet.json")
      guard
        let data = try? Data(contentsOf: manifestURL),
        let manifest = try? decoder.decode(PetManifest.self, from: data)
      else { return nil }
      let spritesheetURL = directory.appending(path: manifest.spritesheetPath)
      guard FileManager.default.fileExists(atPath: spritesheetURL.path) else { return nil }
      return PetDefinition(
        id: manifest.id,
        displayName: manifest.displayName,
        spritesheetURL: spritesheetURL
      )
    }.sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
  }
}

enum PetAnimationState {
  case idle
  case jumping
  case running
  case waving
  case waiting
  case failed
  case review

  var row: Int {
    switch self {
    case .idle: return 0
    case .jumping: return 4
    case .waving: return 3
    case .failed: return 5
    case .waiting: return 6
    case .running: return 7
    case .review: return 8
    }
  }

  var frameDurations: [TimeInterval] {
    switch self {
    case .idle: return [1.68, 0.66, 0.66, 0.84, 0.84, 1.92]
    case .jumping: return [0.14, 0.14, 0.14, 0.14, 0.28]
    case .waving: return [0.14, 0.14, 0.14, 0.28]
    case .failed: return [0.14, 0.14, 0.14, 0.14, 0.14, 0.14, 0.14, 0.24]
    case .waiting: return [0.15, 0.15, 0.15, 0.15, 0.15, 0.26]
    case .running: return [0.12, 0.12, 0.12, 0.12, 0.12, 0.22]
    case .review: return [0.15, 0.15, 0.15, 0.15, 0.15, 0.28]
    }
  }
}

private final class PetBadgeView: NSView {
  var count = 0 {
    didSet {
      isHidden = count == 0
      needsDisplay = true
    }
  }
  var kind = WatcherBadgeKind.hidden {
    didSet { needsDisplay = true }
  }
  var showsLabel = false {
    didSet { needsDisplay = true }
  }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    isHidden = true
  }

  required init?(coder: NSCoder) {
    fatalError("PetBadgeView does not support storyboards")
  }

  override func hitTest(_ point: NSPoint) -> NSView? {
    nil
  }

  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)
    guard count > 0 else { return }
    let color: NSColor = switch kind {
    case .attention: .systemOrange
    case .working: NSColor(calibratedRed: 0.90, green: 0.37, blue: 0.37, alpha: 1)
    case .finished: NSColor(calibratedRed: 0.20, green: 0.83, blue: 0.48, alpha: 1)
    case .hidden: .clear
    }
    color.setFill()
    NSBezierPath(
      roundedRect: bounds,
      xRadius: bounds.height / 2,
      yRadius: bounds.height / 2
    ).fill()

    guard showsLabel else { return }

    let displayText = kind == .attention ? "!" : String(count)
    let fontSize = bounds.width * (displayText.count < 3 ? 0.52 : 0.4)
    let text = displayText as NSString
    let attributes: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: fontSize, weight: .semibold),
      .foregroundColor: NSColor(calibratedWhite: 0.08, alpha: 1),
    ]
    let textSize = text.size(withAttributes: attributes)
    text.draw(
      at: NSPoint(
        x: bounds.midX - textSize.width / 2,
        y: bounds.midY - textSize.height / 2
      ),
      withAttributes: attributes
    )
  }
}

private final class PetSpriteView: NSImageView {
  private static let cellSize = NSSize(width: 192, height: 208)
  private static let badgeGutterRatio: CGFloat = 0.2
  static func overlayHeight(for width: CGFloat) -> CGFloat {
    width * cellSize.height / cellSize.width + width * badgeGutterRatio
  }
  var onClose: (() -> Void)?
  private let badgeView = PetBadgeView(frame: .zero)
  private var spritesheet: CGImage?
  private var state = PetAnimationState.idle
  private var baselineState = PetAnimationState.idle
  private var isPlayingTransition = false
  private var hoverCyclesRemaining = 0
  private var frameIndex = 0
  private var animationTimer: Timer?
  private var dragStart: (mouse: NSPoint, origin: NSPoint)?
  private var hoverTrackingArea: NSTrackingArea?
  private var isHovering = false

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    imageAlignment = .alignTop
    imageFrameStyle = .none
    imageScaling = .scaleProportionallyUpOrDown
    wantsLayer = true
    layer?.magnificationFilter = .nearest
    layer?.minificationFilter = .nearest
    addSubview(badgeView)
    badgeView.frame = badgeFrame(expanded: false)
  }

  required init?(coder: NSCoder) {
    fatalError("PetSpriteView does not support storyboards")
  }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
    true
  }

  override func resetCursorRects() {
    super.resetCursorRects()
    addCursorRect(bounds, cursor: .openHand)
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let hoverTrackingArea { removeTrackingArea(hoverTrackingArea) }
    let next = NSTrackingArea(
      rect: bounds,
      options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
      owner: self,
      userInfo: nil
    )
    addTrackingArea(next)
    hoverTrackingArea = next
  }

  override func mouseEntered(with event: NSEvent) {
    setBadgeExpanded(true)
    guard !isPlayingTransition else { return }
    hoverCyclesRemaining = 3
    beginAnimation(.jumping)
  }

  override func mouseExited(with event: NSEvent) {
    setBadgeExpanded(false)
    hoverCyclesRemaining = 0
    guard !isPlayingTransition else { return }
    beginAnimation(baselineState)
  }

  override func layout() {
    super.layout()
    badgeView.frame = badgeFrame(expanded: isHovering)
  }

  private func badgeFrame(expanded: Bool) -> NSRect {
    if expanded {
      let diameter = min(32, max(20, bounds.width * 0.3))
      return NSRect(
        x: bounds.maxX - diameter - 1,
        y: bounds.minY,
        width: diameter,
        height: diameter
      )
    }

    let width = min(44, max(20, bounds.width * 0.32))
    let height = min(10, max(6, bounds.width * 0.075))
    let gutterHeight = bounds.width * Self.badgeGutterRatio
    return NSRect(
      x: bounds.midX - width / 2,
      y: bounds.minY + max(0, gutterHeight - height - 2),
      width: width,
      height: height
    )
  }

  private func setBadgeExpanded(_ expanded: Bool) {
    guard expanded != isHovering else { return }
    isHovering = expanded
    if !expanded { badgeView.showsLabel = false }
    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0.2
      context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
      badgeView.animator().frame = badgeFrame(expanded: expanded)
    } completionHandler: { [weak self] in
      guard let self, self.isHovering else { return }
      self.badgeView.showsLabel = true
    }
  }

  override func mouseDown(with event: NSEvent) {
    guard let window else { return }
    dragStart = (mouse: NSEvent.mouseLocation, origin: window.frame.origin)
    NSCursor.closedHand.set()
  }

  override func mouseDragged(with event: NSEvent) {
    guard let window, let dragStart else { return }
    let current = NSEvent.mouseLocation
    window.setFrameOrigin(NSPoint(
      x: dragStart.origin.x + current.x - dragStart.mouse.x,
      y: dragStart.origin.y + current.y - dragStart.mouse.y
    ))
  }

  override func mouseUp(with event: NSEvent) {
    dragStart = nil
    window?.invalidateCursorRects(for: self)
  }

  override func rightMouseDown(with event: NSEvent) {
    let menu = NSMenu()
    let close = NSMenuItem(title: "Close pet", action: #selector(closePet), keyEquivalent: "")
    close.target = self
    menu.addItem(close)
    NSMenu.popUpContextMenu(menu, with: event, for: self)
  }

  @objc private func closePet() {
    onClose?()
  }

  func load(_ pet: PetDefinition) {
    let source = CGImageSourceCreateWithURL(pet.spritesheetURL as CFURL, nil)
    spritesheet = source.flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) }
    frameIndex = 0
    updateFrameImage()
    scheduleNextFrame()
  }

  func setBaselineState(_ next: PetAnimationState) {
    baselineState = next
    guard !isPlayingTransition, hoverCyclesRemaining == 0, !isHovering, next != state else { return }
    beginAnimation(next)
  }

  func playTransition(_ next: PetAnimationState) {
    isPlayingTransition = true
    hoverCyclesRemaining = 0
    beginAnimation(next)
  }

  private func beginAnimation(_ next: PetAnimationState) {
    state = next
    frameIndex = 0
    updateFrameImage()
    scheduleNextFrame()
  }

  func setBadge(count: Int, kind: WatcherBadgeKind) {
    badgeView.kind = kind
    badgeView.count = count
  }

  private func scheduleNextFrame() {
    animationTimer?.invalidate()
    guard spritesheet != nil else { return }
    let durations = state.frameDurations
    animationTimer = Timer.scheduledTimer(withTimeInterval: durations[frameIndex], repeats: false) {
      [weak self] _ in
      Task { @MainActor in
        guard let self else { return }
        let nextFrame = self.frameIndex + 1
        if self.isPlayingTransition, nextFrame >= durations.count {
          self.isPlayingTransition = false
          self.beginAnimation(self.isHovering ? .idle : self.baselineState)
          return
        }
        if self.hoverCyclesRemaining > 0, nextFrame >= durations.count {
          self.hoverCyclesRemaining -= 1
          self.beginAnimation(self.hoverCyclesRemaining > 0 ? .jumping : .idle)
          return
        }
        self.frameIndex = nextFrame % durations.count
        self.updateFrameImage()
        self.scheduleNextFrame()
      }
    }
  }

  private func updateFrameImage() {
    guard
      let spritesheet,
      let frameImage = spritesheet.cropping(to: CGRect(
        x: CGFloat(frameIndex) * Self.cellSize.width,
        y: CGFloat(state.row) * Self.cellSize.height,
        width: Self.cellSize.width,
        height: Self.cellSize.height
      ))
    else { return }
    image = NSImage(cgImage: frameImage, size: Self.cellSize)
  }
}

private final class PetPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

@MainActor
final class PetOverlayController: NSObject, NSWindowDelegate {
  static let sizePresets: [(name: String, width: CGFloat)] = [
    ("Small", 64),
    ("Medium", 96),
    ("Large", 128),
  ]
  private static let originXKey = "petOriginX"
  private static let originYKey = "petOriginY"
  private static let widthKey = "petWidth"
  private static let sizeVersionKey = "petSizePresetVersion"
  private let panel: PetPanel
  private let spriteView: PetSpriteView
  private(set) var pets: [PetDefinition] = []
  private(set) var selectedPetID: String?
  private(set) var isEnabled: Bool
  var petWidth: CGFloat { panel.frame.width }

  override init() {
    let defaults = UserDefaults.standard
    isEnabled = defaults.object(forKey: "petOverlayEnabled") as? Bool ?? true
    spriteView = PetSpriteView(frame: NSRect(
      x: 0,
      y: 0,
      width: 96,
      height: PetSpriteView.overlayHeight(for: 96)
    ))
    panel = PetPanel(
      contentRect: spriteView.bounds,
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    panel.backgroundColor = .clear
    panel.isOpaque = false
    panel.hasShadow = false
    panel.ignoresMouseEvents = false
    panel.hidesOnDeactivate = false
    panel.isMovableByWindowBackground = false
    panel.sharingType = .readOnly
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    panel.contentView = spriteView
    panel.minSize = NSSize(width: 64, height: PetSpriteView.overlayHeight(for: 64))
    panel.maxSize = NSSize(width: 128, height: PetSpriteView.overlayHeight(for: 128))

    super.init()
    panel.delegate = self
    spriteView.onClose = { [weak self] in
      self?.setEnabled(false)
    }
    reloadPets()
    restoreSize()
    restorePosition()
    updateVisibility()
  }

  func reloadPets() {
    pets = PetLibrary.installed()
    let preferred = ProcessInfo.processInfo.environment["T3_PET_ID"]
      ?? UserDefaults.standard.string(forKey: "petID")
      ?? "codex"
    let selected = pets.first { $0.id == preferred } ?? pets.first
    selectedPetID = selected?.id
    if let selected { spriteView.load(selected) }
  }

  func selectPet(id: String) {
    guard let selected = pets.first(where: { $0.id == id }) else { return }
    selectedPetID = selected.id
    UserDefaults.standard.set(selected.id, forKey: "petID")
    spriteView.load(selected)
    updateVisibility()
  }

  func setEnabled(_ enabled: Bool) {
    isEnabled = enabled
    UserDefaults.standard.set(enabled, forKey: "petOverlayEnabled")
    updateVisibility()
  }

  func setSize(width: CGFloat) {
    let clampedWidth = min(max(width, panel.minSize.width), panel.maxSize.width)
    let height = PetSpriteView.overlayHeight(for: clampedWidth)
    let frame = panel.frame
    panel.setFrame(NSRect(
      x: frame.minX,
      y: frame.maxY - height,
      width: clampedWidth,
      height: height
    ), display: true)
    UserDefaults.standard.set(2, forKey: Self.sizeVersionKey)
  }

  func update(summary: WatcherSummary, transition: PetAnimationState?) {
    spriteView.setBadge(count: summary.badge.count, kind: summary.badge.kind)
    spriteView.setBaselineState(summary.baselinePetState)
    if let transition { spriteView.playTransition(transition) }
  }

  func windowDidMove(_ notification: Notification) {
    let origin = panel.frame.origin
    UserDefaults.standard.set(Double(origin.x), forKey: Self.originXKey)
    UserDefaults.standard.set(Double(origin.y), forKey: Self.originYKey)
  }

  func windowDidResize(_ notification: Notification) {
    UserDefaults.standard.set(Double(panel.frame.width), forKey: Self.widthKey)
  }

  private func updateVisibility() {
    guard isEnabled, selectedPetID != nil else {
      panel.orderOut(nil)
      return
    }
    panel.orderFrontRegardless()
  }

  private func restorePosition() {
    let defaults = UserDefaults.standard
    let hasSavedOrigin = defaults.object(forKey: Self.originXKey) != nil
      && defaults.object(forKey: Self.originYKey) != nil
    if hasSavedOrigin {
      let savedOrigin = NSPoint(
        x: defaults.double(forKey: Self.originXKey),
        y: defaults.double(forKey: Self.originYKey)
      )
      let savedFrame = NSRect(origin: savedOrigin, size: panel.frame.size)
      if NSScreen.screens.contains(where: { $0.visibleFrame.intersects(savedFrame) }) {
        panel.setFrameOrigin(savedOrigin)
        return
      }
    }

    let visibleFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    panel.setFrameOrigin(NSPoint(
      x: visibleFrame.maxX - panel.frame.width - 28,
      y: visibleFrame.minY + 22
    ))
  }

  private func restoreSize() {
    let defaults = UserDefaults.standard
    guard defaults.object(forKey: Self.widthKey) != nil else { return }
    let savedWidth = defaults.double(forKey: Self.widthKey)
    if defaults.integer(forKey: Self.sizeVersionKey) < 2 {
      let legacyWidths = [80.0, 112.0, 144.0]
      let closestIndex = legacyWidths.indices.min {
        abs(legacyWidths[$0] - savedWidth) < abs(legacyWidths[$1] - savedWidth)
      } ?? 1
      setSize(width: Self.sizePresets[closestIndex].width)
      defaults.set(2, forKey: Self.sizeVersionKey)
    } else {
      setSize(width: savedWidth)
    }
  }
}
