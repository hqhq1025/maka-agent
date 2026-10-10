# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

import gi
import json
import os
import sys
import threading

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib, Gdk

window = Gtk.Window(title="Maka Cua Spike Counter")
window.set_default_size(380, 230)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
box.set_border_width(12)
window.add(box)
count = 0
label = Gtk.Label(label="Count = 0")
label.get_accessible().set_name("Count")
entry = Gtk.Entry()
entry.get_accessible().set_name("Message")
button = Gtk.Button(label="Increment")
double_target = Gtk.Button(label="Double-click target")
gesture = {"doubleClicks": 0, "physicalPresses": 0}

def clicked(_):
    global count
    count += 1
    label.set_text("Count = " + str(count))

def gesture_press(_, event):
    if event.type == Gdk.EventType.BUTTON_PRESS:
        gesture["physicalPresses"] += 1
    elif event.type == Gdk.EventType._2BUTTON_PRESS:
        gesture["doubleClicks"] += 1
    return False

button.connect("clicked", clicked)
double_target.connect("button-press-event", gesture_press)
for widget in [label, entry, button, double_target]:
    box.pack_start(widget, False, False, 0)
window.connect("destroy", Gtk.main_quit)
window.show_all()

def command(line):
    if line == "read":
        print("READ " + str(count), flush=True)
    elif line == "text":
        print("TEXT " + entry.get_text(), flush=True)
    elif line == "gesture":
        print("GESTURE " + json.dumps(gesture), flush=True)
    elif line == "quit":
        Gtk.main_quit()
    return False

def input_loop():
    for line in sys.stdin:
        GLib.idle_add(command, line.strip())
    GLib.idle_add(Gtk.main_quit())

threading.Thread(target=input_loop, daemon=True).start()
GLib.idle_add(lambda: print("READY " + str(os.getpid()), flush=True))
GLib.timeout_add_seconds(190, lambda: Gtk.main_quit())
Gtk.main()
