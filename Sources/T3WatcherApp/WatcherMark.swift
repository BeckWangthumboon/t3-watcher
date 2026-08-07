import AppKit

enum WatcherMark {
  static func image(size: CGFloat = 18, dotColor: NSColor = .systemGreen) -> NSImage {
    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()

    let scale = size / 18
    let markColor = NSColor.labelColor

    let stem = NSBezierPath()
    stem.move(to: NSPoint(x: 6.5 * scale, y: 14.5 * scale))
    stem.line(to: NSPoint(x: 6.5 * scale, y: 6.0 * scale))
    stem.curve(
      to: NSPoint(x: 9.0 * scale, y: 3.5 * scale),
      controlPoint1: NSPoint(x: 6.5 * scale, y: 4.333 * scale),
      controlPoint2: NSPoint(x: 7.333 * scale, y: 3.5 * scale)
    )
    stem.line(to: NSPoint(x: 10.5 * scale, y: 3.5 * scale))
    stem.lineWidth = 1.8 * scale
    stem.lineCapStyle = .round
    stem.lineJoinStyle = .round
    markColor.setStroke()
    stem.stroke()

    let crossbar = NSBezierPath()
    crossbar.move(to: NSPoint(x: 4.0 * scale, y: 12.0 * scale))
    crossbar.line(to: NSPoint(x: 8.5 * scale, y: 12.0 * scale))
    crossbar.lineWidth = 1.8 * scale
    crossbar.lineCapStyle = .round
    markColor.setStroke()
    crossbar.stroke()

    let dot = NSBezierPath(
      ovalIn: NSRect(
        x: 12.5 * scale,
        y: 12.6 * scale,
        width: 4.0 * scale,
        height: 4.0 * scale
      )
    )
    dot.lineWidth = 1.0 * scale
    dotColor.setStroke()
    dot.stroke()

    image.unlockFocus()
    return image
  }
}
