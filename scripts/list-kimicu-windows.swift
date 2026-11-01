import AppKit
import CoreGraphics
import Foundation

// Only window metadata is returned; no accessibility tree or pixels are read.
let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
var result: [[String: Any]] = []
for entry in entries {
    guard let pid = entry[kCGWindowOwnerPID as String] as? Int,
          let id = entry[kCGWindowNumber as String] as? Int,
          let layer = entry[kCGWindowLayer as String] as? Int, layer == 0,
          let app = NSRunningApplication(processIdentifier: pid_t(pid)),
          let bundle = app.bundleIdentifier, !bundle.isEmpty else { continue }
    let name = app.localizedName ?? bundle
    let title = entry[kCGWindowName as String] as? String ?? ""
    result.append(["appId": bundle, "pid": pid, "windowId": id,
                   "appName": String(name.prefix(200)), "title": String(title.prefix(200))])
    if result.count >= 150 { break }
}
let data = try JSONSerialization.data(withJSONObject: result)
FileHandle.standardOutput.write(data)
