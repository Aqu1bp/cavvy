// A bare WKWebView window (the engine Tauri uses on macOS) that loads a page, runs a script in it,
// and prints what the script's promise resolves to. Used by webkit-perf.ts; Safari's WebDriver
// needs "Allow remote automation", which this doesn't.
//
//   swiftc -O webkit-host.swift -o /tmp/webkit-host && /tmp/webkit-host <url> <script.js> [width] [height]
//
// The script is evaluated as an async function body (`return await …`) once the page has loaded
// and settled for 3s. The window stays above others while it runs, so it isn't occluded (WebKit
// throttles occluded pages' frames), and it never takes focus.
import AppKit
import WebKit

let args = CommandLine.arguments
guard args.count >= 3, let url = URL(string: args[1]), let script = try? String(contentsOfFile: args[2], encoding: .utf8) else {
    FileHandle.standardError.write("usage: webkit-host <url> <script.js> [width] [height]\n".data(using: .utf8)!)
    exit(2)
}
let width = args.count > 3 ? Double(args[3]) ?? 1512 : 1512
let height = args.count > 4 ? Double(args[4]) ?? 982 : 982

/** CPU seconds a process has used so far (ps's cputime), or -1. */
func cpuSeconds(_ pid: Int) -> Double {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/ps")
    p.arguments = ["-o", "cputime=", "-p", String(pid)]
    let out = Pipe()
    p.standardOutput = out
    try? p.run()
    p.waitUntilExit()
    let text = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    // [[hh:]mm:]ss.cc
    var total = 0.0
    for part in text.split(separator: ":") { total = total * 60 + (Double(part) ?? 0) }
    return text.isEmpty ? -1 : total
}

final class Host: NSObject, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
    var pids: [String: Int] = [:]

    /** `window.webkit.messageHandlers.cpu.postMessage(label)`: the page's processes' CPU seconds so far, by name. */
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        replyHandler(pids.mapValues { cpuSeconds($0) }, nil)
    }

    let window: NSWindow
    let view: WKWebView
    let script: String
    var ran = false

    init(url: URL, script: String) {
        self.script = script
        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        config.userContentController = controller
        view = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: config)
        window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: width, height: height), styleMask: [.titled], backing: .buffered, defer: false)
        super.init()
        controller.addScriptMessageHandler(self, contentWorld: .page, name: "cpu")
        // Keep frames coming even if something covers the window.
        let occlusion = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
        if view.responds(to: occlusion) {
            typealias Setter = @convention(c) (AnyObject, Selector, Bool) -> Void
            unsafeBitCast(view.method(for: occlusion), to: Setter.self)(view, occlusion, false)
        }
        view.navigationDelegate = self
        window.contentView = view
        window.level = .floating
        window.title = "Harness perf (WebKit)"
        window.orderFrontRegardless()
        view.load(URLRequest(url: url))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if ran { return }
        ran = true
        // The page's processes, for the page to ask their CPU time (window.webkit.messageHandlers.cpu).
        for key in ["_webProcessIdentifier", "_gpuProcessIdentifier"] where webView.responds(to: NSSelectorFromString(key)) {
            if let pid = webView.value(forKey: key) as? Int, pid > 0 { pids[key == "_gpuProcessIdentifier" ? "gpu" : "web"] = pid }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            webView.callAsyncJavaScript(self.script, arguments: [:], in: nil, in: .page) { result in
                switch result {
                case .success(let value):
                    if let s = value as? String { print(s) } else { print(String(describing: value)) }
                    exit(0)
                case .failure(let error):
                    FileHandle.standardError.write("script failed: \(error)\n".data(using: .utf8)!)
                    exit(1)
                }
            }
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let host = Host(url: url, script: script)
// A hard stop, should the page never finish.
DispatchQueue.main.asyncAfter(deadline: .now() + 900) {
    FileHandle.standardError.write("timed out\n".data(using: .utf8)!)
    exit(3)
}
app.run()
