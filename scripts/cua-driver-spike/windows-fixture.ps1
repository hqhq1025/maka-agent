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

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Maka Cua Driver Fixture'
$form.Width = 360
$form.Height = 290
$label = New-Object System.Windows.Forms.Label
$label.Text = 'Count = 0'
$label.SetBounds(20, 20, 300, 25)
$entry = New-Object System.Windows.Forms.TextBox
$entry.AccessibleName = 'Message'
$entry.SetBounds(20, 55, 300, 25)
$button = New-Object System.Windows.Forms.Button
$button.Text = 'Increment'
$button.SetBounds(20, 90, 120, 32)
$script:count = 0
$button.Add_Click({ $script:count++; $label.Text = "Count = $script:count" })
Add-Type -ReferencedAssemblies @('System.Windows.Forms', 'System.Drawing', 'System.Core') -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Windows.Forms;
public sealed class GestureButton : Button {
    public int DoubleClicks;
    public int PhysicalPresses;
    public int Activations;
    public readonly List<int> ClickCounts = new List<int>();
    public GestureButton() {
        SetStyle(ControlStyles.StandardClick | ControlStyles.StandardDoubleClick, true);
    }
    protected override void OnClick(EventArgs e) { Activations++; base.OnClick(e); }
    protected override void OnMouseDown(MouseEventArgs e) {
        PhysicalPresses++; ClickCounts.Add(e.Clicks); base.OnMouseDown(e);
    }
    protected override void OnDoubleClick(EventArgs e) { DoubleClicks++; base.OnDoubleClick(e); }
}
public static class FixtureInput {
    public static ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();
    public static volatile bool Ended;
    public static void Start() { Task.Run(() => {
        string line;
        while ((line = Console.ReadLine()) != null) Lines.Enqueue(line);
        Ended = true;
    }); }
}
'@
$gesture = New-Object GestureButton
$gesture.Text = 'Double-click target'
$gesture.AccessibleName = 'Double-click target'
$gesture.SetBounds(20, 140, 220, 50)
$form.Controls.AddRange(@($label, $entry, $button, $gesture))
[FixtureInput]::Start()
$started = [DateTime]::UtcNow
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 50
$timer.Add_Tick({
    if (([DateTime]::UtcNow - $started).TotalSeconds -gt 45) { $form.Close(); return }
    $command = ''
    if (![FixtureInput]::Lines.TryDequeue([ref] $command)) {
        if ([FixtureInput]::Ended) { $form.Close() }
        return
    }
    if ($command -eq 'quit') { $form.Close(); return }
    if ($command -eq 'read') {
        $state = @{
            count = $script:count; text = $entry.Text
            gesture = @{ doubleClicks = $gesture.DoubleClicks; physicalPresses = $gesture.PhysicalPresses; activations = $gesture.Activations }
            clickCounts = @($gesture.ClickCounts.ToArray())
            sessionId = (Get-Process -Id $PID).SessionId
        } | ConvertTo-Json -Compress -Depth 4
        [Console]::WriteLine("STATE $state")
    }
})
$form.Add_Shown({ [Console]::WriteLine('READY'); $timer.Start() })
try { [System.Windows.Forms.Application]::Run($form) } finally { $timer.Dispose(); $form.Dispose() }
