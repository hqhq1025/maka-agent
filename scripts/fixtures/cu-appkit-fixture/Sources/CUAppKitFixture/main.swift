import AppKit
import CoreGraphics
import Darwin
import Foundation

private let defaultWindowSize = NSSize(width: 720, height: 570)
private let defaultSliderValue = 25.0

private func rectDictionary(_ rect: CGRect) -> [String: Double] {
  [
    "x": rect.origin.x,
    "y": rect.origin.y,
    "width": rect.width,
    "height": rect.height,
  ]
}

private func intersectionArea(_ lhs: CGRect, _ rhs: CGRect) -> CGFloat {
  let intersection = lhs.intersection(rhs)
  return intersection.isNull ? 0 : intersection.width * intersection.height
}

private func displayID(for screen: NSScreen) -> CGDirectDisplayID? {
  let key = NSDeviceDescriptionKey("NSScreenNumber")
  return (screen.deviceDescription[key] as? NSNumber).map { CGDirectDisplayID($0.uint32Value) }
}

private func bestScreen(forAppKitRect rect: CGRect) -> NSScreen? {
  NSScreen.screens.max {
    intersectionArea($0.frame, rect) < intersectionArea($1.frame, rect)
  } ?? NSScreen.main
}

private func bestScreen(forQuartzRect rect: CGRect) -> NSScreen? {
  NSScreen.screens.max {
    guard let lhsID = displayID(for: $0), let rhsID = displayID(for: $1) else { return false }
    return intersectionArea(CGDisplayBounds(lhsID), rect) < intersectionArea(CGDisplayBounds(rhsID), rect)
  } ?? NSScreen.main
}

private func quartzRect(fromAppKitRect rect: CGRect) -> CGRect {
  guard
    let screen = bestScreen(forAppKitRect: rect),
    let screenID = displayID(for: screen)
  else {
    return rect
  }
  let displayBounds = CGDisplayBounds(screenID)
  return CGRect(
    x: displayBounds.minX + rect.minX - screen.frame.minX,
    y: displayBounds.minY + screen.frame.maxY - rect.maxY,
    width: rect.width,
    height: rect.height
  )
}

private func appKitRect(fromQuartzRect rect: CGRect) -> CGRect {
  guard
    let screen = bestScreen(forQuartzRect: rect),
    let screenID = displayID(for: screen)
  else {
    return rect
  }
  let displayBounds = CGDisplayBounds(screenID)
  return CGRect(
    x: screen.frame.minX + rect.minX - displayBounds.minX,
    y: screen.frame.maxY - (rect.minY - displayBounds.minY) - rect.height,
    width: rect.width,
    height: rect.height
  )
}

private func quartzWindowRect(_ window: NSWindow) -> CGRect {
  return quartzRect(fromAppKitRect: window.frame)
}

private func quartzRect(for view: NSView) -> CGRect? {
  guard let window = view.window else { return nil }
  let windowRect = view.convert(view.bounds, to: nil)
  return quartzRect(fromAppKitRect: window.convertToScreen(windowRect))
}

private func activationPolicyName(_ policy: NSApplication.ActivationPolicy) -> String {
  switch policy {
  case .regular: return "regular"
  case .accessory: return "accessory"
  case .prohibited: return "prohibited"
  @unknown default: return "unknown"
  }
}

private class FlippedView: NSView {
  override var isFlipped: Bool { true }
}

private final class RightClickView: NSView {
  var onRightClick: (() -> Void)?
  private var count = 0

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.cornerRadius = 6
    setAccessibilityElement(true)
    setAccessibilityRole(.group)
    setAccessibilityLabel("Right click target")
    identifier = NSUserInterfaceItemIdentifier("right-click-target")
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func rightMouseDown(with event: NSEvent) {
    count += 1
    needsDisplay = true
    onRightClick?()
  }

  func reset() {
    count = 0
    needsDisplay = true
  }

  override func draw(_ dirtyRect: NSRect) {
    NSColor(calibratedRed: 0.94, green: 0.97, blue: 1, alpha: 1).setFill()
    dirtyRect.fill()
    NSColor.systemBlue.setStroke()
    let border = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 6, yRadius: 6)
    border.lineWidth = 1
    border.stroke()

    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    let compact = bounds.height < 70
    let text = compact ? "Right clicks: \(count)" : "Right-click target\nCount: \(count)"
    let textHeight: CGFloat = compact ? 18 : 48
    text.draw(
      in: NSRect(
        x: 8,
        y: (bounds.height - textHeight) / 2,
        width: bounds.width - 16,
        height: textHeight
      ),
      withAttributes: [
        .font: NSFont.systemFont(ofSize: 14, weight: .medium),
        .foregroundColor: NSColor.labelColor,
        .paragraphStyle: paragraph,
      ]
    )
  }
}

private final class DragArenaView: NSView {
  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
    layer?.borderColor = NSColor.separatorColor.cgColor
    layer?.borderWidth = 1
    layer?.cornerRadius = 6
    identifier = NSUserInterfaceItemIdentifier("drag-arena")
    setAccessibilityElement(true)
    setAccessibilityRole(.group)
    setAccessibilityLabel("Drag arena")
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)
    "Drag the blue view".draw(
      at: NSPoint(x: 12, y: bounds.height - 24),
      withAttributes: [
        .font: NSFont.systemFont(ofSize: 12),
        .foregroundColor: NSColor.secondaryLabelColor,
      ]
    )
  }
}

private final class DraggableView: NSView {
  var onMove: ((NSPoint) -> Void)?
  var onComplete: (() -> Void)?

  private var mouseDownPoint = NSPoint.zero
  private var initialOrigin = NSPoint.zero

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.backgroundColor = NSColor.systemBlue.cgColor
    layer?.cornerRadius = 6
    identifier = NSUserInterfaceItemIdentifier("drag-target")
    setAccessibilityElement(true)
    setAccessibilityRole(.button)
    setAccessibilityLabel("Draggable target")
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
    true
  }

  override func mouseDown(with event: NSEvent) {
    guard let superview else { return }
    mouseDownPoint = superview.convert(event.locationInWindow, from: nil)
    initialOrigin = frame.origin
  }

  override func mouseDragged(with event: NSEvent) {
    guard let superview else { return }
    let point = superview.convert(event.locationInWindow, from: nil)
    let proposed = NSPoint(
      x: initialOrigin.x + point.x - mouseDownPoint.x,
      y: initialOrigin.y + point.y - mouseDownPoint.y
    )
    let maxX = max(0, superview.bounds.width - frame.width)
    let maxY = max(0, superview.bounds.height - frame.height)
    let clamped = NSPoint(
      x: min(max(0, proposed.x), maxX),
      y: min(max(0, proposed.y), maxY)
    )
    setFrameOrigin(clamped)
    onMove?(clamped)
  }

  override func mouseUp(with event: NSEvent) {
    onComplete?()
  }

  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    "DRAG".draw(
      in: NSRect(
        x: 4,
        y: (bounds.height - 18) / 2,
        width: bounds.width - 8,
        height: 18
      ),
      withAttributes: [
        .font: NSFont.systemFont(ofSize: 13, weight: .bold),
        .foregroundColor: NSColor.white,
        .paragraphStyle: paragraph,
      ]
    )
  }
}

private final class FixtureRootView: FlippedView {
  let titleLabel = NSTextField(labelWithString: "Native AppKit Computer Use Fixture")
  let incrementButton = NSButton(title: "Increment", target: nil, action: nil)
  let checkbox = NSButton(checkboxWithTitle: "Enabled", target: nil, action: nil)
  let textField = NSTextField()
  let slider = NSSlider(value: defaultSliderValue, minValue: 0, maxValue: 100, target: nil, action: nil)
  let sliderValueLabel = NSTextField(labelWithString: "25")
  let scrollView = NSScrollView()
  let rightClickView = RightClickView()
  let dragArena = DragArenaView()
  let draggableView = DraggableView(frame: NSRect(x: 18, y: 28, width: 100, height: 64))

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor

    titleLabel.font = NSFont.systemFont(ofSize: 20, weight: .semibold)
    titleLabel.identifier = NSUserInterfaceItemIdentifier("fixture-title")
    addSubview(titleLabel)

    incrementButton.bezelStyle = .rounded
    incrementButton.identifier = NSUserInterfaceItemIdentifier("increment")
    incrementButton.setAccessibilityLabel("Increment count")
    addSubview(incrementButton)

    checkbox.identifier = NSUserInterfaceItemIdentifier("enabled")
    checkbox.setAccessibilityLabel("Enabled")
    addSubview(checkbox)

    textField.placeholderString = "Type into the native text field"
    textField.identifier = NSUserInterfaceItemIdentifier("target")
    textField.setAccessibilityLabel("Fixture text input")
    addSubview(textField)

    slider.isContinuous = true
    slider.identifier = NSUserInterfaceItemIdentifier("level")
    slider.setAccessibilityLabel("Fixture level")
    addSubview(slider)

    sliderValueLabel.alignment = .right
    sliderValueLabel.identifier = NSUserInterfaceItemIdentifier("level-value")
    addSubview(sliderValueLabel)

    scrollView.hasVerticalScroller = true
    scrollView.hasHorizontalScroller = false
    scrollView.autohidesScrollers = false
    scrollView.borderType = .bezelBorder
    scrollView.identifier = NSUserInterfaceItemIdentifier("scrollbox")
    scrollView.setAccessibilityLabel("Scrollable fixture content")
    let document = FlippedView(frame: NSRect(x: 0, y: 0, width: 300, height: 720))
    for index in 0..<24 {
      let row = NSTextField(labelWithString: "Scrollable native row \(index + 1)")
      row.frame = NSRect(x: 12, y: 10 + CGFloat(index * 28), width: 270, height: 20)
      row.identifier = NSUserInterfaceItemIdentifier("scroll-row-\(index + 1)")
      document.addSubview(row)
    }
    scrollView.documentView = document
    addSubview(scrollView)

    addSubview(rightClickView)
    dragArena.addSubview(draggableView)
    addSubview(dragArena)

  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func layout() {
    super.layout()
    let width = bounds.width
    let compact = width < 600 || bounds.height < 400
    let edge: CGFloat = compact ? 12 : 20
    let titleY: CGFloat = compact ? 6 : 18
    let controlsY: CGFloat = compact ? 34 : 60
    let textY: CGFloat = compact ? 66 : 110
    let sliderY: CGFloat = compact ? 99 : 160
    let contentY: CGFloat = compact ? 126 : 208
    let bottom: CGFloat = compact ? 8 : 20
    let horizontalGap: CGFloat = compact ? 12 : 16
    let verticalGap: CGFloat = compact ? 8 : 16

    titleLabel.font = NSFont.systemFont(ofSize: compact ? 16 : 20, weight: .semibold)
    titleLabel.frame = NSRect(
      x: edge,
      y: titleY,
      width: width - 2 * edge,
      height: compact ? 22 : 28
    )
    incrementButton.frame = NSRect(
      x: edge,
      y: controlsY,
      width: compact ? 132 : 150,
      height: compact ? 26 : 32
    )
    checkbox.frame = NSRect(
      x: edge + incrementButton.frame.width + (compact ? 12 : 20),
      y: controlsY + (compact ? 2 : 6),
      width: 130,
      height: 22
    )
    textField.frame = NSRect(
      x: edge,
      y: textY,
      width: width - 2 * edge,
      height: compact ? 24 : 28
    )
    slider.frame = NSRect(
      x: edge,
      y: sliderY,
      width: max(180, width - 2 * edge - 65),
      height: compact ? 20 : 24
    )
    sliderValueLabel.frame = NSRect(
      x: width - edge - 52,
      y: sliderY + 2,
      width: 52,
      height: 20
    )

    let contentHeight = max(118, bounds.height - contentY - bottom)
    let availableWidth = width - 2 * edge - horizontalGap
    let leftWidth = floor(availableWidth * (compact ? 0.46 : 0.48))
    scrollView.frame = NSRect(x: edge, y: contentY, width: leftWidth, height: contentHeight)

    let rightX = edge + leftWidth + horizontalGap
    let rightWidth = width - rightX - edge
    let rightClickHeight = compact ? 40 : min(96, floor(contentHeight * 0.32))
    rightClickView.frame = NSRect(
      x: rightX,
      y: contentY,
      width: rightWidth,
      height: rightClickHeight
    )
    dragArena.frame = NSRect(
      x: rightX,
      y: contentY + rightClickHeight + verticalGap,
      width: rightWidth,
      height: contentHeight - rightClickHeight - verticalGap
    )
    draggableView.setFrameSize(
      compact ? NSSize(width: 76, height: 30) : NSSize(width: 100, height: 64)
    )
    if compact {
      draggableView.setFrameOrigin(NSPoint(x: min(draggableView.frame.minX, 18), y: 0))
    }
    clampDraggableFrame()
  }

  func clampDraggableFrame() {
    let maxX = max(0, dragArena.bounds.width - draggableView.frame.width)
    let maxY = max(0, dragArena.bounds.height - draggableView.frame.height)
    draggableView.setFrameOrigin(NSPoint(
      x: min(max(0, draggableView.frame.minX), maxX),
      y: min(max(0, draggableView.frame.minY), maxY)
    ))
  }

  func resetDragPosition() {
    draggableView.setFrameOrigin(NSPoint(x: 18, y: 28))
    clampDraggableFrame()
  }
}

private final class FixtureController: NSObject, NSTextFieldDelegate {
  let window: NSWindow
  let rootView: FixtureRootView

  private(set) var revision: UInt64 = 0
  private(set) var buttonClicks = 0
  private(set) var checkboxChanges = 0
  private(set) var textChanges = 0
  private(set) var sliderChanges = 0
  private(set) var scrollEvents = 0
  private(set) var rightClicks = 0
  private(set) var dragCompletions = 0
  private(set) var dragMoveEvents = 0
  private var suppressMutation = false

  override init() {
    let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let frame = NSRect(
      x: screenFrame.maxX - defaultWindowSize.width - 48,
      y: screenFrame.maxY - defaultWindowSize.height - 48,
      width: defaultWindowSize.width,
      height: defaultWindowSize.height
    )
    window = NSWindow(
      contentRect: frame,
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    rootView = FixtureRootView(frame: NSRect(origin: .zero, size: defaultWindowSize))
    super.init()

    window.title = "Maka Computer Use AppKit Fixture"
    window.identifier = NSUserInterfaceItemIdentifier("cu-appkit-fixture-window")
    window.isReleasedWhenClosed = false
    window.minSize = NSSize(width: 420, height: 280)
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    window.contentView = rootView

    rootView.incrementButton.target = self
    rootView.incrementButton.action = #selector(increment)
    rootView.checkbox.target = self
    rootView.checkbox.action = #selector(checkboxChanged)
    rootView.textField.delegate = self
    rootView.slider.target = self
    rootView.slider.action = #selector(sliderChanged)
    rootView.rightClickView.onRightClick = { [weak self] in
      guard let self else { return }
      self.rightClicks += 1
      self.markMutation()
    }
    rootView.draggableView.onMove = { [weak self] _ in
      guard let self else { return }
      self.dragMoveEvents += 1
      self.markMutation()
    }
    rootView.draggableView.onComplete = { [weak self] in
      guard let self else { return }
      self.dragCompletions += 1
      self.markMutation()
    }

    rootView.scrollView.contentView.postsBoundsChangedNotifications = true
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(scrollBoundsChanged),
      name: NSView.boundsDidChangeNotification,
      object: rootView.scrollView.contentView
    )
    for name in [
      NSWindow.didMoveNotification,
      NSWindow.didResizeNotification,
      NSWindow.didBecomeKeyNotification,
      NSWindow.didResignKeyNotification,
      NSWindow.didBecomeMainNotification,
      NSWindow.didResignMainNotification,
    ] {
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(windowStateChanged),
        name: name,
        object: window
      )
    }
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  @objc private func increment() {
    buttonClicks += 1
    markMutation()
  }

  @objc private func checkboxChanged() {
    checkboxChanges += 1
    markMutation()
  }

  @objc private func sliderChanged() {
    rootView.sliderValueLabel.stringValue = String(format: "%.0f", rootView.slider.doubleValue)
    sliderChanges += 1
    markMutation()
  }

  @objc private func scrollBoundsChanged() {
    scrollEvents += 1
    markMutation()
  }

  @objc private func windowStateChanged() {
    markMutation()
  }

  func controlTextDidChange(_ notification: Notification) {
    textChanges += 1
    markMutation()
  }

  private func markMutation() {
    if !suppressMutation {
      revision &+= 1
    }
  }

  func show() -> [String: Any] {
    window.orderFrontRegardless()
    markMutation()
    return snapshot()
  }

  func hide() -> [String: Any] {
    window.orderOut(nil)
    markMutation()
    return snapshot()
  }

  func reset() -> [String: Any] {
    suppressMutation = true
    rootView.checkbox.state = .off
    rootView.textField.stringValue = ""
    rootView.slider.doubleValue = defaultSliderValue
    rootView.sliderValueLabel.stringValue = String(format: "%.0f", defaultSliderValue)
    rootView.scrollView.contentView.scroll(to: .zero)
    rootView.scrollView.reflectScrolledClipView(rootView.scrollView.contentView)
    rootView.rightClickView.reset()
    rootView.resetDragPosition()
    buttonClicks = 0
    checkboxChanges = 0
    textChanges = 0
    sliderChanges = 0
    scrollEvents = 0
    rightClicks = 0
    dragCompletions = 0
    dragMoveEvents = 0
    suppressMutation = false
    markMutation()
    return snapshot()
  }

  func setFrame(_ params: [String: Any]) throws -> [String: Any] {
    func number(_ key: String) throws -> Double {
      guard let value = params[key] as? NSNumber else {
        throw FixtureError.invalidParams("setFrame requires numeric \(key)")
      }
      return value.doubleValue
    }
    let quartzFrame = CGRect(
      x: try number("x"),
      y: try number("y"),
      width: try number("width"),
      height: try number("height")
    )
    guard quartzFrame.width >= 420, quartzFrame.height >= 280 else {
      throw FixtureError.invalidParams("setFrame requires width >= 420 and height >= 280")
    }
    window.setFrame(appKitRect(fromQuartzRect: quartzFrame), display: true)
    rootView.layoutSubtreeIfNeeded()
    markMutation()
    return snapshot()
  }

  func snapshot() -> [String: Any] {
    rootView.layoutSubtreeIfNeeded()
    let views: [(String, NSView)] = [
      ("button", rootView.incrementButton),
      ("checkbox", rootView.checkbox),
      ("textField", rootView.textField),
      ("slider", rootView.slider),
      ("scrollView", rootView.scrollView),
      ("rightClickView", rootView.rightClickView),
      ("dragArena", rootView.dragArena),
      ("dragView", rootView.draggableView),
    ]
    var elements: [String: Any] = [:]
    for (name, view) in views {
      if let rect = quartzRect(for: view) {
        elements[name] = ["quartzTopLeftRect": rectDictionary(rect)]
      }
    }

    return [
      "revision": NSNumber(value: revision),
      "pid": ProcessInfo.processInfo.processIdentifier,
      "activationPolicy": activationPolicyName(NSApp.activationPolicy()),
      "window": [
        "number": window.windowNumber,
        "visible": window.isVisible,
        "key": window.isKeyWindow,
        "main": window.isMainWindow,
        "active": NSApp.isActive,
        "quartzTopLeftRect": rectDictionary(quartzWindowRect(window)),
      ],
      "controls": [
        "buttonClicks": buttonClicks,
        "checkboxChecked": rootView.checkbox.state == .on,
        "checkboxChanges": checkboxChanges,
        "text": rootView.textField.stringValue,
        "textChanges": textChanges,
        "sliderValue": rootView.slider.doubleValue,
        "sliderChanges": sliderChanges,
        "scrollOffsetY": rootView.scrollView.contentView.bounds.origin.y,
        "scrollEvents": scrollEvents,
        "rightClicks": rightClicks,
        "dragCompletions": dragCompletions,
        "dragMoveEvents": dragMoveEvents,
        "dragPosition": [
          "x": rootView.draggableView.frame.minX,
          "y": rootView.draggableView.frame.minY,
        ],
      ],
      "elements": elements,
    ]
  }
}

private enum FixtureError: Error, CustomStringConvertible {
  case invalidParams(String)
  case unknownMethod(String)

  var description: String {
    switch self {
    case .invalidParams(let message): return message
    case .unknownMethod(let method): return "unknown method: \(method)"
    }
  }
}

private final class NDJSONSocketServer {
  private let socketPath: String
  private let controller: FixtureController
  private let acceptQueue = DispatchQueue(label: "com.maka.fixture.cu-appkit.accept")
  private let clientQueue = DispatchQueue(
    label: "com.maka.fixture.cu-appkit.clients",
    attributes: .concurrent
  )
  private var listener: Int32 = -1
  private var source: DispatchSourceRead?

  init(socketPath: String, controller: FixtureController) {
    self.socketPath = socketPath
    self.controller = controller
  }

  func start() throws {
    guard socketPath.utf8.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path) else {
      throw FixtureError.invalidParams("Unix socket path is too long: \(socketPath)")
    }
    unlink(socketPath)

    listener = socket(AF_UNIX, SOCK_STREAM, 0)
    guard listener >= 0 else {
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    fcntl(listener, F_SETFL, O_NONBLOCK)

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { destination in
      socketPath.withCString { source in
        destination.copyBytes(from: UnsafeRawBufferPointer(
          start: source,
          count: socketPath.utf8.count + 1
        ))
      }
    }
    let bindResult = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard bindResult == 0 else {
      let error = POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
      close(listener)
      listener = -1
      throw error
    }
    guard Darwin.listen(listener, 16) == 0 else {
      let error = POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
      close(listener)
      listener = -1
      throw error
    }

    let source = DispatchSource.makeReadSource(fileDescriptor: listener, queue: acceptQueue)
    source.setEventHandler { [weak self] in self?.acceptClients() }
    source.setCancelHandler { [weak self] in
      guard let self else { return }
      if self.listener >= 0 {
        close(self.listener)
        self.listener = -1
      }
    }
    self.source = source
    source.resume()
  }

  func stop() {
    source?.cancel()
    source = nil
    unlink(socketPath)
  }

  private func acceptClients() {
    while listener >= 0 {
      let client = Darwin.accept(listener, nil, nil)
      if client < 0 {
        if errno == EAGAIN || errno == EWOULDBLOCK { break }
        return
      }
      let flags = fcntl(client, F_GETFL)
      if flags >= 0 {
        // Accepted sockets inherit O_NONBLOCK on macOS; client workers use blocking reads.
        fcntl(client, F_SETFL, flags & ~O_NONBLOCK)
      }
      clientQueue.async { [weak self] in
        self?.serve(client)
      }
    }
  }

  private func serve(_ client: Int32) {
    defer { close(client) }
    var buffer = Data()
    var bytes = [UInt8](repeating: 0, count: 8192)

    while true {
      let count = Darwin.read(client, &bytes, bytes.count)
      if count == 0 { return }
      if count < 0 {
        if errno == EINTR { continue }
        return
      }
      buffer.append(bytes, count: count)
      if buffer.count > 1_048_576 {
        writeResponse(["ok": false, "error": "request exceeded 1 MiB"], to: client)
        return
      }

      while let newline = buffer.firstIndex(of: 0x0A) {
        let line = Data(buffer[..<newline])
        buffer.removeSubrange(...newline)
        guard !line.isEmpty else { continue }
        let shouldShutdown = process(line, client: client)
        if shouldShutdown { return }
      }
    }
  }

  private func process(_ line: Data, client: Int32) -> Bool {
    var requestID: Any = NSNull()
    do {
      guard
        let object = try JSONSerialization.jsonObject(with: line) as? [String: Any],
        let method = object["method"] as? String
      else {
        throw FixtureError.invalidParams("request must be an object with a string method")
      }
      requestID = object["id"] ?? NSNull()
      let params = object["params"] as? [String: Any] ?? [:]
      var shouldShutdown = false
      let result: [String: Any] = try DispatchQueue.main.sync {
        switch method {
        case "show": return controller.show()
        case "hide": return controller.hide()
        case "reset": return controller.reset()
        case "snapshot": return controller.snapshot()
        case "setFrame": return try controller.setFrame(params)
        case "shutdown":
          shouldShutdown = true
          return controller.snapshot()
        default:
          throw FixtureError.unknownMethod(method)
        }
      }
      writeResponse(["id": requestID, "ok": true, "result": result], to: client)
      if shouldShutdown {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
          NSApp.terminate(nil)
        }
      }
      return shouldShutdown
    } catch {
      writeResponse(
        ["id": requestID, "ok": false, "error": String(describing: error)],
        to: client
      )
      return false
    }
  }

  private func writeResponse(_ object: [String: Any], to client: Int32) {
    guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
    data.append(0x0A)
    data.withUnsafeBytes { rawBuffer in
      guard var pointer = rawBuffer.baseAddress else { return }
      var remaining = rawBuffer.count
      while remaining > 0 {
        let written = Darwin.write(client, pointer, remaining)
        if written < 0 {
          if errno == EINTR { continue }
          return
        }
        remaining -= written
        pointer = pointer.advanced(by: written)
      }
    }
  }
}

private final class FixtureAppDelegate: NSObject, NSApplicationDelegate {
  private let socketPath: String
  private var controller: FixtureController?
  private var server: NDJSONSocketServer?

  init(socketPath: String) {
    self.socketPath = socketPath
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    let controller = FixtureController()
    let server = NDJSONSocketServer(socketPath: socketPath, controller: controller)
    do {
      try server.start()
      self.controller = controller
      self.server = server
      FileHandle.standardOutput.write(Data("READY\t\(socketPath)\n".utf8))
    } catch {
      FileHandle.standardError.write(Data("fixture socket startup failed: \(error)\n".utf8))
      NSApp.terminate(nil)
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    false
  }

  func applicationWillTerminate(_ notification: Notification) {
    server?.stop()
  }
}

private func socketPathFromArguments() -> String {
  let arguments = CommandLine.arguments
  if let index = arguments.firstIndex(of: "--socket"), arguments.indices.contains(index + 1) {
    return arguments[index + 1]
  }
  if let value = ProcessInfo.processInfo.environment["MAKA_CU_APPKIT_SOCKET"], !value.isEmpty {
    return value
  }
  return "/tmp/mcu-\(ProcessInfo.processInfo.processIdentifier).sock"
}

let app = NSApplication.shared
signal(SIGPIPE, SIG_IGN)
app.setActivationPolicy(.accessory)
private let delegate = FixtureAppDelegate(socketPath: socketPathFromArguments())
app.delegate = delegate
app.run()
