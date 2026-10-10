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
let window = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 320, height: 180),
                      styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "Maka Owned Window Identity Fixture"
window.isReleasedWhenClosed = false
window.contentView?.addSubview(NSTextField(labelWithString: "Read-only window identity validation"))
window.orderFrontRegardless()
DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
    print("READY \(ProcessInfo.processInfo.processIdentifier) \(window.windowNumber)")
    fflush(stdout)
}
DispatchQueue.global().async {
    while let line = readLine() {
        if line == "close" {
            DispatchQueue.main.async {
                window.close()
                print("CLOSED")
                fflush(stdout)
            }
        }
        if line == "quit" { DispatchQueue.main.async { app.terminate(nil) } }
    }
    DispatchQueue.main.async { app.terminate(nil) }
}
app.run()
