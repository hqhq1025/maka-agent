/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
final class Counter: NSObject {
    var value = 0
    let label = NSTextField(labelWithString: "0")
    let field = NSTextField(string: "")
    @objc func increment() {
        value += 1
        label.stringValue = String(value)
        print("COUNT \(value)")
        fflush(stdout)
    }
}
// Only AXPress is advertised: Driver double_click must reach mouseDown through
// its element-token pointer route rather than treating two AXPress calls as open.
final class DoubleClickTarget: NSView {
    var semanticPresses = 0
    var mouseClickCounts: [Int] = []
    var doubleClicks = 0
    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .button }
    override func accessibilityLabel() -> String? { "Double-click target" }
    override func accessibilityActionNames() -> [NSAccessibility.Action] { [.press] }
    override func accessibilityPerformPress() -> Bool {
        semanticPresses += 1
        return true
    }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {
        mouseClickCounts.append(event.clickCount)
        if event.clickCount == 2 { doubleClicks += 1 }
        needsDisplay = true
    }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.controlColor.setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 5, yRadius: 5).fill()
        let text = "Double-click: \(doubleClicks)" as NSString
        text.draw(at: NSPoint(x: 8, y: 12), withAttributes: [.font: NSFont.systemFont(ofSize: 12)])
    }
    func readback() {
        let state: [String: Any] = [
            "semanticPresses": semanticPresses,
            "mouseClickCounts": mouseClickCounts,
            "doubleClicks": doubleClicks,
        ]
        let data = try! JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
        print("GESTURE \(String(data: data, encoding: .utf8)!)")
        fflush(stdout)
    }
}
let counter = Counter()
let doubleClickTarget = DoubleClickTarget(frame: NSRect(x: 170, y: 90, width: 120, height: 40))
let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 320, height: 180), styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "Maka Cua Spike Counter"
let button = NSButton(title: "Increment", target: counter, action: #selector(Counter.increment))
button.frame = NSRect(x: 30, y: 80, width: 120, height: 40)
counter.label.frame = NSRect(x: 30, y: 30, width: 120, height: 30)
counter.label.setAccessibilityLabel("Count")
counter.field.frame = NSRect(x: 170, y: 35, width: 120, height: 30)
counter.field.setAccessibilityLabel("Message")
window.contentView!.addSubview(button)
window.contentView!.addSubview(counter.label)
window.contentView!.addSubview(counter.field)
window.contentView!.addSubview(doubleClickTarget)
window.orderFrontRegardless()
DispatchQueue.main.async {
    print("READY \(ProcessInfo.processInfo.processIdentifier)")
    fflush(stdout)
}
DispatchQueue.global().async {
    while let line = readLine() {
        if line == "quit" { DispatchQueue.main.async { app.terminate(nil) }; return }
        if line == "read" { DispatchQueue.main.async { print("READ \(counter.value)"); fflush(stdout) } }
        if line == "text" { DispatchQueue.main.async { print("TEXT \(counter.field.stringValue)"); fflush(stdout) } }
        if line == "gesture" { DispatchQueue.main.async { doubleClickTarget.readback() } }
    }
    DispatchQueue.main.async { app.terminate(nil) }
}
DispatchQueue.main.asyncAfter(deadline: .now() + 45) { app.terminate(nil) }
app.run()
