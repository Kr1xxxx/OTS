// Temporary experiment (removed before merge): does NSApp.terminate quit while a sheet is attached?
import Cocoa

let mode = CommandLine.arguments.dropFirst().first ?? "sheet"

final class Delegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var panel: NSPanel?
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 600, height: 400), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if mode != "nosheet" {
            let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 340, height: 62), styleMask: [.titled], backing: .buffered, defer: false)
            window.beginSheet(panel)
            self.panel = panel
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            Task { @MainActor in
                if mode == "endsheet", let panel = self.panel { self.window.endSheet(panel) }
                print("calling terminate (mode \(mode), attachedSheet \(self.window.attachedSheet != nil))")
                NSApp.terminate(nil)
                print("terminate returned")
            }
        }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        print("applicationShouldTerminate")
        return .terminateNow
    }
    func applicationWillTerminate(_ notification: Notification) { print("applicationWillTerminate") }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Delegate()
app.delegate = delegate
setvbuf(stdout, nil, _IONBF, 0)
app.run()
