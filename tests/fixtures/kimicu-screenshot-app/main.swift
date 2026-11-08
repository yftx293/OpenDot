import AppKit

// Two partially overlapping synthetic windows in one process. Their solid
// colours reveal capture of another window without using user content.
class ColorView: NSView {
    let color: NSColor
    init(color: NSColor, frame: NSRect) { self.color = color; super.init(frame: frame) }
    required init?(coder: NSCoder) { fatalError("unsupported") }
    override var isOpaque: Bool { true }
    override func draw(_ dirtyRect: NSRect) { color.setFill(); dirtyRect.fill() }
}
class Delegate: NSObject, NSApplicationDelegate {
    var windows: [NSWindow] = []
    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let screen = NSScreen.main else { NSApp.terminate(nil); return }
        let frame = screen.visibleFrame
        let width = min(320, frame.width / 3), height = min(220, frame.height / 3)
        for (index, name, color) in [(0, "OpenDot Green Fixture", NSColor.green), (1, "OpenDot Red Fixture", NSColor.red)] {
            let rect = NSRect(x: frame.minX + 30 + CGFloat(index) * (width * 0.7), y: frame.midY, width: width, height: height)
            let window = NSWindow(contentRect: rect, styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = name
            let view = ColorView(color: color, frame: NSRect(x: 0, y: 0, width: width, height: height))
            let label = NSTextField(labelWithString: name)
            label.frame = NSRect(x: 20, y: 20, width: width - 40, height: 24)
            view.addSubview(label)
            let button = NSButton(title: "Run synthetic action", target: self, action: #selector(runSyntheticAction(_:)))
            button.frame = NSRect(x: 20, y: 55, width: 180, height: 28)
            view.addSubview(button)
            window.contentView = view
            window.orderFrontRegardless()
            windows.append(window)
        }
        if let output = ProcessInfo.processInfo.environment["OPENDOT_COLOR_FIXTURE_OUTPUT"], windows.count == 2 {
            let payload: [String: Int] = ["pid": Int(ProcessInfo.processInfo.processIdentifier), "green": windows[0].windowNumber, "red": windows[1].windowNumber]
            if let data = try? JSONSerialization.data(withJSONObject: payload) {
                try? data.write(to: URL(fileURLWithPath: output), options: .atomic)
            }
        }
        NSApp.activate(ignoringOtherApps: true)
    }
    @objc func runSyntheticAction(_ sender: NSButton) {
        sender.title = "Synthetic action complete"
    }
}
let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
