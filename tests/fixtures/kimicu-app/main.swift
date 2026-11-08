import AppKit
class Delegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var label: NSTextField!
    var actionCount = 0
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 220), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "OpenDot Kimi Fixture"
        window.center()
        label = NSTextField(labelWithString: "Fixture ready")
        label.frame = NSRect(x: 35, y: 120, width: 300, height: 30)
        let button = NSButton(title: "Run fixture action", target: self, action: #selector(pressed))
        button.frame = NSRect(x: 35, y: 65, width: 200, height: 32)
        window.contentView?.addSubview(label)
        window.contentView?.addSubview(button)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    @objc func pressed() {
        actionCount += 1
        label.stringValue = "Fixture action complete \(actionCount)"
    }
}
let app=NSApplication.shared
let delegate=Delegate()
app.delegate=delegate
app.setActivationPolicy(.regular)
app.run()
